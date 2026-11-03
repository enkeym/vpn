import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { Response } from 'express';
import { XRAY_REALITY_FLOW, XrayService } from 'src/xray/xray.service';
import type { TPeerSelect } from 'src/peers/peers.service';

/** Минимальный набор полей пира для сборки любого формата подписки. */
export type TSubscriptionPeer = Pick<TPeerSelect, 'name' | 'vlessUuid'>;

/** Теги каналов — фигурируют и в outbound'ах, и в группах авто-выбора. */
const CDN_TAG = 'cdn-wifi';
const REALITY_TAG = 'reality-direct';

/**
 * Собирает подписку в двух форматах поверх двух независимых каналов обхода:
 * 1. VLESS+WS+TLS через Cloudflare CDN — обходит блокировку по IP сервера
 *    (актуально для домашних сетей), но зависит от доступности Cloudflare.
 *    Канала нет, если XRAY_DOMAIN не задан (см. XrayService).
 * 2. VLESS+Reality — прямой TCP на IP сервера, без CDN и без WS-хендшейка,
 *    работает там, где режут именно CDN (часть мобильных операторов).
 *
 * sing-box-клиент (Hiddify, NekoBox) сам тестирует оба и держит активным
 * рабочий, переключаясь автоматически при обрыве — без участия пользователя.
 * Остальные клиенты получают те же каналы ссылками vless:// в base64.
 *
 * Третий канал — AmneziaWG (.conf для AmneziaVPN) — живёт отдельно и в
 * подписку не входит: у него свой клиент и свой формат.
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

    // Дуалстек: у сервера есть исходящий IPv6, поэтому назначения резолвятся
    // и в A, и в AAAA (IPv4 первым — он предсказуемее по маршрутам). При
    // XRAY_IPV6=false остаётся прежнее «только IPv4»: без исходящего IPv6
    // домены с AAAA отваливались с dial tcp6 unreachable.
    const domainStrategy = xray.ipv6 ? 'prefer_ipv4' : 'ipv4_only';

    const outbounds: Record<string, unknown>[] = [];
    const channelTags: string[] = [];

    if (xray.domain) {
      outbounds.push({
        type: 'vless',
        tag: CDN_TAG,
        domain_strategy: domainStrategy,
        server: xray.domain,
        server_port: xray.realityPort,
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
      });
      channelTags.push(CDN_TAG);
    }

    outbounds.push({
      type: 'vless',
      tag: REALITY_TAG,
      domain_strategy: domainStrategy,
      server: xray.host,
      server_port: xray.realityPort,
      uuid: peer.vlessUuid,
      // XTLS Vision — обязан совпадать с инбаундом сервера и прямой
      // vless://-ссылкой (см. XRAY_REALITY_FLOW).
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
    });
    channelTags.push(REALITY_TAG);

    outbounds.push(
      {
        type: 'urltest',
        tag: 'auto',
        // ВАЖНО: плоская группа, без вложенности. Раньше пробовали разбить
        // на вложенные urltest-группы — сломало автопереключение: внешняя
        // группа мерила ТЕКУЩИЙ выбор внутренней в момент замера, и если он
        // совпадал с упавшим каналом, внешняя тоже считала всю внутреннюю
        // группу мёртвой и зависала, вместо того чтобы дать живому каналу
        // шанс — на проде реально был случай, когда один канал упал, а
        // автопереключения на живой не произошло, пришлось выбирать вручную.
        outbounds: channelTags,
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
        outbounds: ['auto', ...channelTags],
        default: 'auto',
        // Тут interrupt оправдан: это осознанный выбор пользователя (или
        // смена default), а не шумный автотест — переключаемся мгновенно.
        interrupt_exist_connections: true,
      },
    );

    return {
      outbounds,
      // DNS в ту же стратегию, что и outbound'ы: с IPv6 спрашиваем и AAAA,
      // без него — только A (иначе домены с AAAA тянут за собой IPv6-коннекты,
      // которым некуда идти). Дублирует domain_strategy на каждом outbound —
      // на случай прямого импорта конфига в NekoBox без опций Hiddify.
      dns: {
        // DoH вместо открытого DNS: системный DNS оператора травит наш домен
        // (доказано — ручная смена DNS на телефоне всё чинит), а plain DNS по
        // порту 53 душат по DPI. DoH идёт как обычный HTTPS и такой фильтрации
        // не поддаётся, поэтому системный DNS телефона больше не важен.
        //
        // БЕЗ detour: резолвинг идёт через route.final ('select' → 'auto'),
        // то есть через актуально живой канал. Жёсткая привязка DoH к одному
        // каналу (detour) недопустима — если этот канал деградирует, повиснет
        // весь резолвинг разом. 1.1.1.1 — IP, сам DoH-сервер резолвить не надо.
        servers: [{ type: 'https', tag: 'dns-remote', server: '1.1.1.1' }],
        final: 'dns-remote',
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
