import { Controller, Get, Param } from '@nestjs/common';
import { PeersService } from 'src/peers/peers.service';
import { SubscriptionService } from './subscription.service';

/**
 * Публичный эндпоинт (без ApiKeyGuard) — его дёргает сам VPN-клиент
 * (Hiddify/NekoBox), а не бот. Токен в URL — vlessUuid пира: он уже служит
 * секретом аутентификации в самом VLESS, отдельный секрет не заводим.
 */
@Controller('sub')
export class SubscriptionController {
  constructor(
    private readonly peersService: PeersService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  @Get(':uuid')
  async getSubscription(@Param('uuid') uuid: string) {
    const peer = await this.peersService.findPeerByVlessUuid(uuid);
    return this.subscriptionService.buildSingBoxConfig(peer);
  }

  /** Полный конфиг (log+dns+inbounds) — для официальных sing-box-клиентов (SFA/SFI/SFM). */
  @Get(':uuid/full')
  async getFullSubscription(@Param('uuid') uuid: string) {
    const peer = await this.peersService.findPeerByVlessUuid(uuid);
    return this.subscriptionService.buildFullSingBoxConfig(peer);
  }
}
