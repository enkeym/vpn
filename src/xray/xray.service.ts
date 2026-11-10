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
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HostNetworkService } from '../network/host-network.service';
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_FAILURE_THRESHOLD,
  isTcpListening,
} from '../network/health-check';

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
  /** Только для Reality (TCP): XTLS Vision. */
  flow?: string;
}

/**
 * Постоянные параметры Reality-инбаунда (прямой TCP, без туннеля). Приватный
 * ключ x25519 живёт только на сервере, публичный (pbk) и shortId раздаются
 * клиентам в vless://-ссылке. Хранятся в configs/xray-reality.json.
 */
interface IXrayRealityParams {
  privateKey: string;
  publicKey: string;
  shortId: string;
}

/** Публичные параметры каналов — из них SubscriptionService собирает outbound'ы. */
export interface IXrayPublicParams {
  host: string;
  realityPort: number;
  realityPublicKey: string;
  realityShortId: string;
  realitySni: string;
  /** gRPC+Reality: порт и имя сервиса (без flow — иначе клиент не подключится). */
  grpcPort: number;
  grpcService: string;
  /** XHTTP+Reality: порт, путь и режим (без flow). */
  xhttpPort: number;
  xhttpPath: string;
  xhttpMode: string;
  /** Разрешён ли IPv6 наружу — см. XRAY_IPV6. */
  ipv6: boolean;
}

@Injectable()
export class XrayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XrayService.name);

  /** Теги инбаундов, в которых живут VLESS-клиенты (см. buildServerConfig). */
  private static readonly CLIENT_INBOUND_TAGS = [
    'reality-direct',
    'reality-grpc',
    'reality-xhttp',
  ];

  private readonly realityParamsPath = path.join(
    process.cwd(),
    '/configs/xray-reality.json',
  );
  private readonly configPath = path.join(process.cwd(), '/configs/xray.json');

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
   * nginx-разводчик (см. behindProxy). localhost контейнера — это localhost
   * хоста (network_mode: host), поэтому порт выбран не по умолчанию 443.
   */
  private readonly internalRealityPort = Number(
    process.env.XRAY_INTERNAL_REALITY_PORT || 8444,
  );
  /**
   * Остальные Reality-каналы: gRPC и XHTTP. Прямой TCP+Reality с 17.02.2026
   * режется поведенческим анализом, эти транспорты выживают там, где голый
   * TCP замораживают. Порт общий с Reality, ключи и SNI тоже — меняется только
   * транспорт, поэтому ссылки и подписка остаются совместимыми.
   */
  public readonly grpcPort = Number(process.env.XRAY_GRPC_PORT || 27443);
  private readonly grpcService = process.env.XRAY_GRPC_SERVICE || 'grpc-vk';
  public readonly xhttpPort = Number(process.env.XRAY_XHTTP_PORT || 27444);
  private readonly xhttpPath = process.env.XRAY_XHTTP_PATH || '/xhttp';
  /** auto | packet-up | stream-up | stream-one — см. docs/links/xray.md. */
  private readonly xhttpMode = process.env.XRAY_XHTTP_MODE || 'auto';
  /** Внутренний порт StatsService API — только localhost, наружу не публикуется. */
  private readonly statsApiPort = Number(
    process.env.XRAY_STATS_API_PORT || 8881,
  );
  private readonly selfStealEnabled =
    process.env.XRAY_INTERNAL_STEAL_PORT !== undefined &&
    process.env.XRAY_INTERNAL_STEAL_PORT !== '';
  /** Адрес сервера в прямой Reality-ссылке. Общий с AmneziaWG (WG_HOST). */
  private readonly host = process.env.WG_HOST || '';
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

  private realityParams: IXrayRealityParams | null = null;
  private clients: IXrayClient[] = [];

  /** false — бинарника нет, выключено через env или не задан HOST. */
  private enabled = false;

  private currentProc: ChildProcess | null = null;
  private proxyHealthFailures = 0;
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
  private reloadWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(
    private readonly hostNetwork: HostNetworkService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.XRAY_ENABLED === 'false') {
      this.logger.warn('Xray выключен (XRAY_ENABLED=false)');
      return;
    }

    // Исходящий трафик Xray тоже должен выйти с PUBLIC_IPV4 — SNAT ставим до старта
    await this.hostNetwork.ensureApplied();

    if (!this.host) {
      this.logger.warn(
        'Xray не запущен: не задан WG_HOST — некуда указывать Reality-ссылку',
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
        await this.loadOrGenerateRealityParams();
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

  async isHealthy(): Promise<boolean> {
    if (this.config.get<string>('XRAY_ENABLED') === 'false') return true;
    if (
      !this.enabled ||
      !this.currentProc ||
      this.currentProc.exitCode !== null
    ) {
      return false;
    }
    const ports = this.behindProxy
      ? [this.realityPort, this.internalRealityPort]
      : [this.realityPort];
    return (await Promise.all(ports.map(isTcpListening))).every(Boolean);
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { waitForCompletion: true })
  async restoreProxy(): Promise<void> {
    if (!this.enabled || !this.behindProxy || this.shuttingDown) return;
    if (await isTcpListening(this.realityPort)) {
      this.proxyHealthFailures = 0;
      return;
    }
    this.proxyHealthFailures += 1;
    if (this.proxyHealthFailures < HEALTH_FAILURE_THRESHOLD) return;

    try {
      await execFileAsync('nginx', ['-t'], {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      });
      if (this.shuttingDown) return;
      await execFileAsync('nginx', ['-c', '/etc/nginx/nginx.conf'], {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      });
      this.logger.log('nginx восстановлен после потери публичного порта');
      this.proxyHealthFailures = 0;
    } catch (error) {
      this.logger.error(
        `Не удалось восстановить nginx: ${error instanceof Error ? error.message : error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private get behindProxy(): boolean {
    return this.selfStealEnabled;
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
    await new Promise<void>((resolve, reject) => {
      this.reloadWaiters.push({ resolve, reject });
      if (this.reloadTimer) return;
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        const waiters = this.reloadWaiters;
        this.reloadWaiters = [];
        void this.applyReload().then(
          () => {
            for (const waiter of waiters) waiter.resolve();
          },
          (error: unknown) => {
            for (const waiter of waiters) waiter.reject(error);
          },
        );
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

  private activeInboundTags(): string[] {
    return XrayService.CLIENT_INBOUND_TAGS;
  }

  /** Публичные параметры для сборки outbound'ов в sing-box-подписке. */
  getPublicParams(): IXrayPublicParams {
    if (!this.realityParams) {
      throw new InternalServerErrorException(
        'Xray не инициализирован — невозможно получить параметры',
      );
    }

    return {
      host: this.host,
      realityPort: this.realityPort,
      realityPublicKey: this.realityParams.publicKey,
      realityShortId: this.realityParams.shortId,
      realitySni: this.realitySni,
      grpcPort: this.grpcPort,
      grpcService: this.grpcService,
      xhttpPort: this.xhttpPort,
      xhttpPath: this.xhttpPath,
      xhttpMode: this.xhttpMode,
      ipv6: this.ipv6Enabled,
    };
  }

  buildRealityClientLink(name: string, uuid: string): string {
    return this.buildVlessLink(name, uuid, this.realityPort, {
      type: 'tcp',
      flow: XRAY_REALITY_FLOW,
    });
  }

  /** gRPC: flow не выставляется — XTLS Vision ломает gRPC-транспорт. */
  buildGrpcClientLink(name: string, uuid: string): string {
    return this.buildVlessLink(name, uuid, this.grpcPort, {
      type: 'grpc',
      serviceName: this.grpcService,
    });
  }

  /** XHTTP: flow не выставляется по той же причине. */
  buildXhttpClientLink(name: string, uuid: string): string {
    return this.buildVlessLink(name, uuid, this.xhttpPort, {
      type: 'xhttp',
      path: this.xhttpPath,
      mode: this.xhttpMode,
    });
  }

  private buildVlessLink(
    name: string,
    uuid: string,
    port: number,
    transport: Record<string, string>,
  ): string {
    if (!this.realityParams) {
      throw new InternalServerErrorException(
        'Xray не инициализирован — невозможно собрать reality-ссылку',
      );
    }

    const query = new URLSearchParams({
      ...transport,
      security: 'reality',
      encryption: 'none',
      pbk: this.realityParams.publicKey,
      // Тот же отпечаток, что и в sing-box-подписке (SubscriptionService) —
      // единый uTLS-fingerprint для одного Reality-канала, иначе DPI видит
      // рассогласование ClientHello между прямой ссылкой и подпиской.
      fp: 'chrome',
      sni: this.realitySni,
      sid: this.realityParams.shortId,
    });

    return `vless://${uuid}@${this.host}:${port}?${query.toString()}#${encodeURIComponent(
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
    return [
      this.buildRealityClientLink(`${name} · Reality TCP`, uuid),
      this.buildGrpcClientLink(`${name} · Reality gRPC`, uuid),
      this.buildXhttpClientLink(`${name} · Reality XHTTP`, uuid),
    ];
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
    if (!this.realityParams) {
      throw new InternalServerErrorException('Xray не инициализирован');
    }

    const realityClients: IXrayInboundClient[] = clients.map((client) => ({
      id: client.uuid,
      email: client.name,
      flow: XRAY_REALITY_FLOW,
    }));
    // gRPC и XHTTP живут без flow: XTLS Vision несовместим с этими
    // транспортами, и при рассогласовании клиент не подключится вовсе.
    const transportClients: IXrayInboundClient[] = clients.map((client) => ({
      id: client.uuid,
      email: client.name,
    }));

    const realitySettings = {
      show: false,
      dest: this.realityDest,
      // xver — версия PROXY protocol, которую Reality ШЛЁТ на dest.
      // Маскировочный сайт про PROXY ничего не знает, поэтому 0.
      xver: 0,
      serverNames: [this.realitySni],
      privateKey: this.realityParams.privateKey,
      shortIds: ['', this.realityParams.shortId],
    };
    const sniffing = {
      enabled: true,
      destOverride: ['http', 'tls', 'quic'],
    };
    // Новые каналы слушают напрямую (nginx разводчиком на них не стоит).
    const directListen = this.ipv6Enabled ? '::' : '0.0.0.0';

    const inbounds: Record<string, unknown>[] = [
      {
        tag: 'api',
        listen: '127.0.0.1',
        port: this.statsApiPort,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
    ];

    inbounds.push({
      tag: 'reality-direct',
      // С nginx публичный порт слушает он и отдаёт сюда все соединения.
      // Без nginx биндимся на публичный порт сами: контейнер в
      // network_mode: host. При включённом IPv6 — на '::', с
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
        realitySettings,
      },
      sniffing,
    });

    inbounds.push({
      tag: 'reality-grpc',
      listen: directListen,
      port: this.grpcPort,
      protocol: 'vless',
      settings: {
        clients: transportClients,
        decryption: 'none',
      },
      streamSettings: {
        network: 'grpc',
        security: 'reality',
        grpcSettings: {
          serviceName: this.grpcService,
          multiMode: true,
        },
        realitySettings,
      },
      sniffing,
    });

    inbounds.push({
      tag: 'reality-xhttp',
      listen: directListen,
      port: this.xhttpPort,
      protocol: 'vless',
      settings: {
        clients: transportClients,
        decryption: 'none',
      },
      streamSettings: {
        network: 'xhttp',
        security: 'reality',
        xhttpSettings: {
          path: this.xhttpPath,
          mode: this.xhttpMode,
        },
        realitySettings,
      },
      sniffing,
    });

    return {
      // access: 'none' — иначе Xray пишет строку на КАЖДОЕ принятое соединение
      // ("from ... accepted tcp:...") в stdout, а startProcess прокидывает stdout
      // в logger.debug: на активном Reality-канале это сотни строк в минуту.
      // Ошибки (loglevel) при этом остаются.
      log: { loglevel: 'warning', access: 'none' },
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
      routing: {
        rules: [
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
        ],
      },
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

    const reality = this.behindProxy
      ? `reality-direct на localhost:${this.internalRealityPort} (за nginx:${this.realityPort})`
      : `reality-direct на :${this.realityPort} напрямую`;

    this.logger.log(
      `xray запущен (pid=${proc.pid}): ${reality}, IPv6 ${
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
