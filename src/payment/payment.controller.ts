import {
  Body,
  Controller,
  Post,
  Logger,
  HttpCode,
  HttpStatus,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PeersService } from '../peers/peers.service';
import { BotService } from '../bot/bot.service';
import { SubscriptionDuration } from '../peers/dto/create-peer.dto';
import { YooKassaWebhookDto } from './dto/webhook.dto';
import type { Request } from 'express';
import ipRangeCheck from 'ip-range-check';

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  private readonly allowedIps = [
    '185.71.76.0/27',
    '185.71.77.0/27',
    '77.75.153.0/25',
    '77.75.156.11',
    '77.75.156.35',
    '77.75.154.128/25',
    '2a02:5180::/32',
  ];

  constructor(
    private readonly paymentService: PaymentService,
    private readonly peersService: PeersService,
    private readonly botService: BotService,
  ) {}

  private isIpAllowed(ip: string): boolean {
    // В dev-режиме можно пропускать localhost
    if (
      process.env.NODE_ENV !== 'production' &&
      (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1')
    ) {
      return true;
    }

    try {
      return ipRangeCheck(ip, this.allowedIps);
    } catch (error) {
      this.logger.error(
        `Ошибка при проверке IP ${ip}: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() body: YooKassaWebhookDto, @Req() req: Request) {
    const ip = req.ip || '';

    if (!this.isIpAllowed(ip)) {
      this.logger.warn(`Rejected webhook from unauthorized IP`);
      throw new ForbiddenException('Unauthorized IP');
    }

    this.logger.log(`Received webhook from YuKassa: ${body.event}`);

    if (body.event === 'payment.succeeded') {
      const yookassaId = body.object.id;

      const yookassaStatus =
        await this.paymentService.getPaymentStatusFromYooKassa(yookassaId);
      if (yookassaStatus !== 'succeeded') {
        this.logger.warn(
          `Webhook payment.succeeded ignored: status in YooKassa is "${yookassaStatus ?? 'unknown'}", not succeeded`,
        );
        return { status: 'ok' };
      }

      const payment =
        await this.paymentService.getPaymentByYookassaId(yookassaId);

      if (payment && payment.status !== 'succeeded') {
        this.logger.log(
          `Payment ${yookassaId} succeeded. Providing service to user ${payment.telegramId}`,
        );

        await this.paymentService.updatePaymentStatus(yookassaId, 'succeeded');

        const durationDays = payment.durationDays as SubscriptionDuration;
        const isPromo = payment.isPromo;

        try {
          // Создаем конфиг для пользователя
          const { config, peer } = await this.peersService.createPeer({
            telegramId: payment.telegramId,
            durationDays,
            isTrial: false,
          });

          if (isPromo && (durationDays === 60 || durationDays === 90)) {
            await this.peersService.recordPromoUsage(
              payment.telegramId,
              durationDays,
            );
          }

          // Уведомляем пользователя через бота
          await this.botService.notifyPaymentSuccess(
            payment.telegramId,
            config,
            peer,
            durationDays,
            payment.amount,
          );
        } catch (error) {
          this.logger.error(
            `Error providing service after payment ${yookassaId}`,
            error,
          );
          // Здесь можно добавить логику ручного разбора ошибок
        }
      }
    } else if (body.event === 'payment.canceled') {
      await this.paymentService.updatePaymentStatus(body.object.id, 'canceled');
    }

    return { status: 'ok' };
  }
}
