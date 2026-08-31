import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import { exec, execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Mutex } from 'async-mutex';

const execAsync = promisify(exec);
/**
 * Для вызовов с подставляемыми значениями (email пира, пути) — только execFile:
 * аргументы уходят массивом, без разбора шеллом.
 */
const execFileAsync = promisify(execFile);

/**
 * Пауза коалесцирования перезапуска: серия изменений пиров (массовое
 * продление/удаление) сливается в ОДИН перезапуск Xray вместо N подряд —
 * меньше обрывов активных соединений.
 */
const RELOAD_DEBOUNCE_MS = 1500;

/**
 * XTLS Vision для Reality-канала. Значение должно совпадать в трёх местах:
 * инбаунд сервера, прямая vless://-ссылка и sing-box-подписка
 * (SubscriptionService) — при рассогласовании клиент не подключится вообще.
 */
export const XRAY_REALITY_FLOW = 'xtls-rprx-vision';

/** Клиент VLESS: имя пира и его UUID (vlessUuid из БД). */
export interface IXrayClient {
  name: string;
  uuid: string;
}

interface IXrayInboundClient {
  id: string;
  /** Ключ статистики трафика в StatsService (user>>>{email}>>>traffic>>>...). */
  email: string;
  /** Только для Reality (TCP): XTLS Vision. На WS-инбаунде flow не поддерживается. */
  flow?: string;
}

/**
 * Путь WS-эндпоинта — генерируется один раз и хранится в
 * configs/xray-ws.json, чтобы переживать рестарт (как параметры обфускации awg0).
 */
interface IXrayWsParams {
  wsPath: string;
}

/**
 * Постоянные параметры Reality-инбаунда (прямой TCP, без CDN). Приватный
 * ключ x25519 живёт только на сервере, публичный (pbk) и shortId раздаются
 * клиентам в vless://-ссылке. Хранятся в configs/xray-reality.json.
 */
interface IXrayRealityParams {
  privateKey: string;
  publicKey: string;
  shortId: string;
}

/**
 * Логин и пароль SOCKS5-инбаунда для Telegram. Хранятся в
 * configs/xray-socks.json: пара уезжает клиенту прямо в tg://socks-ссылке,
 * и после рестарта она обязана остаться прежней — иначе выданные ссылки умрут.
 */
interface IXraySocksParams {
  user: string;
  pass: string;
}

/** Готовая к выдаче пользователю ссылка на SOCKS5-прокси для Telegram */
export interface ITelegramProxyLink {
  /** https://t.me/socks?… — по клику Telegram сам открывает диалог подключения */
  shareUrl: string;
  /** tg://socks?… — та же ссылка схемой приложения, на случай ручного копирования */
  deepLink: string;
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * Сети Telegram — единственное, куда выпускается SOCKS-инбаунд. Пароль на нём
 * один на всех (как раньше секрет mtg), то есть рано или поздно утечёт; с этим
 * списком утёкшая ссылка остаётся бесполезной для всего, кроме мессенджера, и
 * сервер не превращается в открытый релей.
 *
 * Явные CIDR, а не geoip:telegram — по той же причине, что и в блокировке
 * приватных сетей ниже: отсутствующая в geoip.dat категория роняет загрузку
 * конфига целиком, то есть прокси для мессенджера утащил бы за собой VLESS.
 * Список официальных подсетей Telegram меняется раз в несколько лет.
 */
const TELEGRAM_NETS = [
  '91.108.4.0/22',
  '91.108.8.0/22',
  '91.108.12.0/22',
  '91.108.16.0/22',
  '91.108.20.0/22',
  '91.108.56.0/22',
  '149.154.160.0/20',
  '185.76.151.0/24',
  '2001:67c:4e8::/48',
  '2001:b28:f23c::/48',
  '2001:b28:f23d::/48',
  '2001:b28:f23f::/48',
  '2a0a:f280::/32',
];

/** Публичные параметры каналов — из них SubscriptionService собирает outbound'ы. */
export interface IXrayPublicParams {
  /** null — домен не задан, CDN-канал выключен (остаётся только Reality). */
  domain: string | null;
  port: number;
  wsPath: string;
  host: string;
  realityPort: number;
  realityPublicKey: string;
  realityShortId: string;
  realitySni: string;
  /** Разрешён ли IPv6 наружу — см. XRAY_IPV6. */
  ipv6: boolean;
}

/**
 * Управляет процессом Xray-core — второй канал доступа рядом с AmneziaWG
 * (awg0). Пир получает и .conf для AmneziaVPN, и VLESS-ссылки: протоколы
 * блокируются по-разному, и клиент выбирает то, что живо на его сети.
 *
 * Два независимых пути обхода внутри самого Xray:
 *
 * 1. VLESS+WS+TLS за Cloudflare CDN. TLS терминирует reverse-proxy на хосте
 *    (порт XRAY_PORT), а сюда WS доезжает обычным HTTP на localhost —
 *    сам Xray наружу этим инбаундом не смотрит. Клиент никогда не видит
 *    реальный IP сервера, но канал зависит от доступности Cloudflare.
 *    Выключается автоматически, если XRAY_DOMAIN не задан.
 * 2. VLESS+Reality — прямой TCP на реальный IP сервера, без CDN и без WS.
 *    Слушает XRAY_REALITY_PORT напрямую (контейнер в network_mode: host,
 *    nginx перед Xray в этой ветке нет — см. README).
 *
 * Плюс SOCKS5-инбаунд для Telegram (XRAY_SOCKS_ENABLED) — не путь обхода для
 * всего трафика, а замена MTProto-прокси: мессенджер подключает его сам, без
 * VPN-клиента. Выход с него разрешён только в сети Telegram.
 */
@Injectable()
export class XrayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XrayService.name);

  /** Теги инбаундов, в которых живут VLESS-клиенты (см. buildServerConfig). */
  private static readonly CLIENT_INBOUND_TAGS = ['ws-cdn', 'reality-direct'];

  private readonly wsParamsPath = path.join(
    process.cwd(),
    '/configs/xray-ws.json',
  );
  private readonly realityParamsPath = path.join(
    process.cwd(),
    '/configs/xray-reality.json',
  );
  private readonly socksParamsPath = path.join(
    process.cwd(),
    '/configs/xray-socks.json',
  );
  private readonly configPath = path.join(process.cwd(), '/configs/xray.json');

  /**
   * Внешний порт CDN-канала: его слушает reverse-proxy на хосте, а не Xray.
   * Значение уходит только в ссылки и в URL подписки.
   */
  public readonly port = Number(process.env.XRAY_PORT || 443);
  /** Внутренний порт WS-инбаунда — только localhost, наружу его отдаёт хостовый прокси. */
  private readonly internalWsPort = Number(
    process.env.XRAY_INTERNAL_WS_PORT || 8880,
  );
  /**
   * Порт Reality — публичный и он же слушающий: контейнер работает в
   * network_mode: host и Xray биндится на него напрямую. По умолчанию 443,
   * потому что Xray сам предупреждает при старте («REALITY: Listening on
   * non-443 ports may get your IP blocked by the GFW»): TLS на нестандартном
   * порту для DPI — самостоятельный маркер. Если 443 на хосте занят, порт
   * меняется здесь, и то же значение уезжает клиентам в ссылке.
   */
  public readonly realityPort = Number(process.env.XRAY_REALITY_PORT || 443);
  /**
   * Внутренний порт Reality — используется, только когда перед Xray стоит
   * nginx-разводчик (см. behindProxy). Не 8443: там в network_mode: host живёт
   * SOCKS5-прокси для Telegram, а localhost контейнера — это localhost хоста.
   */
  private readonly internalRealityPort = Number(
    process.env.XRAY_INTERNAL_REALITY_PORT || 8444,
  );
  /** Внутренний порт StatsService API — только localhost, наружу не публикуется. */
  private readonly statsApiPort = Number(
    process.env.XRAY_STATS_API_PORT || 8881,
  );
  /**
   * SOCKS5-прокси для Telegram — третий канал, заменивший MTProto (mtg).
   * Выключен по умолчанию: инбаунд смотрит наружу, и порт надо открыть в
   * фаерволе руками (network_mode: host).
   */
  private readonly socksEnabled = process.env.XRAY_SOCKS_ENABLED === 'true';
  /** Публичный порт SOCKS5. 8443 — тот же, что раньше слушал mtg. */
  private readonly socksPort = Number(process.env.XRAY_SOCKS_PORT || 8443);
  /** Пусто — CDN-канал (WS+TLS) не поднимается, остаётся только Reality. */
  private readonly domain = process.env.XRAY_DOMAIN || null;
  /** Адрес сервера в прямой Reality-ссылке. Общий с AmneziaWG (WG_HOST). */
  private readonly host = process.env.XRAY_HOST || process.env.WG_HOST || '';
  private readonly realityDest =
    process.env.XRAY_REALITY_DEST || 'www.wikipedia.org:443';
  private readonly realitySni =
    process.env.XRAY_REALITY_SNI || 'www.wikipedia.org';
  /**
   * IPv6 наружу. На сервере он есть, поэтому по умолчанию включён: без него
   * Xray резолвил бы только A-записи, и ресурсы, доступные лишь по IPv6, из
   * туннеля не открывались бы. Выключается XRAY_IPV6=false — нужно, если у
   * VPS пропал исходящий IPv6: иначе дуалстек-домены виснут на таймауте
   * Happy Eyeballs.
   */
  public readonly ipv6Enabled = process.env.XRAY_IPV6 !== 'false';

  private readonly mutex = new Mutex();

  private wsParams: IXrayWsParams | null = null;
  private realityParams: IXrayRealityParams | null = null;
  private socksParams: IXraySocksParams | null = null;
  private clients: IXrayClient[] = [];

  /** false — бинарника нет, выключено через env или не задан HOST. */
  private enabled = false;

  private currentProc: ChildProcess | null = null;
  /** true во время намеренной остановки — чтобы обработчик exit не перезапускал. */
  private shuttingDown = false;
  /**
   * Промис инициализации onModuleInit. syncClients() дожидается его перед
   * проверкой параметров — Nest не гарантирует, что XrayService.onModuleInit()
   * завершится раньше вызова syncClients из PeersService.
   */
  private initPromise: Promise<void> = Promise.resolve();

  /** Подпись уже применённого набора клиентов — если новый совпадает, перезапуск пропускается. */
  private appliedSignature = '';
  /** Последний запрошенный набор — применяется одним перезапуском после дебаунса. */
  private pendingClients: IXrayClient[] | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadWaiters: Array<() => void> = [];

  async onModuleInit(): Promise<void> {
    if (process.env.XRAY_ENABLED === 'false') {
      this.logger.warn('Xray выключен (XRAY_ENABLED=false)');
      return;
    }

    if (!this.host) {
      this.logger.warn(
        'Xray не запущен: не задан WG_HOST/XRAY_HOST — некуда указывать Reality-ссылку',
      );
      return;
    }

    if (!(await this.isBinaryAvailable())) {
      this.logger.warn(
        'Xray не запущен: бинарник xray не найден в образе — доступен только AmneziaWG',
      );
      return;
    }

    // Ошибка инициализации Xray не должна ронять весь бот: AmneziaWG и
    // остальное продолжают работать — логируем и продолжаем без Xray.
    this.initPromise = this.mutex
      .runExclusive(async () => {
        await this.loadOrGenerateWsParams();
        await this.loadOrGenerateRealityParams();
        if (this.socksEnabled) await this.loadOrGenerateSocksParams();
        await this.writeConfig();
        this.startProcess();
        this.enabled = true;
      })
      .catch((error) => {
        this.enabled = false;
        this.logger.error(
          `Не удалось инициализировать Xray: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });

    await this.initPromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopProcess();
  }

  /**
   * Готов ли Xray выдавать ссылки. Зеркало AwgService.isEnabled(): бот не
   * должен предлагать VLESS, если процесс не поднялся.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Поднят ли CDN-канал (нужен домен, за которым стоит TLS-прокси). */
  isCdnEnabled(): boolean {
    return this.enabled && this.domain !== null;
  }

  /**
   * Стоит ли перед Xray nginx-разводчик. Привязано к наличию домена
   * ровно потому, что разводить есть смысл только при двух каналах на одном
   * порту — такое же условие у docker-entrypoint.sh, который запускает nginx.
   * Рассогласование здесь ломает всᑑ: если Xray ждᑑт PROXY protocol, а nginx
   * его не шлёт (или наоборот), хендшейк не состоится вообще.
   */
  private get behindProxy(): boolean {
    return this.domain !== null;
  }

  private async isBinaryAvailable(): Promise<boolean> {
    try {
      await execFileAsync('xray', ['version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Пересобрать список клиентов, переписать xray.json и досадить разницу в
   * живой процесс. Вызывается PeersService при старте и при любом изменении
   * состава активных пиров.
   */
  async syncClients(clients: IXrayClient[]): Promise<void> {
    await this.initPromise;

    if (!this.enabled) return;

    // No-op guard: частый случай — updatedPeer/toggle обновили поля пира, но
    // множество активных VLESS-клиентов то же — перезапуск не нужен.
    if (this.clientsSignature(clients) === this.appliedSignature) {
      return;
    }

    // Коалесцируем всплеск изменений в один перезапуск. Ожидающие вызовы
    // разбудятся после фактического применения.
    this.pendingClients = clients;
    await new Promise<void>((resolve) => {
      this.reloadWaiters.push(resolve);
      if (this.reloadTimer) return;
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        const waiters = this.reloadWaiters;
        this.reloadWaiters = [];
        void this.applyReload().finally(() => {
          for (const wake of waiters) wake();
        });
      }, RELOAD_DEBOUNCE_MS);
    });
  }

  /** Стабильная подпись набора клиентов (порядок не важен). */
  private clientsSignature(clients: IXrayClient[]): string {
    return clients
      .map((c) => `${c.name}:${c.uuid}`)
      .sort()
      .join('|');
  }

  /**
   * Применяет последний отложенный набор клиентов. Разницу (добавленные и
   * удалённые) досылаем в живой процесс через HandlerService — соединения
   * остальных пользователей не рвутся. Конфиг на диске переписываем всегда:
   * правки через API живут только в памяти, и после падения процесса Xray
   * поднимется именно из файла. Если API недоступен — откатываемся на
   * перезапуск, то есть на прежнее поведение.
   */
  private async applyReload(): Promise<void> {
    const clients = this.pendingClients;
    if (!clients) return;
    this.pendingClients = null;

    await this.mutex.runExclusive(async () => {
      const previous = this.clients;
      this.clients = clients;
      await this.writeConfig();

      // Процесса ещё нет (старт сервиса) — применять через API нечему.
      if (!this.currentProc) {
        this.startProcess();
        return;
      }

      if (!(await this.applyClientsDiff(previous, clients))) {
        this.logger.warn(
          'Не удалось применить клиентов через Xray API — перезапускаю процесс',
        );
        await this.stopProcess();
        this.startProcess();
      }
    });

    this.appliedSignature = this.clientsSignature(clients);
    this.logger.log(`Xray синхронизирован: ${clients.length} клиент(ов)`);
  }

  /**
   * Досылает в работающий Xray разницу между наборами клиентов.
   * false — хоть один вызов API не удался, вызывающий сделает перезапуск.
   */
  private async applyClientsDiff(
    previous: IXrayClient[],
    next: IXrayClient[],
  ): Promise<boolean> {
    const previousByName = new Map(previous.map((c) => [c.name, c.uuid]));
    const nextByName = new Map(next.map((c) => [c.name, c.uuid]));

    // Смена uuid у существующего имени — это удаление плюс добавление.
    const added = next.filter((c) => previousByName.get(c.name) !== c.uuid);
    const removed = previous
      .filter((c) => nextByName.get(c.name) !== c.uuid)
      .map((c) => c.name);

    if (added.length === 0 && removed.length === 0) return true;

    try {
      if (removed.length > 0) await this.removeUsersViaApi(removed);
      if (added.length > 0) await this.addUsersViaApi(added);
      return true;
    } catch (error) {
      this.logger.warn(
        `Xray API отклонил изменение клиентов: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return false;
    }
  }

  /**
   * `xray api adu` принимает файл конфига и вытаскивает из него inbounds[].tag
   * вместе со списком пользователей. Переиспользуем buildServerConfig с
   * подмножеством клиентов — так формат гарантированно совпадает с рабочим.
   */
  private async addUsersViaApi(clients: IXrayClient[]): Promise<void> {
    const tmpPath = path.join(
      os.tmpdir(),
      `xray-adu-${randomBytes(6).toString('hex')}.json`,
    );

    try {
      await writeFile(
        tmpPath,
        JSON.stringify(this.buildServerConfig(clients), null, 2),
      );
      await execFileAsync('xray', [
        'api',
        'adu',
        `--server=127.0.0.1:${this.statsApiPort}`,
        tmpPath,
      ]);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  /** Удаляет пиров из инбаундов по email (у нас это peer.name). */
  private async removeUsersViaApi(emails: string[]): Promise<void> {
    for (const tag of this.activeInboundTags()) {
      await execFileAsync('xray', [
        'api',
        'rmu',
        `--server=127.0.0.1:${this.statsApiPort}`,
        `-tag=${tag}`,
        ...emails,
      ]);
    }
  }

  /** Без домена ws-инбаунда в конфиге нет — удалять пиров из него нельзя. */
  private activeInboundTags(): string[] {
    return this.domain
      ? XrayService.CLIENT_INBOUND_TAGS
      : XrayService.CLIENT_INBOUND_TAGS.filter((tag) => tag !== 'ws-cdn');
  }

  /** Публичные параметры для сборки outbound'ов в sing-box-подписке. */
  getPublicParams(): IXrayPublicParams {
    if (!this.wsParams || !this.realityParams) {
      throw new InternalServerErrorException(
        'Xray не инициализирован — невозможно получить параметры',
      );
    }

    return {
      domain: this.domain,
      port: this.port,
      wsPath: this.wsParams.wsPath,
      host: this.host,
      realityPort: this.realityPort,
      realityPublicKey: this.realityParams.publicKey,
      realityShortId: this.realityParams.shortId,
      realitySni: this.realitySni,
      ipv6: this.ipv6Enabled,
    };
  }

  /**
   * vless://-ссылка для клиента через Cloudflare CDN (WS+TLS). TLS терминирует
   * хостовый reverse-proxy настоящим сертификатом домена, поэтому insecure не нужен.
   */
  buildClientLink(name: string, uuid: string): string {
    if (!this.wsParams || !this.domain) {
      throw new InternalServerErrorException(
        'CDN-канал Xray не настроен — невозможно собрать vless-ссылку',
      );
    }

    const query = new URLSearchParams({
      type: 'ws',
      security: 'tls',
      encryption: 'none',
      path: this.wsParams.wsPath,
      host: this.domain,
      sni: this.domain,
      // Тот же uTLS-отпечаток, что и в sing-box-подписке для этого канала —
      // иначе DPI видит разный ClientHello в зависимости от того, импортировал
      // ли клиент подписку или прямую ссылку.
      fp: 'chrome',
    });

    return `vless://${uuid}@${this.domain}:${this.port}?${query.toString()}#${encodeURIComponent(
      name,
    )}`;
  }

  /**
   * vless://-ссылка для клиента напрямую на IP сервера (Reality, без CDN).
   * Работает там, где режут сам Cloudflare/WS, но не защищена от блокировки
   * по IP — дополняет, а не заменяет CDN-канал.
   */
  buildRealityClientLink(name: string, uuid: string): string {
    if (!this.realityParams) {
      throw new InternalServerErrorException(
        'Xray не инициализирован — невозможно собрать reality-ссылку',
      );
    }

    const query = new URLSearchParams({
      type: 'tcp',
      security: 'reality',
      encryption: 'none',
      pbk: this.realityParams.publicKey,
      flow: XRAY_REALITY_FLOW,
      // Тот же отпечаток, что и в sing-box-подписке (SubscriptionService) —
      // единый uTLS-fingerprint для одного Reality-канала, иначе DPI видит
      // рассогласование ClientHello между прямой ссылкой и подпиской.
      fp: 'chrome',
      sni: this.realitySni,
      sid: this.realityParams.shortId,
    });

    return `vless://${uuid}@${this.host}:${this.realityPort}?${query.toString()}#${encodeURIComponent(
      name,
    )}`;
  }

  /**
   * Ссылки vless:// на все поднятые каналы пира. Имена в якоре (#...)
   * пользователь видит в списке серверов клиента — они должны быть понятны
   * без пояснений. Живут здесь, а не в SubscriptionService: ссылка — знание о
   * транспорте, и так её может взять и PeersService без цикла зависимостей.
   */
  buildShareLinks(name: string, uuid: string): string[] {
    const links: string[] = [];
    if (this.domain) links.push(this.buildClientLink(`${name} · CDN`, uuid));
    links.push(this.buildRealityClientLink(`${name} · Прямой`, uuid));
    return links;
  }

  /** Поднят ли SOCKS5-прокси для Telegram — от этого зависит кнопка в карточке конфига. */
  isTelegramProxyEnabled(): boolean {
    return this.enabled && this.socksEnabled && this.socksParams !== null;
  }

  /**
   * Ссылка на SOCKS5-прокси для Telegram. null — прокси выключен или Xray не
   * поднялся. Пара логин/пароль общая для всех клиентов (как раньше секрет
   * mtg): отозвать доступ у одного нельзя, пересоздание
   * configs/xray-socks.json отключает сразу всех.
   */
  getTelegramProxyLink(): ITelegramProxyLink | null {
    if (!this.isTelegramProxyEnabled() || !this.socksParams) return null;

    const { user, pass } = this.socksParams;
    const query =
      `server=${encodeURIComponent(this.host)}&port=${this.socksPort}` +
      `&user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;

    return {
      shareUrl: `https://t.me/socks?${query}`,
      deepLink: `tg://socks?${query}`,
      host: this.host,
      port: this.socksPort,
      user,
      pass,
    };
  }

  /**
   * Кумулятивный per-user трафик через StatsService (растёт с момента
   * старта процесса, как счётчики WireGuard — не дельта). Ключ Map — email
   * клиента в конфиге, у нас это peer.name. Ошибка не должна ронять вызов —
   * просто возвращаем пустую карту (пока Xray не запущен/API не отвечает).
   */
  async getTrafficStats(): Promise<
    Map<string, { uplink: number; downlink: number }>
  > {
    const result = new Map<string, { uplink: number; downlink: number }>();

    if (!this.enabled) return result;

    try {
      const { stdout } = await execAsync(
        `xray api statsquery --server=127.0.0.1:${this.statsApiPort}`,
      );
      const parsed = JSON.parse(stdout) as {
        stat?: Array<{ name: string; value: string | number }>;
      };

      for (const entry of parsed.stat ?? []) {
        const match = entry.name.match(
          /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/,
        );
        if (!match) continue;

        const [, email, direction] = match;
        const stats = result.get(email) ?? { uplink: 0, downlink: 0 };
        stats[direction as 'uplink' | 'downlink'] = Number(entry.value);
        result.set(email, stats);
      }
    } catch (error) {
      this.logger.warn(
        `Не удалось получить статистику Xray: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }

    return result;
  }

  private async loadOrGenerateWsParams(): Promise<void> {
    if (existsSync(this.wsParamsPath)) {
      const raw = await readFile(this.wsParamsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IXrayWsParams>;

      if (parsed.wsPath) {
        this.wsParams = { wsPath: parsed.wsPath };
        return;
      }
    }

    this.wsParams = { wsPath: `/${randomBytes(12).toString('hex')}` };
    await writeFile(this.wsParamsPath, JSON.stringify(this.wsParams, null, 2));
    this.logger.log('Сгенерирован новый WS-путь для Xray');
  }

  private async loadOrGenerateRealityParams(): Promise<void> {
    if (existsSync(this.realityParamsPath)) {
      const raw = await readFile(this.realityParamsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IXrayRealityParams>;

      if (parsed.privateKey && parsed.publicKey && parsed.shortId) {
        this.realityParams = {
          privateKey: parsed.privateKey,
          publicKey: parsed.publicKey,
          shortId: parsed.shortId,
        };
        return;
      }
    }

    this.realityParams = await this.generateRealityParams();
    await writeFile(
      this.realityParamsPath,
      JSON.stringify(this.realityParams, null, 2),
    );
    this.logger.log('Сгенерированы новые Reality-ключи (x25519 + shortId)');
  }

  private async loadOrGenerateSocksParams(): Promise<void> {
    if (existsSync(this.socksParamsPath)) {
      const raw = await readFile(this.socksParamsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IXraySocksParams>;

      if (parsed.user && parsed.pass) {
        this.socksParams = { user: parsed.user, pass: parsed.pass };
        return;
      }
    }

    // base64url: пара уезжает в query tg://socks-ссылки, и лишнее
    // экранирование в ней только мешает пользователю копировать руками.
    this.socksParams = {
      user: `tg${randomBytes(4).toString('hex')}`,
      pass: randomBytes(12).toString('base64url'),
    };
    await writeFile(
      this.socksParamsPath,
      JSON.stringify(this.socksParams, null, 2),
    );
    this.logger.log('Сгенерирована новая пара логин/пароль для SOCKS5-прокси');
  }

  private async generateRealityParams(): Promise<IXrayRealityParams> {
    const { stdout } = await execAsync('xray x25519');

    // Формат вывода менялся между версиями Xray, поддерживаем оба:
    //   v1.8.x — "Private key: X" / "Public key: Y"
    //   v26.x  — "PrivateKey: X" / "Password: Y" (в свежих сборках
    //            "Password (PublicKey): Y"); третья строка Hash32 не нужна.
    // Публичный ключ переименовали в Password, чтобы его не публиковали.
    const privateKey = stdout.match(/private\s*key:\s*(\S+)/i)?.[1];
    const publicKey =
      stdout.match(/^\s*public\s*key:\s*(\S+)/im)?.[1] ??
      stdout.match(/^\s*password[^:]*:\s*(\S+)/im)?.[1];

    if (!privateKey || !publicKey) {
      throw new InternalServerErrorException(
        `Не удалось разобрать вывод xray x25519: ${stdout}`,
      );
    }

    return {
      privateKey,
      publicKey,
      shortId: randomBytes(8).toString('hex'),
    };
  }

  /**
   * Конфиг Xray для заданного набора клиентов. Параметр нужен, чтобы тем же
   * кодом собрать частичный конфиг для `xray api adu` — формат инбаундов там
   * обязан совпадать с рабочим, иначе пользователь добавится не туда.
   */
  private buildServerConfig(
    clients: IXrayClient[] = this.clients,
  ): Record<string, unknown> {
    if (!this.wsParams || !this.realityParams) {
      throw new InternalServerErrorException('Xray не инициализирован');
    }

    const inboundClients: IXrayInboundClient[] = clients.map((client) => ({
      id: client.uuid,
      // "email" — это просто ключ статистики в StatsService
      // (user>>>{email}>>>traffic>>>...), не настоящий адрес почты.
      email: client.name,
    }));

    // Тот же список, но с XTLS Vision — только для Reality (network: tcp).
    // Без flow внутри Reality идёт обычный TLS, то есть TLS-in-TLS, который DPI
    // узнаёт по паттерну размеров пакетов даже при идеальной маскировке
    // сертификата. На ws-инбаунде flow, наоборот, недопустим — Xray откажется
    // стартовать, поэтому наборы клиентов разные.
    const realityClients: IXrayInboundClient[] = inboundClients.map(
      (client) => ({ ...client, flow: XRAY_REALITY_FLOW }),
    );

    const inbounds: Record<string, unknown>[] = [
      {
        tag: 'api',
        listen: '127.0.0.1',
        port: this.statsApiPort,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
    ];

    // CDN-канал есть только при заданном домене: без него TLS терминировать
    // некому и ws-инбаунд просто некуда подключить.
    if (this.domain) {
      inbounds.push({
        tag: 'ws-cdn',
        // Только localhost — снаружи этот порт публикует reverse-proxy на
        // хосте: он терминирует TLS сертификатом домена и проксирует сюда
        // обычным HTTP/WS. Xray сам TLS для этого инбаунда не делает.
        listen: '127.0.0.1',
        port: this.internalWsPort,
        protocol: 'vless',
        settings: {
          clients: inboundClients,
          decryption: 'none',
        },
        streamSettings: {
          network: 'ws',
          wsSettings: {
            path: this.wsParams.wsPath,
            // Cloudflare рвёт WebSocket после ~100с простоя на планах
            // Free/Pro. Пинг раз в 30с держит канал живым, пока пользователь
            // не шлёт трафик — без него связь умирала от одной паузы в видео.
            heartbeatPeriod: 30,
          },
        },
      });
    }

    inbounds.push({
      tag: 'reality-direct',
      // С разводчиком публичный порт слушает nginx и отдаёт сюда всᑑ, чей SNI
      // не равен домену CDN. Без разводчика биндимся на публичный порт сами:
      // контейнер в network_mode: host. При включённом IPv6 — на '::', с
      // bindv6only=0 такой сокет принимает и IPv4-подключения.
      listen: this.behindProxy
        ? '127.0.0.1'
        : this.ipv6Enabled
          ? '::'
          : '0.0.0.0',
      port: this.behindProxy ? this.internalRealityPort : this.realityPort,
      protocol: 'vless',
      settings: {
        clients: realityClients,
        decryption: 'none',
      },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        // Принимаем PROXY protocol от nginx — иначе Xray читает заголовок
        // "PROXY TCP4 ..." как начало ClientHello и рвёт соединение ("REALITY:
        // processed invalid connection ... failed to read client hello"),
        // а source IP у всех был бы 127.0.0.1.
        ...(this.behindProxy
          ? { tcpSettings: { acceptProxyProtocol: true } }
          : {}),
        realitySettings: {
          show: false,
          dest: this.realityDest,
          // xver — версия PROXY protocol, которую Reality ШЛЁТ на dest.
          // Маскировочный сайт про PROXY ничего не знает, поэтому 0.
          xver: 0,
          serverNames: [this.realitySni],
          privateKey: this.realityParams.privateKey,
          shortIds: ['', this.realityParams.shortId],
        },
      },
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic'],
      },
    });

    // SOCKS5 для Telegram. Отдельный инбаунд, а не канал VLESS: мессенджер
    // умеет ровно две ссылки — tg://proxy (MTProto) и tg://socks, и подключить
    // vless:// внутри себя не может. Пара логин/пароль одна на всех, поэтому
    // выход ограничен сетями Telegram (см. TELEGRAM_NETS ниже в routing).
    // udp не включаем: клиенты Telegram через SOCKS5 его не используют,
    // а UDP-ассоциация потребовала бы отдавать наружу ещё и адрес релея.
    if (this.socksEnabled && this.socksParams) {
      inbounds.push({
        tag: 'socks-tg',
        listen: this.ipv6Enabled ? '::' : '0.0.0.0',
        port: this.socksPort,
        protocol: 'socks',
        settings: {
          auth: 'password',
          accounts: [
            { user: this.socksParams.user, pass: this.socksParams.pass },
          ],
          udp: false,
        },
      });
    }

    const routingRules: Record<string, unknown>[] = [
      { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
      // Блокируем клиентам доступ во внутренние/локальные сети сервера
      // (loopback, docker-сеть, LAN). Иначе через туннель были бы доступны
      // Stats API (127.0.0.1:8881), health, внутренний WS и прочие сервисы
      // контейнера — а в network_mode: host это вся внутренняя сеть хоста.
      // Явные CIDR вместо geoip:private — не зависит от geoip.dat.
      // IPv6-диапазоны остаются заблокированы и при XRAY_IPV6=true:
      // включён выход в глобальный IPv6, а не в служебные сети.
      {
        type: 'field',
        outboundTag: 'block',
        ip: [
          '0.0.0.0/8',
          '10.0.0.0/8',
          '100.64.0.0/10',
          '127.0.0.0/8',
          '169.254.0.0/16',
          '172.16.0.0/12',
          '192.168.0.0/16',
          '::1/128',
          'fc00::/7',
          'fe80::/10',
        ],
      },
    ];

    // Порядок важен: сначала пропускаем Telegram, следом глушим всё
    // остальное с этого инбаунда — правило-«хвост» без списка адресов.
    if (this.socksEnabled && this.socksParams) {
      routingRules.push(
        {
          type: 'field',
          inboundTag: ['socks-tg'],
          ip: TELEGRAM_NETS,
          outboundTag: 'direct',
        },
        { type: 'field', inboundTag: ['socks-tg'], outboundTag: 'block' },
      );
    }

    return {
      log: { loglevel: 'warning' },
      // Резолвинг на сервере. С IPv6 спрашиваем и AAAA (UseIP), иначе только
      // A-записи — см. XRAY_IPV6.
      dns: {
        servers: this.ipv6Enabled
          ? [
              '1.1.1.1',
              '8.8.8.8',
              '2606:4700:4700::1111',
              '2001:4860:4860::8888',
            ]
          : ['1.1.1.1', '8.8.8.8'],
        queryStrategy: this.ipv6Enabled ? 'UseIP' : 'UseIPv4',
      },
      // StatsService — per-user трафик (см. getTrafficStats). API-инбаунд
      // только на localhost, наружу не публикуется.
      api: {
        tag: 'api',
        // HandlerService — добавление/удаление пользователей на лету
        // (xray api adu/rmu). Без него любая правка списка клиентов требует
        // перезапуска процесса, а он рвёт соединения всем сразу.
        services: ['HandlerService', 'StatsService'],
      },
      stats: {},
      policy: {
        levels: {
          '0': {
            statsUserUplink: true,
            statsUserDownlink: true,
          },
        },
      },
      routing: { rules: routingRules },
      inbounds,
      outbounds: [
        // UseIP — дуалстек: домены резолвятся и в A, и в AAAA. При
        // XRAY_IPV6=false остаётся UseIPv4 (исходящего IPv6 нет — иначе Xray
        // зависает на попытке дозвониться по AAAA).
        {
          protocol: 'freedom',
          tag: 'direct',
          settings: {
            domainStrategy: this.ipv6Enabled ? 'UseIP' : 'UseIPv4',
          },
        },
        { protocol: 'blackhole', tag: 'block' },
      ],
    };
  }

  private async writeConfig(): Promise<void> {
    await writeFile(
      this.configPath,
      JSON.stringify(this.buildServerConfig(), null, 2),
    );
  }

  private startProcess(): void {
    const proc = spawn('xray', ['run', '-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentProc = proc;

    proc.stdout?.on('data', (chunk: Buffer) =>
      this.logger.debug(`[xray] ${chunk.toString().trim()}`),
    );
    proc.stderr?.on('data', (chunk: Buffer) =>
      this.logger.warn(`[xray] ${chunk.toString().trim()}`),
    );
    proc.on('error', (error) =>
      this.logger.error(`Ошибка запуска xray: ${error.message}`),
    );
    proc.on('exit', (code, signal) => {
      if (this.currentProc === proc) this.currentProc = null;
      if (this.shuttingDown) return;

      this.logger.error(
        `Процесс xray завершился (code=${code}, signal=${signal}) — перезапуск через 2с`,
      );
      setTimeout(() => {
        if (!this.shuttingDown && !this.currentProc) this.startProcess();
      }, 2000);
    });

    const cdn = this.domain
      ? `ws-cdn на localhost:${this.internalWsPort} (за nginx, ${this.domain}:${this.port})`
      : 'ws-cdn выключен (XRAY_DOMAIN не задан)';
    const reality = this.behindProxy
      ? `reality-direct на localhost:${this.internalRealityPort} (за nginx:${this.realityPort}, SNI-роутинг)`
      : `reality-direct на :${this.realityPort} напрямую`;

    this.logger.log(
      `xray запущен (pid=${proc.pid}): ${cdn}, ${reality}, IPv6 ${
        this.ipv6Enabled ? 'включён' : 'выключен'
      }`,
    );
  }

  private async stopProcess(): Promise<void> {
    const proc = this.currentProc;
    if (!proc) return;

    this.shuttingDown = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      proc.once('exit', done);
      proc.kill('SIGTERM');
      // Страховка: если xray не завершился за 5с — убиваем принудительно.
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // процесс уже мёртв — игнорируем
        }
        done();
      }, 5000);
    });

    this.currentProc = null;
    this.shuttingDown = false;
  }
}
