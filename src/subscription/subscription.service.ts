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
          // ВАЖНО: плоская группа, без вложенности. Раньше пробовали разбить
          // на auto-direct (hysteria/reality) + auto (auto-direct/cdn-wifi) —
          // сломало автопереключение: внешняя группа мерила ТЕКУЩИЙ выбор
          // внутренней в момент замера, и если он совпадал с упавшим каналом,
          // внешняя группа тоже считала весь auto-direct мёртвым и зависала,
          // вместо того чтобы дать reality-direct шанс — на проде реально был
          // случай, когда Hysteria2 упала, а автопереключения на живой
          // reality-direct не произошло, пришлось выбирать вручную.
          outbounds: ['cdn-wifi', 'reality-direct', 'direct-mobile'],
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
          outbounds: ['auto', 'cdn-wifi', 'reality-direct', 'direct-mobile'],
          default: 'auto',
          // Тут interrupt оправдан: это осознанный выбор пользователя (или
          // смена default), а не шумный автотест — переключаемся мгновенно.
          interrupt_exist_connections: true,
        },
      ],
      route: {
        // RU-сплит (прямой выход мимо VPN для обхода Яндекс-капчи) убран:
        // клиентское приложение (Hiddify) пуляет в общий пул автовыбора все
        // объявленные outbound'ы конфига, включая служебные — прямой выход
        // без прокси оказывался "самым быстрым" по его собственному health-
        // check'у и периодически становился основным каналом для ВСЕГО
        // трафика, а не только RU-доменов. Надёжность важнее обхода капчи.
        final: 'select',
        auto_detect_interface: true,
      },
    };
  }
}
