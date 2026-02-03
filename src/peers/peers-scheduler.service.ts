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
}
