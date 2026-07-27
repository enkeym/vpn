import { BadRequestException, Injectable } from '@nestjs/common';
import { WgService } from './wg.service';
import { AwgService } from './awg.service';
import type { ITunnelService, TVpnProtocol } from './tunnel.types';

/**
 * Единая точка доступа к туннелям: по протоколу пира отдаёт нужную реализацию.
 * Благодаря ей PeersService не ветвится на wg/awg в каждом методе.
 */
@Injectable()
export class TunnelRegistry {
  private readonly tunnels: ReadonlyMap<TVpnProtocol, ITunnelService>;

  constructor(wgService: WgService, awgService: AwgService) {
    this.tunnels = new Map<TVpnProtocol, ITunnelService>([
      [wgService.protocol, wgService],
      [awgService.protocol, awgService],
    ]);
  }

  get(protocol: TVpnProtocol): ITunnelService {
    const tunnel = this.tunnels.get(protocol);
    if (!tunnel) {
      throw new BadRequestException(`Неизвестный протокол: ${protocol}`);
    }
    return tunnel;
  }

  /** Туннель для выдачи нового конфига — с проверкой, что интерфейс поднят */
  getForNewPeer(protocol: TVpnProtocol): ITunnelService {
    const tunnel = this.get(protocol);
    if (!tunnel.isEnabled()) {
      throw new BadRequestException(
        'AmneziaWG сейчас недоступен на сервере. Создайте конфиг WireGuard.',
      );
    }
    return tunnel;
  }

  all(): ITunnelService[] {
    return [...this.tunnels.values()];
  }

  isEnabled(protocol: TVpnProtocol): boolean {
    return this.tunnels.get(protocol)?.isEnabled() ?? false;
  }
}
