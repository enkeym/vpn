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
          // Резолвим назначение только в IPv4: у VPS нет исходящего IPv6,
          // домены с AAAA-записью иначе отваливаются (dial tcp6 unreachable).
          domain_strategy: 'ipv4_only',
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
          domain_strategy: 'ipv4_only',
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
          // Проверяем канал раз в минуту — «мёртвый» сервер отваливается
          // максимум за минуту, а не висит зомби до ручного переключения.
          interval: '1m',
          // Порог переключения поднят с 50 до 150 мс: не даём auto «прыгать»
          // между почти равными каналами и рвать живые соединения на ровном месте.
          tolerance: 150,
          // Не держим тест простаивающего канала бесконечно.
          idle_timeout: '15m',
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
        // Прямой выход в интернет с реального IP клиента (мимо VPS).
        // Прямой выход резолвит назначение сам (через DNS клиента/Hiddify) —
        // без domain_strategy, иначе прямой путь к RU-сайтам не резолвится.
        { type: 'direct', tag: 'direct-out' },
      ],
      route: {
        rules: [
          {
            // Российский трафик уходит напрямую, мимо туннеля: зарубежный
            // exit-IP VPS ловит SmartCaptcha Яндекса и блокировки на RU-сайтах.
            // domain_suffix работает на любой версии sing-box и покрывает
            // ключевые домены, даже если rule_set ниже не успел скачаться.
            domain_suffix: [
              'yandex.ru',
              'yandex.net',
              'yandex.com',
              'ya.ru',
              'yastatic.net',
              'yandex.st',
              'mail.ru',
              'dzen.ru',
              'kinopoisk.ru',
              'vk.com',
              'vk.ru',
              'ok.ru',
              'gosuslugi.ru',
              'avito.ru',
              'ozon.ru',
              'wildberries.ru',
            ],
            outbound: 'direct-out',
          },
          // Полное покрытие «всего российского трафика» — по гео-спискам
          // (все домены категории RU + российские IP-диапазоны).
          { rule_set: ['geosite-ru', 'geoip-ru'], outbound: 'direct-out' },
        ],
        rule_set: [
          {
            type: 'remote',
            tag: 'geosite-ru',
            format: 'binary',
            url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs',
            // Скачиваем гео-списки через сам туннель — github в RU нестабилен.
            download_detour: 'select',
          },
          {
            type: 'remote',
            tag: 'geoip-ru',
            format: 'binary',
            url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs',
            download_detour: 'select',
          },
        ],
        // Всё нероссийское — как раньше, через выбранный канал (auto/WS/Reality/Hysteria).
        final: 'select',
        auto_detect_interface: true,
      },
    };
  }
}
