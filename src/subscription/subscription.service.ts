import {
  Injectable,
  InternalServerErrorException,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Response } from 'express';
import { XRAY_REALITY_FLOW, XrayService } from 'src/xray/xray.service';
import type { IXrayPublicParams } from 'src/xray/xray.service';
import { HysteriaService } from 'src/hysteria/hysteria.service';
import type { IHysteriaPublicParams } from 'src/hysteria/hysteria.service';
import type { TPeerSelect } from 'src/peers/peers.service';
import type { TSubscriptionFormat } from './interfaces/subscription-format.interface';

/** Минимальный набор полей пира для сборки любого формата подписки. */
export type TSubscriptionPeer = Pick<TPeerSelect, 'name' | 'vlessUuid'>;

const DNS_REMOTE_TAG = 'dns-remote';
const DNS_BOOTSTRAP_TAG = 'dns-bootstrap';
const DNS_SERVER = '1.1.1.1';

/** DNS Xray-профилей: резолвим прямо, без DoH-петли вокруг туннеля. */
const XRAY_JSON_DNS_SERVERS = ['1.1.1.1', '1.0.0.1'];

@Injectable()
export class SubscriptionService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionService.name);

  private readonly dialHosts = new Map<string, string>();

  async onModuleInit(): Promise<void> {
    const hosts = new Set<string>();
    const xrayHost = this.xrayService.getPublicParams().host;
    if (xrayHost) hosts.add(xrayHost);
    const hysteriaHost = this.hysteriaService.getPublicParams().host;
    if (hysteriaHost) hosts.add(hysteriaHost);

    await Promise.all(
      [...hosts].map(async (host) => {
        if (isIP(host)) {
          this.dialHosts.set(host, host);
          return;
        }
        try {
          const [ip] = await resolve4(host);
          if (ip) this.dialHosts.set(host, ip);
        } catch {
          this.logger.warn(
            `Не удалось разрешить ${host} в IP — sing-box будет резолвить его на клиенте`,
          );
        }
      }),
    );
  }

  private dialHost(host: string): string {
    return this.dialHosts.get(host) ?? host;
  }
  /**
   * Публичный HTTPS-адрес приложения (reverse proxy на PORT). Без него
   * /sub/<uuid> снаружи недоступен, поэтому бот показывает только прямые
   * ссылки — не выдаём заведомо нерабочую ссылку-подписку.
   */
  private readonly publicBaseUrl = (process.env.SUB_PUBLIC_URL || '').replace(
    /\/+$/,
    '',
  );

  constructor(
    private readonly xrayService: XrayService,
    private readonly hysteriaService: HysteriaService,
  ) {}

  /** Ссылка-подписка для импорта одним URL; null — SUB_PUBLIC_URL не задан. */
  buildSubscriptionUrl(
    peer: TSubscriptionPeer,
    format?: TSubscriptionFormat,
  ): string | null {
    if (!this.publicBaseUrl || !peer.vlessUuid) return null;
    const query = format ? `?format=${format}` : '';
    return `${this.publicBaseUrl}/sub/${peer.vlessUuid}${query}`;
  }

  /**
   * Универсальный формат подписки: ссылки через перевод строки, всё вместе
   * в base64. Понимают v2rayNG, v2rayN, v2RayTun, Streisand, V2Box, Shadowrocket,
   * Happ, Karing — то есть все клиенты, кроме тех, что хотят sing-box JSON.
   */
  buildBase64Subscription(peer: TSubscriptionPeer): string {
    return Buffer.from(this.buildShareLinks(peer).join('\n'), 'utf-8').toString(
      'base64',
    );
  }

  /** Ссылки vless:// на каналы пира — для ручного импорта и для base64. */
  buildShareLinks(peer: TSubscriptionPeer): string[] {
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }

    const links = this.xrayService.buildShareLinks(peer.name, peer.vlessUuid);
    const hysteriaLink = this.hysteriaService.buildShareLink(peer.name);

    return hysteriaLink ? [...links, hysteriaLink] : links;
  }

  /**
   * Массив готовых Xray-конфигов (формат Happ/Streisand/V2Box): единственный
   * канал Reality напрямую, без Cloudflare.
   */
  buildXrayConfigArray(
    peer: TSubscriptionPeer,
  ): Array<Record<string, unknown>> {
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }

    const uuid = peer.vlessUuid;
    const xray = this.xrayService.getPublicParams();

    return [
      {
        remarks: 'Reality',
        dns: {
          servers: XRAY_JSON_DNS_SERVERS,
          queryStrategy: 'UseIP',
        },
        outbounds: [
          this.buildXrayRealityOutbound(xray, uuid),
          { tag: 'direct', protocol: 'freedom' },
          { tag: 'block', protocol: 'blackhole' },
        ],
        routing: {
          domainStrategy: 'IPIfNonMatch',
          rules: [
            { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
            { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
          ],
        },
      },
    ];
  }

  private buildXrayRealityOutbound(
    xray: IXrayPublicParams,
    uuid: string,
  ): Record<string, unknown> {
    if (!xray.host)
      throw new InternalServerErrorException('Не настроен Reality-канал Xray');
    return {
      tag: 'proxy-reality',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: this.dialHost(xray.host),
            port: xray.realityPort,
            users: [{ id: uuid, encryption: 'none', flow: XRAY_REALITY_FLOW }],
          },
        ],
      },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          serverName: xray.realitySni,
          fingerprint: 'chrome',
          publicKey: xray.realityPublicKey,
          shortId: xray.realityShortId,
        },
        sockopt: {
          domainStrategy: 'UseIPv4',
        },
      },
    };
  }

  /**
   * Стандартные заголовки подписки. Их читают Happ, Streisand, v2rayN, Hiddify:
   * пользователь видит срок и трафик прямо в приложении, не заходя в бот.
   */
  applySubscriptionHeaders(res: Response, peer: TPeerSelect): void {
    // total=0 — безлимит по трафику; expire в секундах Unix, 0 — бессрочно.
    const expire = peer.expiresAt
      ? Math.floor(peer.expiresAt.getTime() / 1000)
      : 0;

    res.setHeader(
      'Subscription-Userinfo',
      `upload=${peer.txBytes}; download=${peer.rxBytes}; total=0; expire=${expire}`,
    );
    // Через сколько часов клиенту перечитать подписку.
    res.setHeader('Profile-Update-Interval', '12');
    res.setHeader(
      'Profile-Title',
      `base64:${Buffer.from(peer.name, 'utf-8').toString('base64')}`,
    );
  }

  buildSingBoxConfig(peer: TSubscriptionPeer): Record<string, unknown> {
    return this.buildSubscriptionConfig(peer, false);
  }

  private buildSubscriptionConfig(
    peer: TSubscriptionPeer,
    includeDnsReferences: boolean,
  ): Record<string, unknown> {
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }

    const xray = this.xrayService.getPublicParams();
    if (!xray.host) {
      throw new InternalServerErrorException(
        'Для sing-box требуется настроенный Reality-канал',
      );
    }
    // Дуалстек: у сервера есть исходящий IPv6, поэтому назначения резолвятся
    // и в A, и в AAAA (IPv4 первым — он предсказуемее по маршрутам). При
    // XRAY_IPV6=false остаётся прежнее «только IPv4»: без исходящего IPv6
    // домены с AAAA отваливались с dial tcp6 unreachable.
    const domainStrategy = xray.ipv6 ? 'prefer_ipv4' : 'ipv4_only';
    const realityTag = `Reality · ${xray.host}`;

    const channelTags: string[] = [];

    const outbounds: Record<string, unknown>[] = [
      {
        type: 'vless',
        tag: realityTag,
        ...(includeDnsReferences
          ? {
              domain_resolver: {
                server: DNS_BOOTSTRAP_TAG,
                strategy: domainStrategy,
              },
            }
          : {}),
        server: this.dialHost(xray.host),
        server_port: xray.realityPort,
        uuid: peer.vlessUuid,
        flow: XRAY_REALITY_FLOW,
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
    ];
    channelTags.push(realityTag);

    const hysteria: IHysteriaPublicParams =
      this.hysteriaService.getPublicParams();
    const hysteriaPassword = this.hysteriaService.getPassword(peer.name);
    if (this.hysteriaService.isShareLinkEnabled() && hysteriaPassword) {
      const hysteriaTag = `Hysteria2 · ${hysteria.host}`;
      outbounds.push({
        type: 'hysteria2',
        tag: hysteriaTag,
        ...(includeDnsReferences
          ? {
              domain_resolver: {
                server: DNS_BOOTSTRAP_TAG,
                strategy: domainStrategy,
              },
            }
          : {}),
        server: this.dialHost(hysteria.host),
        server_port: hysteria.port,
        password: `${peer.name}:${hysteriaPassword}`,
        ...(hysteria.obfsPassword
          ? {
              obfs: {
                type: 'salamander',
                password: hysteria.obfsPassword,
              },
            }
          : {}),
        tls: {
          enabled: true,
          server_name: hysteria.sni,
        },
      });
      channelTags.push(hysteriaTag);
    }

    if (channelTags.length > 1) {
      outbounds.push({
        type: 'urltest',
        tag: 'select',
        outbounds: channelTags,
        url: 'https://www.gstatic.com/generate_204',
        interval: '3m',
        tolerance: 150,
        interrupt_exist_connections: true,
      });
    } else {
      outbounds.push({
        type: 'selector',
        tag: 'select',
        outbounds: channelTags,
        default: channelTags[0],
        interrupt_exist_connections: true,
      });
    }

    return {
      outbounds,
      // DNS в ту же стратегию, что и outbound'ы: с IPv6 спрашиваем и AAAA,
      // без него — только A (иначе домены с AAAA тянут за собой IPv6-коннекты,
      // которым некуда идти). Дублирует domain_strategy на каждом outbound —
      // на случай прямого импорта конфига в NekoBox без опций Hiddify.
      dns: {
        servers: [
          {
            type: 'https',
            tag: DNS_REMOTE_TAG,
            server: DNS_SERVER,
            detour: 'select',
          },
          { type: 'https', tag: DNS_BOOTSTRAP_TAG, server: DNS_SERVER },
        ],
        final: DNS_REMOTE_TAG,
        strategy: domainStrategy,
      },
      route: {
        // RU-сплит (прямой выход мимо VPN для обхода Яндекс-капчи) убран:
        // клиентское приложение (Hiddify) пуляет в общий пул автовыбора все
        // объявленные outbound'ы конфига, включая служебные — прямой выход
        // без прокси оказывался "самым быстрым" по его собственному health-
        // check'у и периодически становился основным каналом для ВСЕГО
        // трафика, а не только RU-доменов. Надёжность важнее обхода капчи.
        rules: [
          // action:reject + method:drop — пакет отбрасывается без открытия
          // сокета. С outbound:'block' (blackhole) для UDP-пакетов на
          // Android это падало с "listen packet connection ... operation
          // not permitted" (VPN-песочница не даёт открыть packet-listener).
          // Приватные/локальные сети режем всегда — защита от утечки в LAN
          // клиента и во внутреннюю сеть сервера.
          { ip_is_private: true, action: 'reject', method: 'drop' },
          // Полный блок IPv6-назначений остаётся ТОЛЬКО при выключенном
          // IPv6: раньше он был вторым рубежом к ipv4_only, теперь IPv6
          // маршрутизируется штатно и глушить его нельзя.
          ...(xray.ipv6
            ? []
            : [{ ip_cidr: ['::/0'], action: 'reject', method: 'drop' }]),
          // Блокируем QUIC (HTTP/3, UDP 443): YouTube и Google-поиск первым
          // делом пробуют его, и если UDP через туннель теряется/душится
          // оператором, страница висит вместо отката на TCP. С drop клиент
          // мгновенно откатывается на HTTP/2 — симптом «Telegram работает,
          // YouTube и поиск зависают». Правило по network+port, без sniff.
          { network: 'udp', port: [443], action: 'reject', method: 'drop' },
        ],
        final: 'select',
        auto_detect_interface: true,
        // sing-box 1.12+: резолвинг домена при дозвоне до outbound'а (server:
        // xray.domain и т.п.) больше не берётся неявно из dns.final — нужна
        // явная ссылка на тег DNS-сервера, иначе deprecation-предупреждение
        // (удалят в 1.14). Используем тот же сервер, что и dns.final.
        ...(includeDnsReferences
          ? { default_domain_resolver: DNS_REMOTE_TAG }
          : {}),
      },
    };
  }

  /**
   * Полный sing-box-конфиг для официальных клиентов sing-box (SFA/SFI/SFM).
   * В отличие от Hiddify/NekoBox, они не достраивают TUN/DNS сами вокруг
   * подписки — нужен самодостаточный конфиг, поэтому добавлены log/dns/
   * inbounds поверх тех же outbounds+route.
   */
  buildFullSingBoxConfig(peer: TSubscriptionPeer): Record<string, unknown> {
    const base = this.buildSubscriptionConfig(peer, true);
    const ipv6 = this.xrayService.getPublicParams().ipv6;

    return {
      log: { level: 'warning', timestamp: true },
      dns: base.dns,
      inbounds: [
        {
          type: 'tun',
          tag: 'tun-in',
          // Второй адрес — ULA IPv6: без него у интерфейса нет IPv6-адреса и
          // система не отдаёт в туннель ни одного IPv6-пакета, сколько бы
          // AAAA ни резолвилось. Добавляется только при включённом IPv6.
          address: ipv6
            ? ['172.19.0.1/28', 'fdfe:dcba:9876::1/126']
            : ['172.19.0.1/28'],
          auto_route: true,
          strict_route: false,
          // gVisor вместо system/mixed: системный стек на многих сетях молча
          // роняет пакеты крупнее MTU реального аплинка (картинки зависают,
          // мелкий HTML — нет), т.к. sing-box не делает PMTUD и полагается на
          // ядро ОС. gVisor сам фрагментирует/пересобирает в userspace и не
          // зависит от этого — с ним воспроизводимо чинится тот же симптом
          // в Hiddify. mtu ниже реального аплинка (обычно 1500) — запас под
          // WS/TLS/Reality-заголовки поверх TCP/IP.
          stack: 'gvisor',
          mtu: 1400,
          // sniff на инбаунде — legacy-поле (sing-box 1.11+ deprecated,
          // удалено в 1.13, см. migration guide). Не переносим в route
          // rule action: маршрутизация у нас только по IP (ip_is_private/
          // ip_cidr), sniff по домену для неё не нужен.
        },
      ],
      outbounds: base.outbounds,
      route: base.route,
    };
  }
}
