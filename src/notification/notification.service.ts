import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Api } from 'grammy';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private api: Api | null = null;
  private adminIds: string[] = [];

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
   * Отправить сообщение всем админам
   */
  async notifyAdmins(message: string): Promise<void> {
    if (!this.api || this.adminIds.length === 0) {
      this.logger.warn('Невозможно отправить уведомление: нет API или админов');
      return;
    }

    for (const adminId of this.adminIds) {
      try {
        await this.api.sendMessage(adminId, message, {
          parse_mode: 'Markdown',
        });
        this.logger.log(`Уведомление отправлено админу ${adminId}`);
      } catch (error) {
        this.logger.error(
          `Ошибка отправки уведомления админу ${adminId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /**
   * Отправить критическое уведомление (с эмодзи предупреждения)
   */
  async notifyCriticalError(
    title: string,
    details: string,
    attempts?: number,
  ): Promise<void> {
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

    await this.notifyAdmins(message);
  }
}
