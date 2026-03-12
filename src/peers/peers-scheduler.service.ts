import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PeersService } from './peers.service';

@Injectable()
export class PeersSchedulerService {
  private readonly logger = new Logger(PeersSchedulerService.name);

  constructor(private readonly peersService: PeersService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleExpiredPeers() {
    this.logger.log('Запуск проверки истекших конфигов...');

    try {
      const deactivatedCount = await this.peersService.deactivateExpiredPeers();

      if (deactivatedCount > 0) {
        this.logger.log(`Деактивировано конфигов: ${deactivatedCount}`);
      } else {
        this.logger.log('Истекших конфигов не найдено');
      }
    } catch (error) {
      this.logger.error(
        `Ошибка при деактивации конфигов: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Раз в месяц удаляем конфиги, которые на паузе больше месяца */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async handlePeersPausedOverMonth() {
    this.logger.log(
      'Запуск проверки конфигов на паузе более месяца...',
    );

    try {
      const deletedCount =
        await this.peersService.deletePeersPausedOverMonth();

      if (deletedCount > 0) {
        this.logger.log(
          `Удалено конфигов (на паузе > месяца): ${deletedCount}`,
        );
      } else {
        this.logger.log(
          'Конфигов на паузе более месяца не найдено',
        );
      }
    } catch (error) {
      this.logger.error(
        `Ошибка при удалении конфигов на паузе: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Раз в день уведомляем пользователей о том, что конфиги скоро истекут (за 1 день) */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async handleExpiringSoonNotifications() {
    this.logger.log(
      'Запуск отправки уведомлений о скором истечении срока действия конфигов...',
    );

    try {
      const notifiedCount = await this.peersService.notifyExpiringPeers(1);

      if (notifiedCount > 0) {
        this.logger.log(
          `Отправлено уведомлений о скором истечении срока действия: ${notifiedCount}`,
        );
      } else {
        this.logger.log('Конфигов, истекающих через 1 день, не найдено');
      }
    } catch (error) {
      this.logger.error(
        `Ошибка при отправке уведомлений о скором истечении: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
