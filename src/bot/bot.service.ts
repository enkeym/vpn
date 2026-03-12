import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, GrammyError, HttpError } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { PeersService } from 'src/peers/peers.service';
import { BlockedUsersService } from 'src/blocked/blocked.service';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';
import { FamilyHandler } from './handlers/family.handler';
import { AdminHandler } from './handlers/admin.handler';
import { BotUi } from './ui/bot.ui';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot;
  private readonly logger = new Logger(BotService.name);
  private adminIds: string[] = [];

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
  ) {}

  onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.error('TELEGRAM_BOT_TOKEN не задан. Бот не запущен.');
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
        // Отвечаем на callback query, чтобы кнопка не зависала
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
      const username = ctx.from.username;

      // Проверяем, является ли админом
      if (this.isAdmin(userId)) {
        await next();
        return;
      }

      // Проверяем, заблокирован ли пользователь
      const isBlocked = await this.blockedUsersService.isBlocked(userId);
      if (isBlocked) {
        this.logger.warn(
          `Заблокированный пользователь пытается получить доступ: ${userId} (${username})`,
        );
        // Отвечаем на callback query, чтобы кнопка не зависала
        if (ctx.callbackQuery) {
          try {
            await ctx.answerCallbackQuery({
              text: 'Вы заблокированы',
              show_alert: true,
            });
          } catch {
            // Игнорируем
          }
        }
        return;
      }

      // Все остальные пользователи тоже получают доступ (оплата через меню при создании конфига)
      await next();
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
    this.bot.command('start', async (ctx) =>
      this.mainHandler.showMainMenu(ctx),
    );

    this.bot.callbackQuery('main_menu', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.mainHandler.showMainMenu(ctx);
    });

    this.bot.callbackQuery('create_trial_config', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerCreateHandler.handleCreateTrialConfig(ctx);
    });

    this.bot.callbackQuery('show_create_options', async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const userType = await this.mainHandler.getUserType(String(ctx.from.id));
      if (userType === 'user') {
        await this.peerCreateHandler.showPaymentPlans(ctx);
      } else {
        await this.peerCreateHandler.showCreateOptions(ctx);
      }
    });

    this.bot.callbackQuery(/^pay_plan:(30|60|90)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const days = Number(ctx.match[1]) as 30 | 60 | 90;
      await this.peerCreateHandler.showPaymentConfirm(ctx, days);
    });

    this.bot.callbackQuery(/^pay_confirm:(30|60|90)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Оплата прошла успешно!' });
      const durationDays = Number(ctx.match[1]) as 30 | 60 | 90;
      await ctx.editMessageText(BotUi.paymentSuccessTitle, {
        parse_mode: 'Markdown',
      });
      await this.peerCreateHandler.handleCreateConfig(ctx, durationDays);
    });

    this.bot.callbackQuery(/^create_config:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const duration = ctx.match[1];
      const durationDays =
        duration === 'unlimited'
          ? undefined
          : (Number(duration) as 30 | 60 | 90);
      await this.peerCreateHandler.handleCreateConfig(ctx, durationDays);
    });

    // Список конфигов
    this.bot.callbackQuery('list_configs', async (ctx) => {
      await ctx.answerCallbackQuery();
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
      await this.peerDeleteHandler.deletePeer(ctx, peerName);
    });

    // Продление конфига (пока просто уведомление)
    this.bot.callbackQuery(/^extend_peer:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({
        text: '🚧 Функция продления скоро будет доступна',
        show_alert: true,
      });
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
      const isAdmin = ctx.from ? this.isAdmin(String(ctx.from.id)) : false;
      await this.peerManageHandler.showPeerDetailsReply(ctx, peerName, isAdmin);
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

  // Запуск бота
  private startBot() {
    void this.bot.start({
      onStart: (botInfo) => {
        this.logger.warn(`Бот @${botInfo.username} успешно запущен!`);
      },
    });
  }
}
