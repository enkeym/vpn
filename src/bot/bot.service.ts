import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, GrammyError, HttpError, InputFile, type Context } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { PeersService, TPeer } from 'src/peers/peers.service';
import { BlockedUsersService } from 'src/blocked/blocked.service';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';
import { FamilyHandler } from './handlers/family.handler';
import { AdminHandler } from './handlers/admin.handler';
import {
  PaymentService,
  YOOKASSA_TELEGRAM_RETURN_START_PARAM,
} from 'src/payment/payment.service';
import {
  PaymentFulfillmentService,
  type FulfillPaymentResult,
} from 'src/payment/payment-fulfillment.service';
import { BotUi } from './ui/bot.ui';
import { safeEditMessageText } from './utils/safe-edit-message';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot;
  private readonly logger = new Logger(BotService.name);
  private adminIds: string[] = [];

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

  private readonly mainMenuMessageAnchor = new Map<
    string,
    { chatId: number; messageId: number }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly mainHandler: MainHandler,
    private readonly peerCreateHandler: PeerCreateHandler,
    private readonly peerDeleteHandler: PeerDeleteHandler,
    private readonly peerManageHandler: PeerManageHandler,
    private readonly familyHandler: FamilyHandler,
    private readonly adminHandler: AdminHandler,
    private readonly familyService: FamilyService,
    private readonly peersService: PeersService,
    private readonly blockedUsersService: BlockedUsersService,
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
    @Inject(forwardRef(() => PaymentFulfillmentService))
    private readonly paymentFulfillment: PaymentFulfillmentService,
  ) {}

  onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN')?.trim();
    if (!token) {
      this.logger.error(
        'TELEGRAM_BOT_TOKEN пустой или не задан — long polling не запускается.',
      );
      return;
    }

    const whiteList = this.configService.get<string>(
      'TELEGRAM_ALLOWED_IDS',
      '',
    );
    this.adminIds = whiteList
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    // client.timeoutSeconds по умолчанию 500 — при обрыве сети getUpdates может «молчать» очень долго
    this.bot = new Bot(token, {
      client: { timeoutSeconds: 120 },
    });
    this.registerMiddleware();
    this.registerCommands();
    this.registerFamilyCommands();
    this.registerAdminCommands();
    this.startBot();
  }

  private isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId);
  }

  private async syncUnsettledPayments(ctx: Context): Promise<number> {
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
   * Снимает клавиатуру с якорного сообщения, если это ещё не сообщение со счётом/успехом.
   */
  private async dismissStaleMainMenuAnchor(
    telegramId: string,
    invoiceMessageId?: number,
  ): Promise<void> {
    const anchor = this.mainMenuMessageAnchor.get(telegramId);
    if (!anchor) return;
    if (invoiceMessageId != null && anchor.messageId === invoiceMessageId) {
      return;
    }
    await this.bot.api
      .editMessageReplyMarkup(anchor.chatId, anchor.messageId, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
    this.mainMenuMessageAnchor.delete(telegramId);
  }

  /**
   * Редирект ЮKassa с `return_url` вида t.me/bot?start=syncpay → Telegram шлёт /start syncpay.
   * Без этого апдейта бот не узнаёт о возврате из банка.
   */
  private isPostYookassaReturnStart(ctx: Context): boolean {
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

  /**
   * Если у пользователя есть pending-платежи — опрашиваем ЮKassa на каждом апдейте
   * (с троттлингом). Так конфиг приходит сразу после оплаты при возврате в чат,
   * без обязательного нажатия «Отмена» / главное меню.
   */
  private async maybePollUnsettledPayments(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const userId = String(ctx.from.id);
    const pending = await this.paymentService.listRecentUnsettledPayments(
      userId,
      1,
    );
    if (pending.length === 0) return;

    const now = Date.now();
    const last = this.unsettledPollThrottleByUser.get(userId) ?? 0;
    if (now - last < BotService.UNSETTLED_POLL_MIN_INTERVAL_MS) return;
    this.unsettledPollThrottleByUser.set(userId, now);

    await this.syncUnsettledPayments(ctx);
  }

  private stopInvoicePaymentPollingForUser(telegramId: string): void {
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
          if (ticks >= BotService.INVOICE_POLL_MAX_TICKS) finish();
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
        if (ticks >= BotService.INVOICE_POLL_MAX_TICKS) {
          finish();
        }
      } catch (e) {
        this.logger.warn(
          `invoice poll ${yookassaId}: ${e instanceof Error ? e.message : e}`,
        );
        ticks += 1;
        if (ticks >= BotService.INVOICE_POLL_MAX_TICKS) finish();
      } finally {
        busy = false;
      }
    };

    const intervalId = setInterval(() => {
      void runOnce();
    }, BotService.INVOICE_POLL_MS);
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

  private async updateInvoiceSuccessMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<boolean> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'Markdown',
        reply_markup: BotUi.configDeliveredKeyboard(),
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes('there is no text in the message to edit')) {
        try {
          await this.bot.api.editMessageCaption(chatId, messageId, {
            caption: text,
            parse_mode: 'Markdown',
            reply_markup: BotUi.configDeliveredKeyboard(),
          });
          return true;
        } catch (e2) {
          this.logger.warn(
            `Не удалось обновить сообщение со счётом: ${e2 instanceof Error ? e2.message : e2}`,
          );
          return false;
        }
      }
      if (
        errMsg.includes("message can't be edited") ||
        errMsg.includes('message to edit not found')
      ) {
        return false;
      }
      this.logger.warn(`Не удалось обновить сообщение со счётом: ${errMsg}`);
      return false;
    }
  }

  private async presentNewPurchaseInvoice(
    ctx: Context,
    durationDays: 30 | 60 | 90,
  ): Promise<void> {
    if (!ctx.from) return;
    const telegramId = String(ctx.from.id);
    const hasUsedDiscount =
      await this.peersService.hasUsedFirstPurchaseDiscount(telegramId);
    const isPromo =
      !hasUsedDiscount && (durationDays === 60 || durationDays === 90);
    const nominalPrice = isPromo
      ? BotUi.paymentPlanDiscountedPrices[durationDays]
      : BotUi.paymentPlanPrices[durationDays];
    const price = this.paymentService.getBilledAmountRub(nominalPrice);

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
        payment.id,
        String(chatId),
        messageIdAfterEdit,
      );
      this.mainMenuMessageAnchor.set(telegramId, {
        chatId,
        messageId: messageIdAfterEdit,
      });
      this.startInvoicePaymentPolling(
        telegramId,
        payment.id,
        chatId,
        messageIdAfterEdit,
      );
    }
  }

  /** Счёт ЮKassa: продление конфига */
  private async presentExtendInvoice(
    ctx: Context,
    durationDays: 30 | 60 | 90,
    peerName: string,
  ): Promise<void> {
    if (!ctx.from) return;
    const telegramId = String(ctx.from.id);
    const hasUsedDiscount =
      await this.peersService.hasUsedFirstPurchaseDiscount(telegramId);
    const isPromo =
      !hasUsedDiscount && (durationDays === 60 || durationDays === 90);
    const nominalPrice = isPromo
      ? BotUi.paymentPlanDiscountedPrices[durationDays]
      : BotUi.paymentPlanPrices[durationDays];
    const price = this.paymentService.getBilledAmountRub(nominalPrice);

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
        payment.id,
        String(chatId),
        messageIdAfterEdit,
      );
      this.mainMenuMessageAnchor.set(telegramId, {
        chatId,
        messageId: messageIdAfterEdit,
      });
      this.startInvoicePaymentPolling(
        telegramId,
        payment.id,
        chatId,
        messageIdAfterEdit,
      );
    }
  }

  async onModuleDestroy() {
    for (const t of this.invoicePaymentPollByTelegramId.values()) {
      clearInterval(t);
    }
    this.invoicePaymentPollByTelegramId.clear();
    if (this.bot) {
      await this.bot.stop();
    }
  }

  private registerMiddleware() {
    this.bot.catch(async (err) => {
      const ctx = err.ctx;
      this.logger.error(`Ошибка во время выполнения ${ctx.update.update_id}`);
      const error = err.error;
      if (error instanceof GrammyError) {
        this.logger.error(`Ошибка во время запроса: ${error.description}`);
      } else if (error instanceof HttpError) {
        this.logger.error(`Ошибка при подключении к Telegram: ${error}`);
      } else {
        this.logger.error(`Неизвестная ошибка: ${String(error)}`);
      }

      // Отвечаем на callback query, чтобы кнопка не "зависала"
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery({
            text: 'Произошла ошибка. Попробуйте позже.',
            show_alert: true,
          });
        } catch {
          // Игнорируем ошибку, если callback уже был отвечен
        }
      }
    });

    // Middleware проверки доступа: админы и члены группы "Семья"
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) {
        if (ctx.callbackQuery) {
          try {
            await ctx.answerCallbackQuery({
              text: 'Ошибка авторизации',
              show_alert: true,
            });
          } catch {
            // Игнорируем
          }
        }
        return;
      }

      const userId = String(ctx.from.id);
      const postPayReturn = this.isPostYookassaReturnStart(ctx);

      if (this.isAdmin(userId)) {
        if (postPayReturn) {
          this.unsettledPollThrottleByUser.delete(userId);
          await this.syncUnsettledPayments(ctx);
        }
        await next();
        return;
      }

      // Сразу отвечаем на callback, чтобы кнопка перестала «крутиться» (до isBlocked).
      // Исключения: ответ с текстом даёт сам обработчик.
      if (ctx.callbackQuery) {
        const data = ctx.callbackQuery.data;
        const deferAnswer =
          typeof data === 'string' &&
          /^(payment_check:|pay_plan:|extend_pay_plan:|pay_confirm:|extend_pay_confirm:)/.test(
            data,
          );
        if (!deferAnswer) {
          try {
            await ctx.answerCallbackQuery();
          } catch {
            // Игнорируем
          }
        }
      }

      const isBlocked = await this.blockedUsersService.isBlocked(userId);
      if (isBlocked) {
        await ctx.reply('Вы заблокированы.').catch(() => {});
        return;
      }

      if (postPayReturn) {
        this.unsettledPollThrottleByUser.delete(userId);
        await this.syncUnsettledPayments(ctx);
      } else {
        await this.maybePollUnsettledPayments(ctx);
      }

      await next();
    });

    // Пересланные сообщения при добавлении в группу (в т.ч. без текста: стикер, фото и т.д.)
    this.bot.on('message', async (ctx, next) => {
      if (!ctx.from || !ctx.message) return next();
      const userId = String(ctx.from.id);
      if (
        !this.isAdmin(userId) ||
        !this.familyHandler.isAwaitingInput(userId)
      ) {
        return next();
      }
      const msg = ctx.message;
      const legacyFrom = (msg as { forward_from?: { id: number } })
        .forward_from;
      if (!msg.forward_origin && !legacyFrom) {
        return next();
      }
      await this.familyHandler.handleAddMemberInput(ctx);
    });

    // Обработка текстовых сообщений для ввода данных члена группы
    this.bot.on('message:text', async (ctx, next) => {
      if (!ctx.from) return;

      const userId = String(ctx.from.id);

      // Если админ ожидает ввода для добавления в группу
      if (this.isAdmin(userId) && this.familyHandler.isAwaitingInput(userId)) {
        await this.familyHandler.handleAddMemberInput(ctx);
        return;
      }

      // Если админ ожидает ввода нового имени участника
      if (
        this.isAdmin(userId) &&
        this.familyHandler.isAwaitingNameEdit(userId)
      ) {
        await this.familyHandler.handleEditNameInput(ctx);
        return;
      }

      // Если админ ожидает ввода описания конфига члена группы
      if (
        this.isAdmin(userId) &&
        this.familyHandler.isAwaitingDescriptionEdit(userId)
      ) {
        await this.familyHandler.handleEditDescriptionInput(ctx);
        return;
      }

      // Если админ ожидает ввода описания своего конфига
      if (
        this.isAdmin(userId) &&
        this.peerManageHandler.isAwaitingDescriptionEdit(userId)
      ) {
        await this.peerManageHandler.handleEditDescriptionInput(ctx);
        return;
      }

      // Если админ ожидает ввода для поиска клиента
      if (
        this.isAdmin(userId) &&
        this.adminHandler.isAwaitingClientSearch(userId)
      ) {
        await this.adminHandler.handleSearchInput(ctx);
        return;
      }

      // Если админ ожидает ввода описания конфига клиента
      if (
        this.isAdmin(userId) &&
        this.adminHandler.isAwaitingClientDescriptionEdit(userId)
      ) {
        await this.adminHandler.handleEditDescriptionInput(ctx);
        return;
      }

      await next();
    });
  }

  /**
   * Коллбэк висит на сообщении без обычного `text` (документ, фото, видео и т.п.).
   * Для таких сообщений нельзя редактировать «как текст» — caption fallback в
   * `safeEditMessageText` приклеит текст меню к caption-у медиа.
   */
  private isCallbackOnNonTextMessage(ctx: Context): boolean {
    const m = ctx.callbackQuery?.message;
    if (!m) return false;
    if ('text' in m && typeof m.text === 'string') return false;
    return (
      ('document' in m && !!m.document) ||
      ('photo' in m && !!m.photo) ||
      ('video' in m && !!m.video) ||
      ('animation' in m && !!m.animation) ||
      ('audio' in m && !!m.audio) ||
      ('voice' in m && !!m.voice) ||
      ('sticker' in m && !!m.sticker)
    );
  }

  /**
   * Главное меню: по возможности обновляем одно и то же сообщение (меньше дублей от /start).
   * «В меню» с файла .conf — снова рисуем меню в том же сообщении, что счёт/успех (якорь), без нового reply.
   */
  private async presentMainMenuAnchored(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) {
      await this.mainHandler.showMainMenu(ctx);
      return;
    }
    const userId = String(ctx.from.id);
    const chatId = ctx.chat.id;
    const anchor = this.mainMenuMessageAnchor.get(userId);

    const cbMsg = ctx.callbackQuery?.message;
    const cbMid = cbMsg && 'message_id' in cbMsg ? cbMsg.message_id : undefined;

    // «В меню» с документа .conf / QR: файл удаляем, меню — в якорном текстовом сообщении
    // или новым reply (нельзя превратить документ в текстовое меню через edit).
    if (this.isCallbackOnNonTextMessage(ctx)) {
      const deleteCurrentMessage =
        cbMid != null
          ? ctx.api.deleteMessage(chatId, cbMid).catch(() => {})
          : Promise.resolve();
      void deleteCurrentMessage;

      if (anchor && anchor.chatId === chatId && anchor.messageId !== cbMid) {
        const ok = await this.mainHandler.tryRefreshMainMenuMessage(
          this.bot.api,
          anchor.chatId,
          anchor.messageId,
          userId,
        );
        if (ok) {
          return;
        }
        this.mainMenuMessageAnchor.delete(userId);
      }

      const newId = await this.mainHandler.sendFreshMainMenu(ctx);
      if (newId != null) {
        this.mainMenuMessageAnchor.set(userId, { chatId, messageId: newId });
      }
      return;
    }

    const canRefreshAnchoredMenu =
      anchor?.chatId === chatId &&
      (cbMid == null || cbMid === anchor.messageId);

    if (
      cbMid != null &&
      anchor &&
      anchor.messageId !== cbMid &&
      !this.isCallbackOnNonTextMessage(ctx)
    ) {
      this.mainMenuMessageAnchor.delete(userId);
    }

    if (canRefreshAnchoredMenu) {
      const ok = await this.mainHandler.tryRefreshMainMenuMessage(
        this.bot.api,
        anchor.chatId,
        anchor.messageId,
        userId,
      );
      if (ok) {
        return;
      }
      this.mainMenuMessageAnchor.delete(userId);
    }

    const messageId = await this.mainHandler.showMainMenu(ctx);
    if (messageId != null) {
      this.mainMenuMessageAnchor.set(userId, { chatId, messageId });
    }
  }

  private async presentMainMenuFresh(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) {
      await this.mainHandler.sendFreshMainMenu(ctx);
      return;
    }
    const userId = String(ctx.from.id);
    const chatId = ctx.chat.id;

    const anchor = this.mainMenuMessageAnchor.get(userId);
    if (anchor && anchor.chatId === chatId) {
      await this.bot.api
        .editMessageReplyMarkup(anchor.chatId, anchor.messageId, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {
          // Сообщение могло быть удалено пользователем — игнорируем
        });
      this.mainMenuMessageAnchor.delete(userId);
    }

    const messageId = await this.mainHandler.sendFreshMainMenu(ctx);
    if (messageId != null) {
      this.mainMenuMessageAnchor.set(userId, { chatId, messageId });
    }
  }

  private registerCommands() {
    this.bot.command('start', async (ctx) => {
      const postPayReturn = this.isPostYookassaReturnStart(ctx);

      if (postPayReturn) {
        // Синхронизация и выдача конфига — в middleware; не шлём главное меню (дубль).
        await this.syncUnsettledPayments(ctx);
        if (ctx.chat?.id && ctx.message?.message_id) {
          await ctx.api
            .deleteMessage(ctx.chat.id, ctx.message.message_id)
            .catch(() => {});
        }
        return;
      }

      await this.syncUnsettledPayments(ctx);
      await this.presentMainMenuFresh(ctx);
    });

    this.bot.callbackQuery('main_menu', async (ctx) => {
      if (ctx.from) {
        this.stopInvoicePaymentPollingForUser(String(ctx.from.id));
      }
      const callbackOnNonTextMessage = this.isCallbackOnNonTextMessage(ctx);
      try {
        await ctx.answerCallbackQuery();
      } catch {
        // Уже отвечено в middleware (для не-админов)
      }
      if (!callbackOnNonTextMessage) {
        await this.syncUnsettledPayments(ctx);
      }
      await this.presentMainMenuAnchored(ctx);
    });

    this.bot.callbackQuery('create_trial_config', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerCreateHandler.handleCreateTrialConfig(ctx);
    });

    this.bot.callbackQuery('show_create_options', async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const userId = String(ctx.from.id);
      const [userType, hasUsedDiscount] = await Promise.all([
        this.mainHandler.getUserType(userId),
        this.peersService.hasUsedFirstPurchaseDiscount(userId),
      ]);
      if (userType === 'user') {
        await this.peerCreateHandler.showPaymentPlans(ctx, hasUsedDiscount);
      } else {
        await this.peerCreateHandler.showCreateOptions(ctx);
      }
    });

    this.bot.callbackQuery(/^pay_plan:(30|60|90)$/, async (ctx) => {
      if (!ctx.from) return;
      const days = Number(ctx.match[1]) as 30 | 60 | 90;
      try {
        await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
        await this.presentNewPurchaseInvoice(ctx, days);
      } catch (error) {
        this.logger.error('Error in pay_plan', error);
        await ctx
          .reply(
            '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
          )
          .catch(() => {});
      }
    });

    /** Старые сообщения с экраном подтверждения */
    this.bot.callbackQuery(/^pay_confirm:(30|60|90)$/, async (ctx) => {
      if (!ctx.from) return;
      const durationDays = Number(ctx.match[1]) as 30 | 60 | 90;
      try {
        await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
        await this.presentNewPurchaseInvoice(ctx, durationDays);
      } catch (error) {
        this.logger.error('Error in pay_confirm', error);
        await ctx
          .reply(
            '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
          )
          .catch(() => {});
      }
    });

    this.bot.callbackQuery(/^create_config:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = String(ctx.from?.id);

      // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверка прав
      if (!this.isAdmin(userId)) {
        const userType = await this.mainHandler.getUserType(userId);
        if (userType === 'user') {
          return ctx.reply(
            '❌ Этот метод создания доступен только администраторам. Пожалуйста, используйте меню оплаты.',
          );
        }
      }

      const duration = ctx.match[1];
      const durationDays =
        duration === 'unlimited'
          ? undefined
          : (Number(duration) as 30 | 60 | 90);
      await this.peerCreateHandler.handleCreateConfig(ctx, durationDays);
    });

    // Список конфигов (подсказка «Загрузка…» — мгновенный отклик при задержке)
    this.bot.callbackQuery('list_configs', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Загрузка…' });
      await this.peerManageHandler.showConfigsList(ctx);
    });

    // Действия с конкретным пиром
    this.bot.callbackQuery(/^manage_peer:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const isAdmin = ctx.from ? this.isAdmin(String(ctx.from.id)) : false;
      await this.peerManageHandler.showPeerDetails(ctx, peerName, isAdmin);
    });

    // Пауза/Старт
    this.bot.callbackQuery(/^toggle_peer:(.+)$/, async (ctx) => {
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const isAdmin = ctx.from ? this.isAdmin(String(ctx.from.id)) : false;
      await this.peerManageHandler.togglePeer(ctx, peerName, isAdmin);
    });

    // Удаление пира
    this.bot.callbackQuery(/^delete_peer:(.+)$/, async (ctx) => {
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const isAdmin = ctx.from ? this.isAdmin(String(ctx.from.id)) : false;
      await this.peerDeleteHandler.deletePeer(ctx, peerName, isAdmin);
    });

    // Продление конфига — переход в меню оплаты
    this.bot.callbackQuery(/^extend_peer:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerCreateHandler.showPaymentPlansForExtend(ctx, peerName);
    });

    // Возврат к тарифам при продлении
    this.bot.callbackQuery(/^extend_pay_plans:(.+)$/, async (ctx) => {
      if (ctx.from) {
        this.stopInvoicePaymentPollingForUser(String(ctx.from.id));
      }
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerCreateHandler.showPaymentPlansForExtend(ctx, peerName);
    });

    // Выбор тарифа при продлении — сразу счёт ЮKassa
    this.bot.callbackQuery(/^extend_pay_plan:(30|60|90):(.+)$/, async (ctx) => {
      if (!ctx.from) return;
      const days = Number(ctx.match[1]) as 30 | 60 | 90;
      const peerName = ctx.match[2];
      try {
        await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
        await this.presentExtendInvoice(ctx, days, peerName);
      } catch (error) {
        this.logger.error('Error in extend_pay_plan', error);
        await ctx
          .reply(
            '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
          )
          .catch(() => {});
      }
    });

    /** Старые сообщения с экраном подтверждения продления */
    this.bot.callbackQuery(
      /^extend_pay_confirm:(30|60|90):(.+)$/,
      async (ctx) => {
        if (!ctx.from) return;
        const durationDays = Number(ctx.match[1]) as 30 | 60 | 90;
        const peerName = ctx.match[2];
        try {
          await ctx.answerCallbackQuery({ text: 'Готовлю счёт…' });
          await this.presentExtendInvoice(ctx, durationDays, peerName);
        } catch (error) {
          this.logger.error('Error in extend_pay_confirm', error);
          await ctx
            .reply(
              '❌ Не удалось сформировать счёт. Попробуйте позже или напишите в поддержку.',
            )
            .catch(() => {});
        }
      },
    );

    this.bot.callbackQuery(/^payment_check:(.+)$/, async (ctx) => {
      if (!ctx.from) return;
      const yookassaId = ctx.match[1];
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
    });

    // Замена конфига (раз в день)
    this.bot.callbackQuery(/^replace_peer:(.+)$/, async (ctx) => {
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerManageHandler.replacePeer(ctx, peerName);
    });

    // Переход к конфигу через новое сообщение (после документов)
    this.bot.callbackQuery(/^goto_peer:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerManageHandler.showPeerDetailsReply(ctx, peerName);
    });

    // После замены конфига — родитель удалён, нужен новый reply с деталями
    this.bot.callbackQuery(/^goto_peer_after_replace:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      const isAdmin = ctx.from ? this.isAdmin(String(ctx.from.id)) : false;
      await this.peerManageHandler.showPeerDetailsReplyAfterReplace(
        ctx,
        peerName,
        isAdmin,
      );
    });

    // Показать QR-код конфига
    this.bot.callbackQuery(/^show_qr:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerManageHandler.showQrCode(ctx, peerName);
    });

    // Получить файл конфига
    this.bot.callbackQuery(/^get_config_file:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerManageHandler.sendConfigFile(ctx, peerName);
    });

    // Редактирование описания своего конфига (только для админов)
    this.bot.callbackQuery(/^edit_description:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerManageHandler.showEditDescriptionPrompt(ctx, peerName);
    });

    // Отмена редактирования описания своего конфига
    this.bot.callbackQuery(/^cancel_edit_description:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const peerName = ctx.match[1];
      await this.peerManageHandler.cancelEditDescription(ctx, peerName, true);
    });

    // === Инструкции ===

    // Показать меню инструкций
    this.bot.callbackQuery('show_instructions', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.mainHandler.showInstructions(ctx);
    });

    // Показать инструкцию для конкретной платформы
    this.bot.callbackQuery(/^instruction:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const platform = ctx.match[1];
      await this.mainHandler.showInstruction(ctx, platform);
    });
  }

  private registerFamilyCommands() {
    // Меню группы "Семья" (только для админов)
    this.bot.callbackQuery('family_menu', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.familyHandler.showFamilyMenu(ctx);
    });

    // Добавить в группу
    this.bot.callbackQuery('family_add', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.familyHandler.showAddMemberPrompt(ctx);
    });

    // Отмена добавления
    this.bot.callbackQuery('family_cancel_add', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.familyHandler.cancelAddMember(ctx);
    });

    // Просмотр члена группы (f_m = family_member)
    this.bot.callbackQuery(/^f_m:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const memberId = ctx.match[1];
      await this.familyHandler.showMemberDetails(ctx, memberId);
    });

    // Список конфигов члена группы (f_mc = family_member_configs)
    this.bot.callbackQuery(/^f_mc:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const memberId = ctx.match[1];
      await this.familyHandler.showMemberConfigs(ctx, memberId);
    });

    // Просмотр конфига члена группы (f_p = family_peer)
    this.bot.callbackQuery(/^f_p:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.showMemberPeerDetails(ctx, peerName, memberId);
    });

    // Переключение статуса конфига (f_tp = family_toggle_peer)
    this.bot.callbackQuery(/^f_tp:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.toggleMemberPeer(ctx, peerName, memberId);
    });

    // Удаление конфига члена группы (f_dp = family_delete_peer)
    this.bot.callbackQuery(/^f_dp:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.deleteMemberPeer(ctx, peerName, memberId);
    });

    // Изменение срока действия (f_cd = family_change_duration)
    this.bot.callbackQuery(/^f_cd:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.showChangeDuration(ctx, peerName, memberId);
    });

    // Установка срока (f_sd = family_set_duration, u = unlimited)
    this.bot.callbackQuery(/^f_sd:(.+):(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const [peerName, memberId, duration] = [
        ctx.match[1],
        ctx.match[2],
        ctx.match[3] === 'u' ? 'unlimited' : ctx.match[3],
      ];
      await this.familyHandler.changePeerDuration(
        ctx,
        peerName,
        memberId,
        duration,
      );
    });

    // Удаление члена из группы (f_rm = family_remove)
    this.bot.callbackQuery(/^f_rm:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, т.к. удаление может занять время
      await ctx.answerCallbackQuery();
      const memberId = ctx.match[1];
      await this.familyHandler.removeMember(ctx, memberId);
    });

    // Редактирование имени (f_en = family_edit_name)
    this.bot.callbackQuery(/^f_en:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const memberId = ctx.match[1];
      await this.familyHandler.showEditNamePrompt(ctx, memberId);
    });

    // Отмена редактирования имени (f_cen = family_cancel_edit_name)
    this.bot.callbackQuery(/^f_cen:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const memberId = ctx.match[1];
      await this.familyHandler.cancelEditName(ctx, memberId);
    });

    // Редактирование описания (f_ed = family_edit_description)
    this.bot.callbackQuery(/^f_ed:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.showEditDescriptionPrompt(
        ctx,
        peerName,
        memberId,
      );
    });

    // Отмена редактирования описания (f_ced = family_cancel_edit_description)
    this.bot.callbackQuery(/^f_ced:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.cancelEditDescription(ctx, peerName, memberId);
    });

    // Меню создания конфига (f_cc = family_create_config)
    this.bot.callbackQuery(/^f_cc:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const memberId = ctx.match[1];
      await this.familyHandler.showCreateConfigOptions(ctx, memberId);
    });

    // Создать конфиг (f_dc = family_do_create, u = unlimited)
    this.bot.callbackQuery(/^f_dc:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, чтобы кнопка не зависала во время создания конфига
      await ctx.answerCallbackQuery();
      const [memberId, duration] = [
        ctx.match[1],
        ctx.match[2] === 'u' ? 'unlimited' : ctx.match[2],
      ];
      await this.familyHandler.createMemberConfig(ctx, memberId, duration);
    });
  }

  private registerAdminCommands() {
    // Поиск клиента
    this.bot.callbackQuery('admin_search', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showSearchPrompt(ctx);
    });

    // Отмена поиска
    this.bot.callbackQuery('admin_cancel_search', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.adminHandler.cancelSearch(ctx);
    });

    // Статистика (конфиги и пользователи)
    this.bot.callbackQuery('admin_stats', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showStats(ctx);
    });

    // Аналитика конфигов (меню)
    this.bot.callbackQuery('admin_analytics', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalytics(ctx);
    });

    // Аналитика: сводка
    this.bot.callbackQuery('admin_analytics_overview', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsOverview(ctx);
    });

    // Аналитика: по срокам
    this.bot.callbackQuery('admin_analytics_duration', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsDuration(ctx);
    });

    // Аналитика: пробные конфиги
    this.bot.callbackQuery('admin_analytics_trial', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsTrial(ctx);
    });

    // Аналитика: последние созданные
    this.bot.callbackQuery('admin_analytics_recent', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsRecent(ctx);
    });

    // Аналитика: истекают скоро
    this.bot.callbackQuery('admin_analytics_expiring', async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.adminHandler.showAnalyticsExpiring(ctx);
    });

    // Просмотр клиента
    this.bot.callbackQuery(/^admin_client:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const telegramId = ctx.match[1];
      await this.adminHandler.showClientDetails(ctx, telegramId);
    });

    // Список конфигов клиента
    this.bot.callbackQuery(/^admin_client_configs:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const telegramId = ctx.match[1];
      await this.adminHandler.showClientConfigs(ctx, telegramId);
    });

    // Просмотр конфига клиента
    this.bot.callbackQuery(/^admin_peer:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const [peerName, telegramId] = [ctx.match[1], ctx.match[2]];
      await this.adminHandler.showClientPeerDetails(ctx, peerName, telegramId);
    });

    // Переключение статуса конфига клиента
    this.bot.callbackQuery(/^admin_toggle_peer:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const [peerName, telegramId] = [ctx.match[1], ctx.match[2]];
      await this.adminHandler.toggleClientPeer(ctx, peerName, telegramId);
    });

    // Удаление конфига клиента
    this.bot.callbackQuery(/^admin_delete_peer:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, т.к. операция может занять время
      await ctx.answerCallbackQuery();
      const [peerName, telegramId] = [ctx.match[1], ctx.match[2]];
      await this.adminHandler.deleteClientPeer(ctx, peerName, telegramId);
    });

    // Изменение срока действия конфига
    this.bot.callbackQuery(/^admin_change_duration:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const [peerName, telegramId] = [ctx.match[1], ctx.match[2]];
      await this.adminHandler.showChangeDuration(ctx, peerName, telegramId);
    });

    // Установка нового срока действия
    this.bot.callbackQuery(
      /^admin_set_duration:(.+):(.+):(.+)$/,
      async (ctx) => {
        if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
          await ctx.answerCallbackQuery({
            text: 'Нет доступа',
            show_alert: true,
          });
          return;
        }
        // Сразу отвечаем, т.к. операция может занять время
        await ctx.answerCallbackQuery();
        const [peerName, telegramId, duration] = [
          ctx.match[1],
          ctx.match[2],
          ctx.match[3],
        ];
        await this.adminHandler.changePeerDuration(
          ctx,
          peerName,
          telegramId,
          duration,
        );
      },
    );

    // Редактирование описания конфига клиента
    this.bot.callbackQuery(
      /^admin_edit_description:(.+):(.+)$/,
      async (ctx) => {
        if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
          await ctx.answerCallbackQuery({
            text: 'Нет доступа',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery();
        const [peerName, telegramId] = [ctx.match[1], ctx.match[2]];
        await this.adminHandler.showEditDescriptionPrompt(
          ctx,
          peerName,
          telegramId,
        );
      },
    );

    // Отмена редактирования описания
    this.bot.callbackQuery(
      /^admin_cancel_edit_description:(.+):(.+)$/,
      async (ctx) => {
        if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
          await ctx.answerCallbackQuery({
            text: 'Нет доступа',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery();
        const [peerName, telegramId] = [ctx.match[1], ctx.match[2]];
        await this.adminHandler.cancelEditDescription(
          ctx,
          peerName,
          telegramId,
        );
      },
    );

    // Меню создания конфига для клиента (admin_cc = admin_create_config)
    this.bot.callbackQuery(/^admin_cc:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const telegramId = ctx.match[1];
      await this.adminHandler.showCreateConfigOptions(ctx, telegramId);
    });

    // Создать конфиг для клиента (admin_dc = admin_do_create, u = unlimited)
    this.bot.callbackQuery(/^admin_dc:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      // Сразу отвечаем, т.к. создание конфига может занять время
      await ctx.answerCallbackQuery();
      const [telegramId, duration] = [
        ctx.match[1],
        ctx.match[2] === 'u' ? 'unlimited' : ctx.match[2],
      ];
      await this.adminHandler.createClientConfig(ctx, telegramId, duration);
    });

    // Блокировка клиента
    this.bot.callbackQuery(/^admin_block:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const telegramId = ctx.match[1];
      await this.adminHandler.blockClient(ctx, telegramId);
    });

    // Разблокировка клиента
    this.bot.callbackQuery(/^admin_unblock:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      const telegramId = ctx.match[1];
      await this.adminHandler.unblockClient(ctx, telegramId);
    });
  }

  private startBot() {
    void this.runTelegramPolling().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Telegram: сбой запуска: ${msg}`, err);
    });
  }

  /** Сначала getMe (быстрая проверка токена и сети), затем long polling */
  private async runTelegramPolling() {
    this.logger.log('Telegram: проверка Bot API (getMe)…');
    try {
      const me = await this.bot.api.getMe();
      this.logger.log(`Telegram-бот подключён: @${me.username} (id ${me.id})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Telegram: getMe не выполнен (токен, сеть или api.telegram.org): ${msg}`,
        err,
      );
      return;
    }

    this.logger.log('Telegram: запуск long polling…');
    try {
      await this.bot.start({
        onStart: (botInfo) => {
          this.logger.warn(
            `Телеграм бот успешно запущен: @${botInfo.username}`,
          );
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Telegram-бот не запустился (polling): ${msg}`, err);
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
    this.mainMenuMessageAnchor.delete(telegramId);

    const message = await this.bot.api.sendDocument(
      telegramId,
      new InputFile(Buffer.from(config), `${peer.name}.conf`),
      {
        caption,
        parse_mode: 'Markdown',
        reply_markup: BotUi.configDeliveredKeyboard(),
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
  ) {
    try {
      this.mainHandler.invalidateMainMenuCache(telegramId);
      await this.dismissStaleMainMenuAnchor(telegramId, invoiceUi?.messageId);

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
  ) {
    try {
      this.mainHandler.invalidateMainMenuCache(telegramId);
      await this.dismissStaleMainMenuAnchor(telegramId, invoiceUi?.messageId);

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
