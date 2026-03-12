import {
  Body,
  Controller,
  Post,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PeersService } from '../peers/peers.service';
import { BotService } from '../bot/bot.service';
import { SubscriptionDuration } from '../peers/dto/create-peer.dto';

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly peersService: PeersService,
    private readonly botService: BotService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() body: any) {
    this.logger.log(`Received webhook from YuKassa: ${body.event}`);

    if (body.event === 'payment.succeeded') {
      const paymentData = body.object;
      const yookassaId = paymentData.id;

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
      const paymentData = body.object;
      await this.paymentService.updatePaymentStatus(paymentData.id, 'canceled');
    }

    return { status: 'ok' };
  }
}
