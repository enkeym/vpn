import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PeersService } from '../peers/peers.service';
import { BotService } from '../bot/bot.service';
import { SubscriptionDuration } from '../peers/dto/create-peer.dto';
import { isDiscountEligibleDuration, isPaidDuration } from './pricing';
import { AutopayService } from './autopay.service';
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
    @Inject(forwardRef(() => AutopayService))
    private readonly autopayService: AutopayService,
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
      let deliveredPeerName: string;

      if (peerName) {
        const peer = await this.peersService.extendPeerExpiration(
          peerName,
          durationDays,
        );
        const config = await this.peersService.getPeerConfigString(peerName);
        deliveredPeerName = peer.name;

        if (isPromo && isDiscountEligibleDuration(durationDays)) {
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
        });
        deliveredPeerName = peer.name;

        if (isPromo && isDiscountEligibleDuration(durationDays)) {
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

      await this.captureAutopayMethod(payment, deliveredPeerName);
    } catch (error) {
      this.logger.error(`Ошибка выдачи после оплаты ${yookassaId}`, error);
    }
  }

  /**
   * После оплаты забираем из ЮKassa сохранённый метод оплаты. Если карта
   * сохранена и автопродление ещё выключено — предлагаем включить его.
   * Само списание без явного согласия пользователя не включается никогда.
   */
  private async captureAutopayMethod(
    payment: PaymentRow,
    peerName: string,
  ): Promise<void> {
    try {
      const durationDays = payment.durationDays;
      if (!isPaidDuration(durationDays)) return;

      const view = await this.paymentService.getYooKassaPayment(
        payment.yookassaId,
      );
      if (!view?.savedPaymentMethodId) return;

      await this.paymentService.setPaymentMethodId(
        payment.yookassaId,
        view.savedPaymentMethodId,
      );

      const stateBefore = await this.autopayService.getState(
        payment.telegramId,
      );

      await this.autopayService.rememberPaymentMethod({
        telegramId: payment.telegramId,
        paymentMethodId: view.savedPaymentMethodId,
        paymentMethodTitle: view.paymentMethodTitle,
        durationDays,
        peerName,
      });

      // Автосписание уже включено — просто сдвигаем дату следующего списания
      if (stateBefore?.enabled) {
        await this.autopayService.enable(payment.telegramId, {
          durationDays,
          peerName,
        });
        return;
      }

      // Платёж пришёл от самого автосписания — предлагать нечего
      if (payment.isAutoCharge) return;

      await this.botService.sendAutopayOffer(
        payment.telegramId,
        peerName,
        durationDays,
        view.paymentMethodTitle,
      );
    } catch (error) {
      this.logger.warn(
        `Не удалось обработать метод оплаты для автопродления (${payment.yookassaId}): ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
