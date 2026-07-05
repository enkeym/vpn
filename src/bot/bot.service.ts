import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, GrammyError, HttpError } from 'grammy';
import { BlockedUsersService } from 'src/blocked/blocked.service';
import { FamilyHandler } from './handlers/family.handler';
import { AdminHandler } from './handlers/admin.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { TPeer } from 'src/peers/peers.service';
import { InvoiceService } from './invoice/invoice.service';
import { MainMenuService } from './menu/main-menu.service';
import { UserCommandsRegistrar } from './registrars/user-commands.registrar';
import { FamilyCommandsRegistrar } from './registrars/family-commands.registrar';
import { AdminCommandsRegistrar } from './registrars/admin-commands.registrar';
import { isForwardedMessage } from './utils/forwarded-message';

/**
 * Оркестратор Telegram-бота: создаёт инстанс grammy, настраивает middleware
 * доступа и обработку текстового ввода, делегирует регистрацию команд
 * специализированным registrar'ам, запускает long polling.
 */
@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot;
  private readonly logger = new Logger(BotService.name);
  private adminIds: string[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly blockedUsersService: BlockedUsersService,
    private readonly familyHandler: FamilyHandler,
    private readonly adminHandler: AdminHandler,
    private readonly peerManageHandler: PeerManageHandler,
    private readonly invoiceService: InvoiceService,
    private readonly mainMenuService: MainMenuService,
    private readonly userCommandsRegistrar: UserCommandsRegistrar,
    private readonly familyCommandsRegistrar: FamilyCommandsRegistrar,
    private readonly adminCommandsRegistrar: AdminCommandsRegistrar,
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

    this.invoiceService.attach(this.bot);
    this.mainMenuService.attach(this.bot);

    this.registerMiddleware();

    const isAdmin = (userId: string): boolean => this.isAdmin(userId);
    this.userCommandsRegistrar.register(this.bot, isAdmin);
    this.familyCommandsRegistrar.register(this.bot, isAdmin);
    this.adminCommandsRegistrar.register(this.bot, isAdmin);

    this.startBot();
  }

  async onModuleDestroy() {
    this.invoiceService.stopAllPolling();
    if (this.bot) {
      await this.bot.stop();
    }
  }

  private isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId);
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
      const postPayReturn = this.invoiceService.isPostYookassaReturnStart(ctx);

      if (this.isAdmin(userId)) {
        if (postPayReturn) {
          this.invoiceService.resetUnsettledPollThrottle(userId);
          await this.invoiceService.syncUnsettledPayments(ctx);
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
        this.invoiceService.resetUnsettledPollThrottle(userId);
        await this.invoiceService.syncUnsettledPayments(ctx);
      } else {
        await this.invoiceService.maybePollUnsettledPayments(ctx);
      }

      await next();
    });

    // Пересланные сообщения при добавлении в группу (в т.ч. без текста: стикер, фото и т.д.)
    this.bot.on('message', async (ctx, next) => {
      if (!ctx.from || !ctx.message) return next();
      const userId = String(ctx.from.id);

      // Проверка добавления в группу семьи
      if (this.isAdmin(userId) && this.familyHandler.isAwaitingInput(userId)) {
        if (isForwardedMessage(ctx.message)) {
          await this.familyHandler.handleAddMemberInput(ctx);
          return;
        }
      }

      // Проверка поиска клиента
      if (
        this.isAdmin(userId) &&
        this.adminHandler.isAwaitingClientSearch(userId)
      ) {
        if (isForwardedMessage(ctx.message)) {
          await this.adminHandler.handleSearchInput(ctx);
          return;
        }
      }

      return next();
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

      // Если админ ожидает ввода текста рассылки
      if (
        this.isAdmin(userId) &&
        this.adminHandler.isAwaitingBroadcastMessage(userId)
      ) {
        await this.adminHandler.handleBroadcastInput(ctx);
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

  /** Уведомление об успешной оплате и отправка конфига (вызывается из PaymentFulfillmentService) */
  async notifyPaymentSuccess(
    telegramId: string,
    config: string,
    peer: TPeer,
    durationDays: number,
    amount: number,
    invoiceUi?: { chatId: string; messageId: number },
  ): Promise<void> {
    await this.invoiceService.notifyPaymentSuccess(
      telegramId,
      config,
      peer,
      durationDays,
      amount,
      invoiceUi,
    );
  }

  /** Уведомление об успешном продлении конфига (вызывается из PaymentFulfillmentService) */
  async notifyExtendSuccess(
    telegramId: string,
    config: string,
    peer: TPeer,
    durationDays: number,
    amount: number,
    invoiceUi?: { chatId: string; messageId: number },
  ): Promise<void> {
    await this.invoiceService.notifyExtendSuccess(
      telegramId,
      config,
      peer,
      durationDays,
      amount,
      invoiceUi,
    );
  }
}
