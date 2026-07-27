import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PeersService } from '../peers/peers.service';
import { BotService } from '../bot/bot.service';
import { SubscriptionDuration } from '../peers/dto/create-peer.dto';
import { payments } from '../database/schema';

type PaymentRow = typeof payments.$inferSelect;

export type FulfillPaymentResult =
  | 'fulfilled'
  | 'already_done'
  | 'not_found'
  | 'not_succeeded_in_yookassa'
  | 'wrong_user';

@Injectable()
export class PaymentFulfillmentService {
  private readonly logger = new Logger(PaymentFulfillmentService.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly peersService: PeersService,
    @Inject(forwardRef(() => BotService))
    private readonly botService: BotService,
  ) {}

  private invoiceUiFromPayment(
    payment: PaymentRow,
  ): { chatId: string; messageId: number } | undefined {
    if (payment.invoiceChatId == null || payment.invoiceMessageId == null) {
      return undefined;
    }
    return {
      chatId: payment.invoiceChatId,
      messageId: payment.invoiceMessageId,
    };
  }

  /**
   * Вебхук уже проверил статус в API ЮKassa. Атомарно помечаем succeeded и выдаём сервис
   * (или noop, если строка уже обработана — защита от дублей вебхука).
   */
  async fulfillFromWebhookVerifiedPayment(yookassaId: string): Promise<void> {
    const claimed =
      await this.paymentService.tryClaimPaymentSucceeded(yookassaId);
    if (!claimed) return;
    this.logger.log(
      `Вебхук: платёж принят, выдаём конфиг — ${yookassaId}, user=${claimed.telegramId}`,
    );
    await this.deliverAfterClaim(claimed);
  }

  /**
   * Проверка статуса в ЮKassa + выдача (кнопка «Я оплатил» / синхронизация после оплаты).
   */
  async fulfillByYookassaId(
    yookassaId: string,
    telegramId: string,
    options: { trustYooKassaSucceeded: boolean },
  ): Promise<FulfillPaymentResult> {
    const payment =
      await this.paymentService.getPaymentByYookassaId(yookassaId);
    if (!payment) return 'not_found';
    if (payment.telegramId !== telegramId) {
      this.logger.warn(
        `Платёж ${yookassaId}: несовпадение telegram (${telegramId} vs ${payment.telegramId})`,
      );
      return 'wrong_user';
    }
    if (payment.status === 'succeeded') return 'already_done';

    if (!options.trustYooKassaSucceeded) {
      const st =
        await this.paymentService.getPaymentStatusFromYooKassa(yookassaId);
      if (st !== 'succeeded') return 'not_succeeded_in_yookassa';
    }

    const claimed =
      await this.paymentService.tryClaimPaymentSucceeded(yookassaId);
    if (!claimed) return 'already_done';

    await this.deliverAfterClaim(claimed);
    return 'fulfilled';
  }

  /** Незавершённые в БД платежи пользователя — опрос ЮKassa и выдача при succeeded */
  async syncUnsettledForTelegramUser(telegramId: string): Promise<number> {
    const rows =
      await this.paymentService.listRecentUnsettledPayments(telegramId);
    let n = 0;
    for (const row of rows) {
      const r = await this.fulfillByYookassaId(row.yookassaId, telegramId, {
        trustYooKassaSucceeded: false,
      });
      if (r === 'fulfilled') n++;
    }
    return n;
  }

  private async deliverAfterClaim(payment: PaymentRow): Promise<void> {
    const yookassaId = payment.yookassaId;
    const durationDays = payment.durationDays as SubscriptionDuration;
    const isPromo = payment.isPromo;
    const peerName = payment.peerName;

    try {
      if (peerName) {
        const peer = await this.peersService.extendPeerExpiration(
          peerName,
          durationDays,
        );
        const config = await this.peersService.getPeerConfigString(peerName);

        if (isPromo && (durationDays === 60 || durationDays === 90)) {
          await this.peersService.recordPromoUsage(
            payment.telegramId,
            durationDays,
          );
        }

        await this.botService.notifyExtendSuccess(
          payment.telegramId,
          config,
          peer,
          durationDays,
          payment.amount,
          this.invoiceUiFromPayment(payment),
        );
      } else {
        const { config, peer } = await this.peersService.createPeer({
          telegramId: payment.telegramId,
          durationDays,
          isTrial: false,
          // Протокол выбран пользователем до оплаты
          protocol: payment.protocol,
        });

        if (isPromo && (durationDays === 60 || durationDays === 90)) {
          await this.peersService.recordPromoUsage(
            payment.telegramId,
            durationDays,
          );
        }

        await this.botService.notifyPaymentSuccess(
          payment.telegramId,
          config,
          peer,
          durationDays,
          payment.amount,
          this.invoiceUiFromPayment(payment),
        );
      }
    } catch (error) {
      this.logger.error(`Ошибка выдачи после оплаты ${yookassaId}`, error);
    }
  }
}
