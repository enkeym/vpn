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
import { PaymentService } from 'src/payment/payment.service';
import {
  PaymentFulfillmentService,
  type FulfillPaymentResult,
} from 'src/payment/payment-fulfillment.service';
import { BotUi } from './ui/bot.ui';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot;
  private readonly logger = new Logger(BotService.name);
  private adminIds: string[] = [];

  /** Повторный опрос ЮKassa не чаще (мс), пока есть незавершённые платежи */
  private readonly unsettledPollThrottleByUser = new Map<string, number>();
  private static readonly UNSETTLED_POLL_MIN_INTERVAL_MS = 8_000;

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

    // Подключение функционала
    this.bot = new Bot(token);
    this.registerMiddleware();
    this.registerCommands();
    this.registerFamilyCommands();
    this.registerAdminCommands();
    this.startBot();
  }

  private isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId);
  }

  private async syncUnsettledPayments(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    try {
      await this.paymentFulfillment.syncUnsettledForTelegramUser(
        String(ctx.from.id),
      );
    } catch (e) {
      this.logger.error('syncUnsettledPayments', e);
    }
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

  /** Счёт ЮKassa: новая покупка (30/60/90 дней) */
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

    await ctx.editMessageText(
      `💳 *Оплата*\n\n` +
        `Тариф: *${durationDays} дней*\n` +
        `Сумма: *${price} ₽*\n\n` +
        `Нажмите кнопку ниже — откроется ЮKassa. ` +
        `После успешной оплаты конфиг придёт в этот чат сам — уведомление придёт в Telegram, даже если вы ещё на странице банка.`,
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
            [{ text: '❌ Отмена', callback_data: 'main_menu' }],
          ],
        },
      },
    );

    const cq = ctx.callbackQuery;
    const msg = cq?.message;
    if (ctx.chat?.id != null && msg && 'message_id' in msg) {
      await this.paymentService.setInvoiceUiAnchor(
        payment.id,
        String(ctx.chat.id),
        msg.message_id,
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

    await ctx.editMessageText(
      `💳 *Оплата (продление)*\n\n` +
        `Тариф: *${durationDays} дней*\n` +
        `Сумма: *${price} ₽*\n\n` +
        `Нажмите кнопку ниже — откроется ЮKassa. ` +
        `После успешной оплаты срок конфига продлится автоматически, уведомление придёт в Telegram.`,
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
                text: '« Назад к тарифам',
                callback_data: `extend_pay_plans:${peerName}`,
              },
            ],
          ],
        },
      },
    );

    const cq = ctx.callbackQuery;
    const msg = cq?.message;
    if (ctx.chat?.id != null && msg && 'message_id' in msg) {
      await this.paymentService.setInvoiceUiAnchor(
        payment.id,
        String(ctx.chat.id),
        msg.message_id,
      );
    }
  }

  async onModuleDestroy() {
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

      if (this.isAdmin(userId)) {
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

      await this.maybePollUnsettledPayments(ctx);

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

  private registerCommands() {
    this.bot.command('start', async (ctx) => {
      await this.syncUnsettledPayments(ctx);
      await this.mainHandler.showMainMenu(ctx);
    });

    this.bot.callbackQuery('main_menu', async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
      } catch {
        // Уже отвечено в middleware (для не-админов)
      }
      await this.syncUnsettledPayments(ctx);
      await this.mainHandler.showMainMenu(ctx);
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
      try {
        const result = await this.paymentFulfillment.fulfillByYookassaId(
          yookassaId,
          String(ctx.from.id),
          { trustYooKassaSucceeded: false },
        );
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

  // Запуск бота (long polling). Ошибки до onStart не попадали в лог из-за void без .catch().
  private startBot() {
    this.logger.log('Telegram: запуск long polling…');
    void this.bot
      .start({
        onStart: (botInfo) => {
          this.logger.log(
            `Telegram-бот подключён: @${botInfo.username} (id ${botInfo.id})`,
          );
        },
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Telegram-бот не запустился: ${msg}`, err);
      });
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
      const header =
        `✅ *Оплата прошла успешно!* (${amount} ₽)\n\n` +
        `Ваш конфиг *${peer.name}* на *${durationDays} дней* готов. ` +
        `Файл — ниже.`;

      let headerDone = false;
      if (invoiceUi) {
        try {
          await this.bot.api.editMessageText(
            Number(invoiceUi.chatId),
            invoiceUi.messageId,
            header,
            {
              parse_mode: 'Markdown',
              reply_markup: BotUi.backToMenuKeyboard(),
              link_preview_options: { is_disabled: true },
            },
          );
          headerDone = true;
        } catch (e) {
          this.logger.warn(
            `Не удалось обновить сообщение со счётом: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
      if (!headerDone) {
        await this.bot.api.sendMessage(telegramId, header, {
          parse_mode: 'Markdown',
        });
      }

      const message = await this.bot.api.sendDocument(
        telegramId,
        new InputFile(Buffer.from(config), `${peer.name}.conf`),
        {
          caption: BotUi.configCreated(peer.name, peer.ip, peer.expiresAt),
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToMenuKeyboard(),
        },
      );

      await this.peersService.setConfigMessageId(peer.name, message.message_id);
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
      const header =
        `✅ *Продление прошло успешно!* (${amount} ₽)\n\n` +
        `Конфиг *${peer.name}* продлён на *${durationDays} дней*. ` +
        `Новый срок: до ${peer.expiresAt ? new Date(peer.expiresAt).toLocaleDateString('ru-RU') : '—'}. ` +
        `Файл — ниже.`;

      let headerDone = false;
      if (invoiceUi) {
        try {
          await this.bot.api.editMessageText(
            Number(invoiceUi.chatId),
            invoiceUi.messageId,
            header,
            {
              parse_mode: 'Markdown',
              reply_markup: BotUi.backToMenuKeyboard(),
              link_preview_options: { is_disabled: true },
            },
          );
          headerDone = true;
        } catch (e) {
          this.logger.warn(
            `Не удалось обновить сообщение со счётом: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
      if (!headerDone) {
        await this.bot.api.sendMessage(telegramId, header, {
          parse_mode: 'Markdown',
        });
      }

      const message = await this.bot.api.sendDocument(
        telegramId,
        new InputFile(Buffer.from(config), `${peer.name}.conf`),
        {
          caption: BotUi.configCreated(peer.name, peer.ip, peer.expiresAt),
          parse_mode: 'Markdown',
          reply_markup: BotUi.backToMenuKeyboard(),
        },
      );

      await this.peersService.setConfigMessageId(peer.name, message.message_id);
    } catch (error) {
      this.logger.error(
        `Error notifying user ${telegramId} about extend success`,
        error,
      );
    }
  }
}
