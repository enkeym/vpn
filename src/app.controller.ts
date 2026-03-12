import { Controller, Get, UseGuards } from '@nestjs/common';
import { InternalGuard } from './common/guards/internal.guard';
import { AppService } from './app.service';
import { CacheService, CacheStats } from './common/cache/cache.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly cacheService: CacheService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Эндпоинт для мониторинга здоровья и метрик приложения.
   * Доступ: localhost или X-Internal-Key (если задан INTERNAL_METRICS_KEY)
   */
  @Get('health')
  @UseGuards(InternalGuard)
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB',
      },
    };
  }

  /**
   * Эндпоинт для просмотра статистики кеша.
   * Доступ: localhost или X-Internal-Key (если задан INTERNAL_METRICS_KEY)
   */
  @Get('metrics/cache')
  @UseGuards(InternalGuard)
  getCacheMetrics(): {
    timestamp: string;
    cache: Record<string, CacheStats> | CacheStats | null;
  } {
    return {
      timestamp: new Date().toISOString(),
      cache: this.cacheService.getStats(),
    };
  }
}
