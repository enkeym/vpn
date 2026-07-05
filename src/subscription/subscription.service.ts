import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { XrayService } from 'src/xray/xray.service';
import { HysteriaService } from 'src/hysteria/hysteria.service';
import type { TPeerSelect } from 'src/peers/peers.service';

/**
 * Собирает sing-box-конфиг с двумя outbound'ами под urltest-группой:
 * VLESS+WS+TLS через Cloudflare CDN (обходит блокировку по IP сервера —
 * актуально для домашних сетей) и прямой Hysteria2 (обходит блокировку
 * самого Cloudflare — актуально для части мобильных операторов).
 * sing-box-клиент (Hiddify, NekoBox) сам тестирует оба и держит активным
 * рабочий, переключаясь автоматически при обрыве — без участия пользователя.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly xrayService: XrayService,
    private readonly hysteriaService: HysteriaService,
  ) {}

  buildSingBoxConfig(
    peer: Pick<TPeerSelect, 'name' | 'vlessUuid' | 'hysteriaPassword'>,
  ): Record<string, unknown> {
    if (!peer.vlessUuid || !peer.hysteriaPassword) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid/hysteriaPassword`,
      );
    }

    const xray = this.xrayService.getPublicParams();
    const hysteria = this.hysteriaService.getPublicParams();

    return {
      outbounds: [
        {
          type: 'vless',
          tag: 'cdn-wifi',
          server: xray.domain,
          server_port: xray.port,
          uuid: peer.vlessUuid,
          transport: {
            type: 'ws',
            path: xray.wsPath,
            headers: { Host: xray.domain },
          },
          tls: {
            enabled: true,
            server_name: xray.domain,
          },
        },
        {
          type: 'hysteria2',
          tag: 'direct-mobile',
          server: hysteria.host,
          server_port: hysteria.port,
          // Hysteria2 userpass-авторизация — сервер ждёт "имя:пароль" одной строкой.
          password: `${peer.name}:${peer.hysteriaPassword}`,
          obfs: {
            type: 'salamander',
            password: hysteria.obfsPassword,
          },
          tls: {
            enabled: true,
            insecure: true,
            server_name: hysteria.host,
          },
        },
        {
          type: 'urltest',
          tag: 'auto',
          outbounds: ['cdn-wifi', 'direct-mobile'],
          url: 'https://www.gstatic.com/generate_204',
          interval: '1m',
          tolerance: 50,
        },
        {
          type: 'selector',
          tag: 'select',
          outbounds: ['auto', 'cdn-wifi', 'direct-mobile'],
          default: 'auto',
        },
      ],
      route: {
        final: 'select',
        auto_detect_interface: true,
      },
    };
  }
}
