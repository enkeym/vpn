import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, GrammyError, HttpError } from 'grammy';
import { FamilyService } from 'src/family/family.service';
import { PeersService } from 'src/peers/peers.service';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';
import { FamilyHandler } from './handlers/family.handler';
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
    private readonly familyService: FamilyService,
    private readonly peersService: PeersService,
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
    this.bot.catch((err) => {
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
    });

    // Middleware проверки доступа: админы и члены группы "Семья"
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;

      const userId = String(ctx.from.id);
      const username = ctx.from.username;

      // Проверяем, является ли админом
      if (this.isAdmin(userId)) {
        await next();
        return;
      }

      // Проверяем, является ли членом группы "Семья"
      const isFamilyMember = await this.familyService.isMember(
        userId,
        username,
      );
      if (isFamilyMember) {
        // Привязываем telegramId если был добавлен по username
        if (username) {
          await this.familyService.bindTelegramId(username, userId);
        }
        await next();
        return;
      }

      // Доступ запрещен
      this.logger.warn(
        `Попытка несанкционированного доступа от ID: ${userId} (${username})`,
      );
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

      await next();
    });
  }

  private registerCommands() {
    // Команды
    this.bot.command('start', async (ctx) =>
      this.mainHandler.showMainMenu(ctx),
    );

    // Меню и навигация
    this.bot.callbackQuery('main_menu', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.mainHandler.showMainMenu(ctx);
    });

    // Показать меню создания конфига
    this.bot.callbackQuery('show_create_options', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerCreateHandler.showCreateOptions(ctx);
    });

    // Создание конфига с выбором длительности
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
      await this.peerManageHandler.showPeerDetails(ctx, peerName);
    });

    // Пауза/Старт
    this.bot.callbackQuery(/^toggle_peer:(.+)$/, async (ctx) => {
      const peerName = ctx.match[1];
      await this.peerManageHandler.togglePeer(ctx, peerName);
    });

    // Удаление пира
    this.bot.callbackQuery(/^delete_peer:(.+)$/, async (ctx) => {
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

    // Просмотр члена группы
    this.bot.callbackQuery(/^family_member:(.+)$/, async (ctx) => {
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

    // Список конфигов члена группы
    this.bot.callbackQuery(/^family_member_configs:(.+)$/, async (ctx) => {
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

    // Просмотр конфига члена группы
    this.bot.callbackQuery(/^family_peer:(.+):(.+)$/, async (ctx) => {
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

    // Переключение статуса конфига члена группы
    this.bot.callbackQuery(/^family_toggle_peer:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.toggleMemberPeer(ctx, peerName, memberId);
    });

    // Удаление конфига члена группы
    this.bot.callbackQuery(/^family_delete_peer:(.+):(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      const [peerName, memberId] = [ctx.match[1], ctx.match[2]];
      await this.familyHandler.deleteMemberPeer(ctx, peerName, memberId);
    });

    // Изменение срока действия конфига
    this.bot.callbackQuery(
      /^family_change_duration:(.+):(.+)$/,
      async (ctx) => {
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
      },
    );

    // Установка нового срока действия
    this.bot.callbackQuery(
      /^family_set_duration:(.+):(.+):(.+)$/,
      async (ctx) => {
        if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
          await ctx.answerCallbackQuery({
            text: 'Нет доступа',
            show_alert: true,
          });
          return;
        }
        const [peerName, memberId, duration] = [
          ctx.match[1],
          ctx.match[2],
          ctx.match[3],
        ];
        await this.familyHandler.changePeerDuration(
          ctx,
          peerName,
          memberId,
          duration,
        );
      },
    );

    // Удаление члена из группы
    this.bot.callbackQuery(/^family_remove:(.+)$/, async (ctx) => {
      if (!ctx.from || !this.isAdmin(String(ctx.from.id))) {
        await ctx.answerCallbackQuery({
          text: 'Нет доступа',
          show_alert: true,
        });
        return;
      }
      const memberId = ctx.match[1];
      await this.familyHandler.removeMember(ctx, memberId);
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
