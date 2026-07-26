import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { Response } from 'express';
import { XrayService } from 'src/xray/xray.service';
import type { TPeerSelect } from 'src/peers/peers.service';

/** Минимальный набор полей пира для сборки любого формата подписки. */
export type TSubscriptionPeer = Pick<TPeerSelect, 'name' | 'vlessUuid'>;

/**
 * Собирает подписку в двух форматах поверх двух независимых каналов обхода:
 * 1. VLESS+WS+TLS через Cloudflare CDN — обходит блокировку по IP сервера
 *    (актуально для домашних сетей), но зависит от доступности Cloudflare.
 * 2. VLESS+Reality — прямой TCP на IP сервера, без CDN и без WS-хендшейка,
 *    работает там, где режут именно CDN (часть мобильных операторов).
 *
 * sing-box-клиент (Hiddify, NekoBox) сам тестирует оба и держит активным
 * рабочий, переключаясь автоматически при обрыве — без участия пользователя.
 * Остальные клиенты получают те же каналы ссылками vless:// в base64.
 */
@Injectable()
export class SubscriptionService {
  constructor(private readonly xrayService: XrayService) {}

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

  /** Ссылки vless:// на все каналы пира — для ручного импорта и для base64. */
  buildShareLinks(peer: TSubscriptionPeer): string[] {
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }

    return this.xrayService.buildShareLinks(peer.name, peer.vlessUuid);
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
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }

    const xray = this.xrayService.getPublicParams();

    return {
      outbounds: [
        {
          type: 'vless',
          tag: 'cdn-wifi',
          // Резолвим назначение только в IPv4: у VPS нет исходящего IPv6,
          // домены с AAAA-записью иначе отваливаются (dial tcp6 unreachable).
          domain_strategy: 'ipv4_only',
          // TCP Fast Open — меньше round-trip'ов на новый хендшейк после
          // смены сети (Wi-Fi↔мобильный). Требует поддержки и на сервере.
          tcp_fast_open: true,
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
            // uTLS-отпечаток Chrome — чтобы DPI не отличал наш ClientHello от
            // обычного браузера (Reality уже маскируется, WS-канал — нет).
            utls: { enabled: true, fingerprint: 'chrome' },
          },
        },
        {
          type: 'vless',
          tag: 'reality-direct',
          domain_strategy: 'ipv4_only',
          tcp_fast_open: true,
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
          type: 'urltest',
          tag: 'auto',
          // ВАЖНО: плоская группа, без вложенности. Раньше пробовали разбить
          // на auto-direct (hysteria/reality) + auto (auto-direct/cdn-wifi) —
          // сломало автопереключение: внешняя группа мерила ТЕКУЩИЙ выбор
          // внутренней в момент замера, и если он совпадал с упавшим каналом,
          // внешняя группа тоже считала весь auto-direct мёртвым и зависала,
          // вместо того чтобы дать reality-direct шанс — на проде реально был
          // случай, когда Hysteria2 упала, а автопереключения на живой
          // reality-direct не произошло, пришлось выбирать вручную.
          outbounds: ['cdn-wifi', 'reality-direct'],
          url: 'https://www.gstatic.com/generate_204',
          // Короче, чем раньше (было 1m): быстрее ловим момент, когда канал
          // ожил/умер после смены сети (Wi-Fi↔мобильный).
          interval: '30s',
          // Порог переключения поднят с 50 до 250 мс: обычный шум измерения
          // пинга (десятки мс) не должен считаться "новым лучшим" каналом —
          // именно из-за этого шума на 150мс живые соединения периодически
          // обрывались каждый цикл ре-теста без единой реальной поломки канала.
          tolerance: 250,
          // Не держим тест простаивающего канала бесконечно.
          idle_timeout: '15m',
          // НЕ ставим interrupt_exist_connections здесь: ре-тест раз в 30с —
          // шумный процесс сам по себе (пинг колеблется), а не сигнал о
          // реальном обрыве. С interrupt=true каждое такое дрожание рвало
          // все активные соединения (видео, загрузки) — то самое "сеть
          // обрывается сама по себе", хотя канал был живой всё время.
          // Новые соединения и так пойдут через актуально лучший outbound —
          // этого достаточно, старые просто доживают на своём канале.
        },
        {
          type: 'selector',
          tag: 'select',
          outbounds: ['auto', 'cdn-wifi', 'reality-direct'],
          default: 'auto',
          // Тут interrupt оправдан: это осознанный выбор пользователя (или
          // смена default), а не шумный автотест — переключаемся мгновенно.
          interrupt_exist_connections: true,
        },
      ],
      // DNS только по IPv4: домены с AAAA иначе тянут за собой IPv6-коннекты
      // (у VPS нет исходящего IPv6). Дублирует ipv4_only на каждом outbound —
      // на случай прямого импорта конфига в NekoBox без опций Hiddify.
      dns: {
        // sing-box 1.12+: короткая форма address (со схемой в строке) —
        // legacy, deprecated (удалят в 1.14). Новый формат — явные type+server.
        servers: [
          { type: 'tcp', tag: 'dns-remote', server: '8.8.8.8' },
          { type: 'udp', tag: 'dns-direct', server: '1.1.1.1' },
        ],
        final: 'dns-remote',
        strategy: 'ipv4_only',
      },
      route: {
        // RU-сплит (прямой выход мимо VPN для обхода Яндекс-капчи) убран:
        // клиентское приложение (Hiddify) пуляет в общий пул автовыбора все
        // объявленные outbound'ы конфига, включая служебные — прямой выход
        // без прокси оказывался "самым быстрым" по его собственному health-
        // check'у и периодически становился основным каналом для ВСЕГО
        // трафика, а не только RU-доменов. Надёжность важнее обхода капчи.
        // Защита от утечек: приватные/локальные сети и любое IPv6-назначение
        // уводим в blackhole. Основной путь и так ipv4_only — это второй рубеж
        // (особенно для NekoBox без ipv6-mode из опций Hiddify).
        rules: [
          // action:reject + method:drop — пакет отбрасывается без открытия
          // сокета. С outbound:'block' (blackhole) для UDP-пакетов на
          // Android это падало с "listen packet connection ... operation
          // not permitted" (VPN-песочница не даёт открыть packet-listener).
          { ip_is_private: true, action: 'reject', method: 'drop' },
          { ip_cidr: ['::/0'], action: 'reject', method: 'drop' },
        ],
        final: 'select',
        auto_detect_interface: true,
        // sing-box 1.12+: резолвинг домена при дозвоне до outbound'а (server:
        // xray.domain и т.п.) больше не берётся неявно из dns.final — нужна
        // явная ссылка на тег DNS-сервера, иначе deprecation-предупреждение
        // (удалят в 1.14). Используем тот же сервер, что и dns.final.
        default_domain_resolver: 'dns-remote',
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
    const base = this.buildSingBoxConfig(peer);

    return {
      log: { level: 'warning', timestamp: true },
      dns: base.dns,
      inbounds: [
        {
          type: 'tun',
          tag: 'tun-in',
          // Только IPv4: у VPS нет исходящего IPv6 (см. domain_strategy на
          // outbound'ах) — TUN-адрес с IPv6 только сбивал бы клиента с толку.
          address: ['172.19.0.1/28'],
          auto_route: true,
          strict_route: false,
          stack: 'mixed',
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
