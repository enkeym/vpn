import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, GrammyError, HttpError } from 'grammy';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot;
  private readonly logger = new Logger(BotService.name);
  private allowedIds: string[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly mainHandler: MainHandler,
    private readonly peerCreateHandler: PeerCreateHandler,
    private readonly peerDeleteHandler: PeerDeleteHandler,
    private readonly peerManageHandler: PeerManageHandler,
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
    this.allowedIds = whiteList
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    // Подключение функционала
    this.bot = new Bot(token);
    this.registerMiddleware();
    this.registerCommands();
    this.startBot();
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

    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;

      const userId = String(ctx.from.id);
      if (this.allowedIds.length > 0 && !this.allowedIds.includes(userId)) {
        this.logger.warn(
          `Попытка несанкционированного доступа от ID: ${userId} (${ctx.from.username})`,
        );
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

    // Создание конфига
    this.bot.callbackQuery('create_config', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.peerCreateHandler.handleCreateConfig(ctx);
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
