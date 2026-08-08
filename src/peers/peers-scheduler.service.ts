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

  /** Раз в день обновляем runtime-статистику AmneziaWG */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handlePeerTrafficStats() {
    this.logger.log('Запуск обновления статистики трафика конфигов...');

    try {
      const updatedCount = await this.peersService.refreshPeerTrafficStats();

      this.logger.log(`Обновлена статистика трафика конфигов: ${updatedCount}`);
    } catch (error) {
      this.logger.error(
        `Ошибка при обновлении статистики трафика: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Раз в день обрабатываем активные конфиги без трафика */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async handleInactiveActivePeers() {
    this.logger.log('Запуск проверки активных конфигов без трафика...');

    try {
      const result = await this.peersService.handleInactiveActivePeers();

      this.logger.log(
        `Неактивные активные конфиги: уведомлено платных=${result.paidNotified}, уведомлено бессрочных=${result.unlimitedNotified}, поставлено на паузу=${result.unlimitedPaused}`,
      );
    } catch (error) {
      this.logger.error(
        `Ошибка при обработке активных конфигов без трафика: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Раз в день удаляем паузные конфиги по retention policy */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handlePeersRetentionCleanup() {
    this.logger.log('Запуск удаления конфигов по retention policy...');

    try {
      const deletedCount =
        await this.peersService.deletePeersByRetentionPolicy();

      if (deletedCount > 0) {
        this.logger.log(
          `Удалено конфигов по retention policy: ${deletedCount}`,
        );
      } else {
        this.logger.log('Конфигов для удаления по retention policy не найдено');
      }
    } catch (error) {
      this.logger.error(
        `Ошибка при удалении конфигов по retention policy: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Раз в день уведомляем пользователей о том, что конфиги скоро истекут (за 1 день) */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
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
