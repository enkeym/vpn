import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { XrayService } from 'src/xray/xray.service';
import { HysteriaService } from 'src/hysteria/hysteria.service';
import type { TPeerSelect } from 'src/peers/peers.service';

/**
 * Собирает sing-box-конфиг с тремя outbound'ами под urltest-группой — три
 * независимых механизма обхода блокировок, у каждого свой профиль:
 * 1. VLESS+WS+TLS через Cloudflare CDN — обходит блокировку по IP сервера
 *    (актуально для домашних сетей), но зависит от доступности Cloudflare.
 * 2. VLESS+Reality — прямой TCP на IP сервера, без CDN и без WS-хендшейка,
 *    работает там, где режут именно CDN (часть мобильных операторов).
 * 3. Прямой Hysteria2 (UDP/QUIC) — тоже без CDN, отдельный протокол на
 *    случай, если конкретная сеть режет TCP, но не UDP (или наоборот).
 * sing-box-клиент (Hiddify, NekoBox) сам тестирует все три и держит активным
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
          type: 'vless',
          tag: 'reality-direct',
          server: xray.host,
          server_port: xray.realityPort,
          uuid: peer.vlessUuid,
          tls: {
            enabled: true,
            server_name: xray.realitySni,
            utls: { enabled: true, fingerprint: 'chrome' },
            reality: {
              enabled: true,
              public_key: xray.realityPublicKey,
              short_id: xray.realityShortId,
            },
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
          outbounds: ['cdn-wifi', 'reality-direct', 'direct-mobile'],
          url: 'https://www.gstatic.com/generate_204',
          interval: '1m',
          tolerance: 50,
          // Сразу переключает уже открытые соединения на новый лучший
          // outbound вместо того, чтобы ждать, пока старые закроются сами —
          // без этого клиент мог "залипать" на канале, переставшем работать
          // после смены сети (Wi-Fi↔мобильный), до следующего цикла проверки.
          interrupt_exist_connections: true,
        },
        {
          type: 'selector',
          tag: 'select',
          outbounds: ['auto', 'cdn-wifi', 'reality-direct', 'direct-mobile'],
          default: 'auto',
          interrupt_exist_connections: true,
        },
      ],
      route: {
        final: 'select',
        auto_detect_interface: true,
      },
    };
  }
}
