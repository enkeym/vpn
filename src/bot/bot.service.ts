import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, GrammyError, HttpError } from 'grammy';
import { PeersService } from 'src/peers/peers.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot;
  private readonly logger = new Logger(BotService.name);
  private allowedIds: string[] = [];

  constructor(
    private readonly configService: ConfigService,
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
    this.allowedIds = whiteList
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    // Создание бота
    this.bot = new Bot(token);

    // Обработка ошибок
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

    // Проверка доступа
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;

      const userId = String(ctx.from.id);

      if (this.allowedIds.length > 0 && !this.allowedIds.includes(userId)) {
        this.logger.warn(
          `Попытка несанкционированного доступа от ID: ${userId} (${ctx.from.username})`,
        );
        await ctx.reply(
          '*Доступ запрещен.* Проверьте настройки листа доступа.',
          { parse_mode: 'Markdown' },
        );
        return;
      }

      await next();
    });

    // this.registerCommands();

    void this.bot.start({
      onStart: (botInfo) => {
        this.logger.warn(`Бот @${botInfo.username} успешно запущен!`);
      },
    });
  }

  async onModuleDestroy() {
    if (this.bot) {
      await this.bot.stop();
    }
  }
}
