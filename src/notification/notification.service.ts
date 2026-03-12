import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Api } from 'grammy';

interface NotificationResult {
  adminId: string;
  success: boolean;
  error?: string;
}

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private api: Api | null = null;
  private adminIds: string[] = [];

  // Настройки rate limiting
  private readonly MAX_CONCURRENT_SENDS = 5;
  private readonly RETRY_DELAY_MS = 1000;
  private readonly MAX_RETRIES = 2;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN не задан. Уведомления админам недоступны.',
      );
      return;
    }

    this.api = new Api(token);

    const whiteList = this.configService.get<string>(
      'TELEGRAM_ALLOWED_IDS',
      '',
    );
    this.adminIds = whiteList
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    this.logger.log(
      `NotificationService инициализирован. Админов: ${this.adminIds.length}`,
    );
  }

  /**
   * Отправить сообщение одному админу с retry
   */
  private async sendToAdmin(
    adminId: string,
    message: string,
    retries = 0,
  ): Promise<NotificationResult> {
    try {
      await this.api!.sendMessage(adminId, message, {
        parse_mode: 'Markdown',
      });
      return { adminId, success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Retry при временных ошибках
      if (retries < this.MAX_RETRIES && this.isRetryableError(error)) {
        this.logger.warn(
          `Retry отправки админу ${adminId} (попытка ${retries + 1}/${this.MAX_RETRIES})`,
        );
        await this.sleep(this.RETRY_DELAY_MS * (retries + 1));
        return this.sendToAdmin(adminId, message, retries + 1);
      }

      this.logger.error(
        `Ошибка отправки уведомления админу ${adminId}: ${errorMessage}`,
      );
      return { adminId, success: false, error: errorMessage };
    }
  }

  /**
   * Проверка, можно ли повторить запрос
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('429') || // Too Many Requests
        message.includes('503') || // Service Unavailable
        message.includes('504') // Gateway Timeout
      );
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Отправить сообщение всем админам ПАРАЛЛЕЛЬНО
   * с ограничением на количество одновременных запросов
   */
  async notifyAdmins(message: string): Promise<NotificationResult[]> {
    if (!this.api || this.adminIds.length === 0) {
      this.logger.warn('Невозможно отправить уведомление: нет API или админов');
      return [];
    }

    const results: NotificationResult[] = [];

    // Разбиваем на батчи для ограничения параллельных запросов
    for (let i = 0; i < this.adminIds.length; i += this.MAX_CONCURRENT_SENDS) {
      const batch = this.adminIds.slice(i, i + this.MAX_CONCURRENT_SENDS);

      const batchResults = await Promise.all(
        batch.map((adminId) => this.sendToAdmin(adminId, message)),
      );

      results.push(...batchResults);

      // Небольшая пауза между батчами для соблюдения rate limits Telegram
      if (i + this.MAX_CONCURRENT_SENDS < this.adminIds.length) {
        await this.sleep(100);
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    if (failCount > 0) {
      this.logger.warn(
        `Уведомления: успешно ${successCount}, ошибок ${failCount}`,
      );
    } else {
      this.logger.log(`Уведомления отправлены всем ${successCount} админам`);
    }

    return results;
  }

  /**
   * Отправить критическое уведомление (с эмодзи предупреждения)
   */
  async notifyCriticalError(
    title: string,
    details: string,
    attempts?: number,
  ): Promise<NotificationResult[]> {
    const message = [
      `🚨 *КРИТИЧЕСКАЯ ОШИБКА*`,
      ``,
      `*${title}*`,
      ``,
      details,
      attempts !== undefined ? `\n_Попыток: ${attempts}_` : '',
      ``,
      `⏰ ${new Date().toLocaleString('ru-RU')}`,
    ]
      .filter(Boolean)
      .join('\n');

    return this.notifyAdmins(message);
  }

  /**
   * Отправить информационное уведомление
   */
  async notifyInfo(title: string, details: string): Promise<NotificationResult[]> {
    const message = [
      `ℹ️ *${title}*`,
      ``,
      details,
      ``,
      `⏰ ${new Date().toLocaleString('ru-RU')}`,
    ].join('\n');

    return this.notifyAdmins(message);
  }

  /**
   * Отправить уведомление конкретному пользователю (по Telegram ID)
   */
  async notifyUser(
    telegramId: string,
    title: string,
    details: string,
  ): Promise<boolean> {
    if (!this.api) {
      this.logger.warn(
        `Невозможно отправить уведомление пользователю ${telegramId}: Telegram API не инициализировано`,
      );
      return false;
    }

    try {
      const message = [
        `📅 *${title}*`,
        ``,
        details,
        ``,
        `⏰ ${new Date().toLocaleString('ru-RU')}`,
      ].join('\n');

      await this.api.sendMessage(telegramId, message, {
        parse_mode: 'Markdown',
      });

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Ошибка отправки уведомления пользователю ${telegramId}: ${errorMessage}`,
      );
      return false;
    }
  }

  /**
   * Получить статистику (для мониторинга)
   */
  getStats() {
    return {
      configured: this.api !== null,
      adminCount: this.adminIds.length,
    };
  }
}
