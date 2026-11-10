import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PeersService } from 'src/peers/peers.service';
import { SubscriptionService } from './subscription.service';
import { resolveSubscriptionFormat } from './interfaces/subscription-format.interface';

/**
 * Публичный эндпоинт (без ApiKeyGuard) — его дёргает сам VPN-клиент, а не бот.
 * Токен в URL — vlessUuid пира: он уже служит секретом аутентификации в самом
 * VLESS, отдельный секрет не заводим.
 */
@Controller('sub')
export class SubscriptionController {
  constructor(
    private readonly peersService: PeersService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Формат выбирается по User-Agent: клиентам на движке sing-box (Hiddify,
   * NekoBox, Karing) отдаём JSON — ссылки на этот URL у них уже выданы и
   * ломать их нельзя. Всем остальным — base64 со ссылками vless://, именно
   * его понимают v2rayNG, v2rayN, Streisand, Happ и прочие.
   */
  @Get(':uuid')
  async getSubscription(
    @Param('uuid') uuid: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const peer = await this.peersService.findPeerByVlessUuid(uuid);

    this.subscriptionService.applySubscriptionHeaders(res, peer);

    const resolvedFormat = resolveSubscriptionFormat(userAgent, format);

    if (resolvedFormat === 'xray') {
      res.json(this.subscriptionService.buildXrayConfigArray(peer));
      return;
    }

    if (resolvedFormat === 'singbox') {
      res.json(this.subscriptionService.buildSingBoxConfig(peer));
      return;
    }

    res.type('text/plain; charset=utf-8');
    res.send(this.subscriptionService.buildBase64Subscription(peer));
  }

  /** Полный конфиг (log+dns+inbounds) — для официальных sing-box-клиентов (SFA/SFI/SFM). */
  @Get(':uuid/full')
  async getFullSubscription(
    @Param('uuid') uuid: string,
    @Res() res: Response,
  ): Promise<void> {
    const peer = await this.peersService.findPeerByVlessUuid(uuid);
    this.subscriptionService.applySubscriptionHeaders(res, peer);
    res.json(this.subscriptionService.buildFullSingBoxConfig(peer));
  }
}
