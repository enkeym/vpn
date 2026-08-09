import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, InputFile, type Context } from 'grammy';
import { PeersService, TPeer } from 'src/peers/peers.service';
import {
  PaymentService,
  YOOKASSA_TELEGRAM_RETURN_START_PARAM,
} from 'src/payment/payment.service';
import {
  PaymentFulfillmentService,
  type FulfillPaymentResult,
} from 'src/payment/payment-fulfillment.service';
import { BotUi } from '../ui/bot.ui';
import { safeEditMessageText } from '../utils/safe-edit-message';
import { MainHandler } from '../handlers/main.handler';
import { MainMenuService } from '../menu/main-menu.service';
import { MainMenuAnchorStore } from '../menu/main-menu-anchor.store';

/**
 * Счета ЮKassa: презентация счёта, опрос статуса оплаты и уведомления
 * об успешной оплате/продлении (отправка конфига).
 */
@Injectable()
export class InvoiceService {
  private bot!: Bot;
  private readonly logger = new Logger(InvoiceService.name);

  /** Повторный опрос ЮKassa не чаще (мс), пока есть незавершённые платежи */
  private readonly unsettledPollThrottleByUser = new Map<string, number>();
  private static readonly UNSETTLED_POLL_MIN_INTERVAL_MS = 8_000;

  /** Пока открыт счёт ЮKassa — опрос статуса раз в 5 с (до успеха, отмены или выхода из оплаты) */
  private readonly invoicePaymentPollByTelegramId = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private static readonly INVOICE_POLL_MS = 5_000;
  /** 720 × 5 с = 1 ч — защита от вечного таймера, кнопка «Проверить оплату» остаётся */
  private static readonly INVOICE_POLL_MAX_TICKS = 720;

  constructor(
    private readonly peersService: PeersService,
    private readonly mainHandler: MainHandler,
    private readonly mainMenuService: MainMenuService,
    private readonly anchorStore: MainMenuAnchorStore,
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
    @Inject(forwardRef(() => PaymentFulfillmentService))
    private readonly paymentFulfillment: PaymentFulfillmentService,
  ) {}

  attach(bot: Bot): void {
    this.bot = bot;
  }

  /** Останавливает все таймеры опроса (вызывается при остановке бота) */
  stopAllPolling(): void {
    for (const t of this.invoicePaymentPollByTelegramId.values()) {
      clearInterval(t);
    }
    this.invoicePaymentPollByTelegramId.clear();
  }

  async syncUnsettledPayments(ctx: Context): Promise<number> {
    if (!ctx.from) return 0;
    try {
      return await this.paymentFulfillment.syncUnsettledForTelegramUser(
        String(ctx.from.id),
      );
    } catch (e) {
      this.logger.error('syncUnsettledPayments', e);
      return 0;
    }
  }

  /**
   * Редирект ЮKassa с `return_url` вида t.me/bot?start=syncpay → Telegram шлёт /start syncpay.
   * Без этого апдейта бот не узнаёт о возврате из банка.
   */
  isPostYookassaReturnStart(ctx: Context): boolean {
    const text = ctx.message?.text;
    if (typeof text !== 'string') return false;
    const p = YOOKASSA_TELEGRAM_RETURN_START_PARAM.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    return new RegExp(`^\\/start(?:@[A-Za-z0-9_]+)?\\s+${p}\\s*$`, 'i').test(
      text.trim(),
    );
  }

  /** Сбрасывает троттлинг опроса для пользователя (после возврата из банка). */
  resetUnsettledPollThrottle(userId: string): void {
    this.unsettledPollThrottleByUser.delete(userId);
  }

  /**
   * Если у пользователя есть pending-платежи — опрашиваем ЮKassa на каждом апдейте
   * (с троттлингом). Так конфиг приходит сразу после оплаты при возврате в чат,
   * без обязательного нажатия «Отмена» / главное меню.
   */
  async maybePollUnsettledPayments(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const userId = String(ctx.from.id);
    const pending = await this.paymentService.listRecentUnsettledPayments(
      userId,
      1,
    );
    if (pending.length === 0) return;

    const now = Date.now();
    const last = this.unsettledPollThrottleByUser.get(userId) ?? 0;
    if (now - last < InvoiceService.UNSETTLED_POLL_MIN_INTERVAL_MS) return;
    this.unsettledPollThrottleByUser.set(userId, now);

    await this.syncUnsettledPayments(ctx);
  }

  stopInvoicePaymentPollingForUser(telegramId: string): void {
    const id = this.invoicePaymentPollByTelegramId.get(telegramId);
    if (id !== undefined) {
      clearInterval(id);
      this.invoicePaymentPollByTelegramId.delete(telegramId);
    }
  }

  /**
   * Пока счёт не в финальном состоянии — каждые 5 с дергаем ЮKassa.
   * Конец: succeeded (конфиг ушёл через fulfill), canceled в ЮKassa, отмена пользователем (stop извне), лимит тиков.
   */
  private startInvoicePaymentPolling(
    telegramId: string,
    yookassaId: string,
    chatId: number,
    messageId: number,
  ): void {
    this.stopInvoicePaymentPollingForUser(telegramId);

    let ticks = 0;
    let busy = false;

    const finish = () => {
      this.stopInvoicePaymentPollingForUser(telegramId);
    };

    const runOnce = async () => {
      if (busy) return;
      busy = true;
      try {
        const row =
          await this.paymentService.getPaymentByYookassaId(yookassaId);
        if (!row || row.telegramId !== telegramId) {
          finish();
          return;
        }

        if (row.status === 'succeeded' || row.status === 'canceled') {
          finish();
          return;
        }

        const apiStatus =
          await this.paymentService.getPaymentStatusFromYooKassa(yookassaId);
        if (apiStatus == null) {
          ticks += 1;
          if (ticks >= InvoiceService.INVOICE_POLL_MAX_TICKS) finish();
          return;
        }

        const canceled = apiStatus === 'canceled' || apiStatus === 'cancelled';
        if (canceled) {
          await this.paymentService.updatePaymentStatus(yookassaId, 'canceled');
          try {
            await this.bot.api.editMessageText(
              chatId,
              messageId,
              `❌ *Оплата отменена*\n\n` +
                `Счёт в ЮKassa закрыт без успешной оплаты. Можете выбрать тариф снова.`,
              {
                parse_mode: 'Markdown',
                reply_markup: BotUi.backToMenuKeyboard(),
                link_preview_options: { is_disabled: true },
              },
            );
          } catch {
            // Сообщение уже изменено или удалено
          }
          finish();
          return;
        }

        if (apiStatus === 'succeeded') {
          const r = await this.paymentFulfillment.fulfillByYookassaId(
            yookassaId,
            telegramId,
            { trustYooKassaSucceeded: true },
          );
          if (r === 'fulfilled' || r === 'already_done') {
            finish();
            return;
          }
        }

        ticks += 1;
        if (ticks >= InvoiceService.INVOICE_POLL_MAX_TICKS) {
          finish();
        }
      } catch (e) {
        this.logger.warn(
          `invoice poll ${yookassaId}: ${e instanceof Error ? e.message : e}`,
        );
        ticks += 1;
        if (ticks >= InvoiceService.INVOICE_POLL_MAX_TICKS) finish();
      } finally {
        busy = false;
      }
    };

    const intervalId = setInterval(() => {
      void runOnce();
    }, InvoiceService.INVOICE_POLL_MS);
    this.invoicePaymentPollByTelegramId.set(telegramId, intervalId);
    void runOnce();
  }

  private paymentCheckCallbackHint(result: FulfillPaymentResult): {
    text: string;
    show_alert: boolean;
  } {
    switch (result) {
      case 'fulfilled':
        return {
          text: 'Готово — конфиг отправлен выше',
          show_alert: false,
        };
      case 'already_done':
        return {
          text: 'Оплата уже учтена. Откройте «Мои конфиги» в меню.',
          show_alert: true,
        };
      case 'not_found':
        return { text: 'Платёж не найден', show_alert: true };
      case 'wrong_user':
        return { text: 'Это не ваш платёж', show_alert: true };
      case 'not_succeeded_in_yookassa':
        return {
          text: 'ЮKassa ещё не подтвердила оплату. Подождите минуту и нажмите снова.',
          show_alert: true,
        };
    }
  }

  /** Ручная проверка оплаты по кнопке «Проверить оплату». */
  async handlePaymentCheck(ctx: Context, yookassaId: string): Promise<void> {
    if (!ctx.from) return;
    const telegramId = String(ctx.from.id);
    try {
      const result = await this.paymentFulfillment.fulfillByYookassaId(
        yookassaId,
        telegramId,
        { trustYooKassaSucceeded: false },
      );
      if (result === 'fulfilled' || result === 'already_done') {
        this.stopInvoicePaymentPollingForUser(telegramId);
      }
      const hint = this.paymentCheckCallbackHint(result);
      await ctx.answerCallbackQuery({
        text: hint.text,
        show_alert: hint.show_alert,
      });
    } catch (e) {
      this.logger.error('payment_check', e);
      await ctx.answerCallbackQuery({
        text: 'Ошибка проверки. Попробуйте через минуту.',
        show_alert: true,
      });
    }
  }

  /**
   * Финальная проверка перед выставлением счёта — единая точка защиты от
   * гонки с переключателем «Оплата» в админ-панели: неважно, с какой кнопки
   * (могла быть отрисована до отключения) пользователь сюда попал, счёт не
   * создастся, если оплата выключена именно сейчас.
   */
  private async guardPaymentEnabled(
    ctx: Context,
    backKeyboard: ReturnType<typeof BotUi.backToMenuKeyboard>,
  ): Promise<boolean> {
    if (await this.paymentService.isPaymentEnabled()) return true;
    await safeEditMessageText(ctx, BotUi.paymentMenuUnavailable, {
      parse_mode: 'Markdown',
      reply_markup: backKeyboard,
    });
    return false;
  }

  async presentNewPurchaseInvoice(
    ctx: Context,
    durationDays: 30 | 60 | 90,
  ): Promise<void> {
    if (!ctx.from) return;
    if (!(await this.guardPaymentEnabled(ctx, BotUi.backToMenuKeyboard())))
      return;
    const telegramId = String(ctx.from.id);
    const hasUsedDiscount =
      await this.peersService.hasUsedFirstPurchaseDiscount(telegramId);
    const isPromo =
      !hasUsedDiscount && (durationDays === 60 || durationDays === 90);
    const nominalPrice = isPromo
      ? BotUi.paymentPlanDiscountedPrices[durationDays]
      : BotUi.paymentPlanPrices[durationDays];
    const price = await this.paymentService.getBilledAmountRub(nominalPrice);

    const payment = await this.paymentService.createPayment(
      telegramId,
      nominalPrice,
      durationDays,
      isPromo,
    );

    const messageIdAfterEdit = await safeEditMessageText(
      ctx,
      `💳 *Оплата*\n\n` +
        `Тариф: *${durationDays} дней*\n` +
        `Сумма: *${price} ₽*\n\n` +
        `Нажмите *«Оплатить»* — откроется ЮKassa.\n\n` +
        `Пока счёт не отменён и не оплачен, бот *каждые 5 секунд* проверяет статус в ЮKassa. ` +
        `После успешной оплаты придёт конфиг; при отмене в банке текст счёта обновится.\n\n` +
        `При необходимости — *«Проверить оплату»* вручную.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '💳 Оплатить',
                url: payment.confirmation.confirmation_url,
              },
            ],
            [
              {
                text: '✅ Проверить оплату',
                callback_data: `payment_check:${payment.id}`,
              },
            ],
            [{ text: '❌ Отмена', callback_data: 'main_menu' }],
          ],
        },
      },
    );

    await this.finalizeInvoicePresentation(
      ctx,
      telegramId,
      payment.id,
      messageIdAfterEdit,
    );
  }

  /** Счёт ЮKassa: продление конфига */
  async presentExtendInvoice(
    ctx: Context,
    durationDays: 30 | 60 | 90,
    peerName: string,
  ): Promise<void> {
    if (!ctx.from) return;
    if (
      !(await this.guardPaymentEnabled(
        ctx,
        BotUi.backToOwnPeerKeyboard(peerName),
      ))
    )
      return;
    const telegramId = String(ctx.from.id);
    const hasUsedDiscount =
      await this.peersService.hasUsedFirstPurchaseDiscount(telegramId);
    const isPromo =
      !hasUsedDiscount && (durationDays === 60 || durationDays === 90);
    const nominalPrice = isPromo
      ? BotUi.paymentPlanDiscountedPrices[durationDays]
      : BotUi.paymentPlanPrices[durationDays];
    const price = await this.paymentService.getBilledAmountRub(nominalPrice);

    const payment = await this.paymentService.createPayment(
      telegramId,
      nominalPrice,
      durationDays,
      isPromo,
      peerName,
    );

    const messageIdAfterEdit = await safeEditMessageText(
      ctx,
      `💳 *Оплата (продление)*\n\n` +
        `Тариф: *${durationDays} дней*\n` +
        `Сумма: *${price} ₽*\n\n` +
        `Нажмите *«Оплатить»* — откроется ЮKassa.\n\n` +
        `Пока счёт активен, бот *каждые 5 секунд* проверяет статус; после оплаты придёт обновлённый конфиг.\n\n` +
        `*«Проверить оплату»* — вручную, если нужно.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '💳 Оплатить',
                url: payment.confirmation.confirmation_url,
              },
            ],
            [
              {
                text: '✅ Проверить оплату',
                callback_data: `payment_check:${payment.id}`,
              },
            ],
            [
              {
                text: '« Назад к тарифам',
                callback_data: `extend_pay_plans:${peerName}`,
              },
            ],
          ],
        },
      },
    );

    await this.finalizeInvoicePresentation(
      ctx,
      telegramId,
      payment.id,
      messageIdAfterEdit,
    );
  }

  /**
   * Общий хвост обоих счетов: подчищаем старое сообщение, фиксируем якорь
   * и запускаем опрос статуса.
   */
  private async finalizeInvoicePresentation(
    ctx: Context,
    telegramId: string,
    paymentId: string,
    messageIdAfterEdit: number | undefined,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    const cbMsg = ctx.callbackQuery?.message;
    const oldMessageId =
      cbMsg && 'message_id' in cbMsg ? cbMsg.message_id : undefined;
    if (
      chatId != null &&
      messageIdAfterEdit != null &&
      oldMessageId != null &&
      messageIdAfterEdit !== oldMessageId
    ) {
      await ctx.api
        .editMessageText(
          chatId,
          oldMessageId,
          '↩️ *Счёт — в сообщении ниже.*',
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] },
          },
        )
        .catch(() => {});
    }

    if (chatId != null && messageIdAfterEdit != null) {
      await this.paymentService.setInvoiceUiAnchor(
        paymentId,
        String(chatId),
        messageIdAfterEdit,
      );
      this.anchorStore.set(telegramId, {
        chatId,
        messageId: messageIdAfterEdit,
      });
      this.startInvoicePaymentPolling(
        telegramId,
        paymentId,
        chatId,
        messageIdAfterEdit,
      );
    }
  }

  /** Один файл .conf после оплаты; сообщение со счётом убираем, чтобы не дублировать кнопки. */
  private async sendPaidConfigDocument(
    telegramId: string,
    config: string,
    peer: TPeer,
    caption: string,
    invoiceUi?: { chatId: string; messageId: number },
  ): Promise<void> {
    if (invoiceUi) {
      await this.bot.api
        .deleteMessage(Number(invoiceUi.chatId), invoiceUi.messageId)
        .catch(() => {});
    }
    this.anchorStore.delete(telegramId);

    const message = await this.bot.api.sendDocument(
      telegramId,
      new InputFile(Buffer.from(config), `${peer.name}.conf`),
      {
        caption,
        parse_mode: 'Markdown',
        reply_markup: BotUi.configDeliveredKeyboard(peer.name),
      },
    );

    await this.peersService.setConfigMessageId(peer.name, message.message_id);
  }

  /** Уведомление об успешной оплате и отправка конфига */
  async notifyPaymentSuccess(
    telegramId: string,
    config: string,
    peer: TPeer,
    durationDays: number,
    amount: number,
    invoiceUi?: { chatId: string; messageId: number },
  ): Promise<void> {
    try {
      this.mainHandler.invalidateMainMenuCache(telegramId);
      await this.mainMenuService.dismissStaleMainMenuAnchor(
        telegramId,
        invoiceUi?.messageId,
      );

      const caption =
        `✅ *Оплата прошла успешно!* (${amount} ₽)\n` +
        `Конфиг *${peer.name}* на *${durationDays} дн.*\n\n` +
        BotUi.configCreated(peer.name, peer.ip, peer.expiresAt);

      await this.sendPaidConfigDocument(
        telegramId,
        config,
        peer,
        caption,
        invoiceUi,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying user ${telegramId} about payment success`,
        error,
      );
    }
  }

  /** Уведомление об успешном продлении конфига */
  async notifyExtendSuccess(
    telegramId: string,
    config: string,
    peer: TPeer,
    durationDays: number,
    amount: number,
    invoiceUi?: { chatId: string; messageId: number },
  ): Promise<void> {
    try {
      this.mainHandler.invalidateMainMenuCache(telegramId);
      await this.mainMenuService.dismissStaleMainMenuAnchor(
        telegramId,
        invoiceUi?.messageId,
      );

      const expiresStr = peer.expiresAt
        ? new Date(peer.expiresAt).toLocaleDateString('ru-RU')
        : '—';
      const caption =
        `✅ *Продление прошло успешно!* (${amount} ₽)\n` +
        `Конфиг *${peer.name}* — *${durationDays} дн.*, до *${expiresStr}*\n\n` +
        BotUi.configCreated(peer.name, peer.ip, peer.expiresAt);

      await this.sendPaidConfigDocument(
        telegramId,
        config,
        peer,
        caption,
        invoiceUi,
      );
    } catch (error) {
      this.logger.error(
        `Error notifying user ${telegramId} about extend success`,
        error,
      );
    }
  }
}
