import {
  Body,
  Controller,
  Post,
  Logger,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentFulfillmentService } from './payment-fulfillment.service';
import { InternalGuard } from '../common/guards/internal.guard';
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
    private readonly paymentFulfillment: PaymentFulfillmentService,
  ) {}

  /**
   * req.ip уже развёрнут Express'ом с учётом `trust proxy` (число доверенных
   * хопов): при одном nginx это реальный адрес клиента, и подделать его через
   * X-Forwarded-For нельзя. Читать заголовок вручную здесь нельзя — это и была
   * дыра, обходившая IP-allow-list вебхука.
   */
  private getClientIp(req: Request): string {
    return (req.ip || req.socket?.remoteAddress || '').trim();
  }

  private isIpAllowed(ip: string): boolean {
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

  private parseYooKassaWebhookBody(body: Record<string, unknown>): {
    event: string;
    yookassaId: string;
  } {
    const event = body.event;
    const obj = body.object;
    if (typeof event !== 'string' || !obj || typeof obj !== 'object') {
      throw new BadRequestException('Invalid webhook body');
    }
    const id = (obj as Record<string, unknown>).id;
    if (typeof id !== 'string') {
      throw new BadRequestException('Invalid webhook object.id');
    }
    return { event, yookassaId: id };
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const ip = this.getClientIp(req);
    const xff = req.headers['x-forwarded-for'];
    const rawSocket = req.socket?.remoteAddress;

    if (!this.isIpAllowed(ip)) {
      this.logger.warn(
        `Вебхук отклонён по IP: проверка=${ip} x-forwarded-for=${String(xff)} socket=${rawSocket ?? ''}`,
      );
      throw new ForbiddenException('Unauthorized IP');
    }

    this.logger.log(`Вебхук ЮKassa (сырое тело): ${JSON.stringify(body)}`);

    const { event, yookassaId } = this.parseYooKassaWebhookBody(body);
    this.logger.log(
      `Received webhook from YuKassa: ${event}, payment ${yookassaId}`,
    );

    if (event === 'payment.succeeded') {
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
      if (!payment) {
        this.logger.warn(
          `Webhook payment.succeeded: no local row for YooKassa id ${yookassaId}`,
        );
      } else {
        await this.paymentFulfillment.fulfillFromWebhookVerifiedPayment(
          yookassaId,
        );
      }
    } else if (event === 'payment.canceled') {
      // Перепроверяем статус в API: поддельный/поздний webhook не должен слепо
      // отменять платёж. И не трогаем уже succeeded — иначе поздний canceled
      // после выдачи конфига испортил бы состояние (ломает sync/автопродление).
      const yookassaStatus =
        await this.paymentService.getPaymentStatusFromYooKassa(yookassaId);
      if (yookassaStatus === 'canceled' || yookassaStatus === 'cancelled') {
        await this.paymentService.markCanceledIfNotSucceeded(yookassaId);
      } else {
        this.logger.warn(
          `Webhook payment.canceled ignored: status in YooKassa is "${yookassaStatus ?? 'unknown'}", not canceled`,
        );
      }
    }

    return { status: 'ok' };
  }

  /**
   * Только при TEST_PAYMENT=true: имитация успешной оплаты без вебхука ЮKassa.
   * Защита эшелонирована: (1) в production маршрут недоступен вообще — даже при
   * случайно включённом TEST_PAYMENT; (2) InternalGuard — localhost или X-Internal-Key;
   * (3) рантайм-флаг isTestPayment.
   */
  @Post('test/complete-succeeded')
  @HttpCode(HttpStatus.OK)
  @UseGuards(InternalGuard)
  async completeSucceededForTest(@Body() body: Record<string, unknown>) {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    if (!(await this.paymentService.isTestPayment())) {
      throw new NotFoundException();
    }

    const yookassaId = body.yookassaId;
    if (typeof yookassaId !== 'string' || yookassaId.length === 0) {
      throw new BadRequestException('yookassaId (string) required');
    }

    const payment =
      await this.paymentService.getPaymentByYookassaId(yookassaId);
    if (!payment) {
      throw new BadRequestException('payment not found in DB');
    }
    if (payment.status === 'succeeded') {
      return { ok: true, message: 'already processed' };
    }

    this.logger.warn(
      `TEST_PAYMENT: manual POST /payment/test/complete-succeeded for ${yookassaId}`,
    );
    await this.paymentFulfillment.fulfillFromWebhookVerifiedPayment(yookassaId);
    return { ok: true };
  }
}
