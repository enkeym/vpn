import {
  Controller,
  Get,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InternalGuard } from './common/guards/internal.guard';
import { AppService } from './app.service';
import { CacheService, CacheStats } from './common/cache/cache.service';
import { AwgService } from './wg/awg.service';
import { XrayService } from './xray/xray.service';

export interface IHealthResponse {
  status: 'ok';
  vpn: { awg: boolean; xray: boolean };
  timestamp: string;
  uptime: number;
  memory: { used: number; total: number; unit: 'MB' };
}

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly cacheService: CacheService,
    private readonly awg: AwgService,
    private readonly xray: XrayService,
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
  async getHealth(): Promise<IHealthResponse> {
    const [awg, xray] = await Promise.all([
      this.awg.isHealthy(),
      this.xray.isHealthy(),
    ]);
    if (!awg || !xray) {
      throw new ServiceUnavailableException(
        `VPN недоступен: AmneziaWG=${awg ? 'ok' : 'down'}, Xray=${xray ? 'ok' : 'down'}`,
      );
    }
    return {
      status: 'ok',
      vpn: { awg, xray },
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
