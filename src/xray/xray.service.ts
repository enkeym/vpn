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

/** Пир и его активные IP из ответа `xray api statsonlineiplist`. */
interface IOnlineIpEntry {
  email: string;
  ips: string[];
}

/** IP приходят либо картой «ip → время», либо простым списком строк. */
function extractIps(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((ip): ip is string => typeof ip === 'string');
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.keys(raw as Record<string, unknown>);
  }
  return [];
}

/**
 * Достаёт пары «email → активные IP» из ответа statsonlineiplist.
 *
 * Команда просто печатает protojson-ответ как есть, а его форма отличается
 * между сборками Xray (camelCase против snake_case, карта против списка).
 * Поэтому идём по структуре рекурсивно и собираем любые узлы, где рядом лежат
 * email и набор IP — разбор переживает косметические изменения формата.
 */
function collectOnlineIpEntries(payload: unknown): IOnlineIpEntry[] {
  const found: IOnlineIpEntry[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    const email = record.email ?? record.user;
    const ips = extractIps(
      record.ips ?? record.onlineIps ?? record.online_ips ?? record.ip,
    );

    if (typeof email === 'string' && email.length > 0 && ips.length > 0) {
      found.push({ email, ips });
    }

    for (const value of Object.values(record)) walk(value);
  };

  walk(payload);
  return found;
}

/** Клиент VLESS: имя пира и его UUID (id из БД). */
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
 * configs/xray-ws.json, чтобы переживать рестарт (как obfsPassword у Hysteria).
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
 * Управляет процессом Xray-core с двумя независимыми путями обхода блокировок:
 *
 * 1. VLESS+WS+TLS за Cloudflare CDN (nginx перед Xray терминирует TLS и
 *    проксирует на localhost — сам Xray смотрит только внутрь контейнера).
 *    Клиент никогда не видит реальный IP сервера — не режется блокировкой
 *    по IP, но зависит от доступности самого Cloudflare у клиента.
 * 2. VLESS+Reality — прямой TCP на реальный IP сервера, без CDN и без WS.
 *    Не защищён от блокировки по IP, зато не зависит от Cloudflare и не
 *    требует HTTP/WS-хендшейка — работает там, где режут именно CDN/WS.
 *
 * Оба канала входят в одну sing-box-подписку (см. SubscriptionService) вместе
 * с прямой Hysteria2 — три разных механизма обхода, у каждого свой профиль
 * блокировки, клиент сам держит активным то, что реально работает на сети.
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
  private readonly configPath = path.join(process.cwd(), '/configs/xray.json');

  /** Внешний порт CDN-канала — теперь его слушает nginx, а не сам Xray. */
  public readonly port = Number(process.env.XRAY_PORT || 443);
  /** Внутренний порт, на который nginx проксирует WS (никогда не публикуется наружу). */
  private readonly internalWsPort = Number(
    process.env.XRAY_INTERNAL_WS_PORT || 8880,
  );
  /**
   * Порт Reality в клиентских ссылках — 443. Xray сам предупреждает при старте
   * («REALITY: Listening on non-443 ports may get your IP blocked by the GFW»):
   * TLS на нестандартном порту для DPI — самостоятельный маркер, мобильные
   * операторы режут такое агрессивнее всего.
   */
  public readonly realityPort = Number(process.env.REALITY_PORT || 443);
  /**
   * Внутренний порт Reality-инбаунда. Наружу 443 слушает nginx в режиме stream
   * и разводит по SNI (см. docker/nginx.conf): домен CDN — на TLS-сервер nginx,
   * всё остальное — сюда. Реальный IP клиента доезжает через PROXY protocol
   * (proxy_protocol в nginx + tcpSettings.acceptProxyProtocol в инбаунде),
   * иначе Xray видел бы 127.0.0.1 и лимит устройств с getOnlineIps() считал бы
   * всех одним клиентом.
   */
  private readonly internalRealityPort = Number(
    process.env.XRAY_INTERNAL_REALITY_PORT || 8443,
  );
  /** Внутренний порт StatsService API — только localhost, наружу не публикуется. */
  private readonly statsApiPort = Number(
    process.env.XRAY_STATS_API_PORT || 8881,
  );
  private readonly domain = process.env.XRAY_DOMAIN;
  private readonly host = process.env.HOST;
  private readonly realityDest =
    process.env.XRAY_REALITY_DEST || 'www.wikipedia.org:443';
  private readonly realitySni =
    process.env.XRAY_REALITY_SNI || 'www.wikipedia.org';

  private readonly mutex = new Mutex();

  private wsParams!: IXrayWsParams;
  private realityParams!: IXrayRealityParams;
  private clients: IXrayClient[] = [];

  private currentProc: ChildProcess | null = null;
  /** true во время намеренной остановки — чтобы обработчик exit не перезапускал. */
  private shuttingDown = false;
  /**
   * Промис инициализации onModuleInit. syncClients() дожидается его перед
   * проверкой this.params — Nest не гарантирует, что XrayService.onModuleInit()
   * завершится раньше PeersService.onModuleInit(), который вызывает syncClients
   * на старте (без этого клиенты иногда пропадали из xray.json при рестарте).
   */
  private initPromise: Promise<void> = Promise.resolve();

  /** Подпись уже применённого набора клиентов — если новый совпадает, перезапуск пропускается. */
  private appliedSignature = '';
  /** Последний запрошенный набор — применяется одним перезапуском после дебаунса. */
  private pendingClients: IXrayClient[] | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadWaiters: Array<() => void> = [];

  async onModuleInit(): Promise<void> {
    if (!this.domain) throw new Error('XRAY_DOMAIN в .env не задан');
    if (!this.host) throw new Error('HOST в .env не задан');

    // Ошибка инициализации Xray не должна ронять весь бот (AWG и остальное
    // продолжают работать) — логируем и продолжаем.
    this.initPromise = this.mutex
      .runExclusive(async () => {
        await this.loadOrGenerateWsParams();
        await this.loadOrGenerateRealityParams();
        await this.writeConfig();
        this.startProcess();
      })
      .catch((error) => {
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
   * Пересобрать список клиентов, переписать xray.json и перезапустить процесс.
   * Вызывается PeersService при старте и при добавлении/удалении пира.
   */
  async syncClients(clients: IXrayClient[]): Promise<void> {
    await this.initPromise;

    if (!this.wsParams) {
      this.logger.warn(
        'Xray не инициализирован (нет параметров) — пропускаю синхронизацию клиентов',
      );
      return;
    }

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

  /** Удаляет пиров из обоих инбаундов по email (у нас это peer.name). */
  private async removeUsersViaApi(emails: string[]): Promise<void> {
    for (const tag of XrayService.CLIENT_INBOUND_TAGS) {
      await execFileAsync('xray', [
        'api',
        'rmu',
        `--server=127.0.0.1:${this.statsApiPort}`,
        `-tag=${tag}`,
        ...emails,
      ]);
    }
  }

  /** Публичные параметры для сборки outbound'ов в sing-box-подписке. */
  getPublicParams(): {
    domain: string;
    port: number;
    wsPath: string;
    host: string;
    realityPort: number;
    realityPublicKey: string;
    realityShortId: string;
    realitySni: string;
  } {
    if (!this.wsParams || !this.realityParams) {
      throw new InternalServerErrorException(
        'Xray не инициализирован — невозможно получить параметры',
      );
    }

    return {
      domain: this.domain as string,
      port: this.port,
      wsPath: this.wsParams.wsPath,
      host: this.host as string,
      realityPort: this.realityPort,
      realityPublicKey: this.realityParams.publicKey,
      realityShortId: this.realityParams.shortId,
      realitySni: this.realitySni,
    };
  }

  /**
   * vless://-ссылка для клиента через Cloudflare CDN (WS+TLS). TLS терминирует
   * nginx настоящим сертификатом домена, поэтому insecure не нужен.
   */
  buildClientLink(name: string, uuid: string): string {
    if (!this.wsParams) {
      throw new InternalServerErrorException(
        'Xray не инициализирован — невозможно собрать vless-ссылку',
      );
    }

    const query = new URLSearchParams({
      type: 'ws',
      security: 'tls',
      encryption: 'none',
      path: this.wsParams.wsPath,
      host: this.domain as string,
      sni: this.domain as string,
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
   * Ссылки vless:// на все каналы пира. Имена в якоре (#...) пользователь
   * видит в списке серверов клиента — они должны быть понятны без пояснений.
   * Живут здесь, а не в SubscriptionService: ссылка — знание о транспорте, и так
   * её может взять и PeersService без цикла зависимостей между модулями.
   */
  buildShareLinks(name: string, uuid: string): string[] {
    return [
      this.buildClientLink(`${name} · CDN`, uuid),
      this.buildRealityClientLink(`${name} · Прямой`, uuid),
    ];
  }

  /**
   * Список активных IP по каждому пиру (ключ — email, у нас peer.name).
   * Требует statsUserOnline:true в policy. Ошибка не должна ронять вызывающий
   * крон — возвращаем пустую карту (например, пока Xray не поднялся).
   */
  async getOnlineIps(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();

    // Установленная версия Xray больше не поддерживает `-all` — приходится
    // опрашивать по одному email за раз. NotFound для конкретного пира —
    // норма (сейчас офлайн), а не повод шуметь в логи.
    await Promise.all(
      this.clients.map(async (client) => {
        try {
          const { stdout } = await execFileAsync('xray', [
            'api',
            'statsonlineiplist',
            `--server=127.0.0.1:${this.statsApiPort}`,
            '-email',
            client.name,
          ]);

          const merged = new Set(result.get(client.name) ?? []);
          for (const entry of collectOnlineIpEntries(JSON.parse(stdout))) {
            for (const ip of entry.ips) merged.add(ip);
          }
          if (merged.size > 0) result.set(client.name, [...merged]);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (message.includes('NotFound')) return;

          this.logger.warn(
            `Не удалось получить онлайн-IP для ${client.name}: ${message}`,
          );
        }
      }),
    );

    return result;
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

    return {
      log: { loglevel: 'warning' },
      // Резолвим имена на сервере только через IPv4 (исходящий IPv6 на VPS
      // не маршрутизируется). queryStrategy UseIPv4 не даёт запрашивать AAAA.
      dns: {
        servers: ['1.1.1.1', '8.8.8.8'],
        queryStrategy: 'UseIPv4',
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
            // Учёт онлайн-подключений — источник данных для getOnlineIps()
            // (лимит устройств). Активным считается соединение в пределах
            // последних 20 секунд.
            statsUserOnline: true,
          },
        },
      },
      routing: {
        rules: [
          { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
          // Блокируем клиентам доступ во внутренние/локальные сети сервера
          // (loopback, docker-сеть, LAN). Иначе через туннель были бы доступны
          // Stats API (127.0.0.1:8881), health, внутренний WS и прочие сервисы
          // контейнера. Явные CIDR вместо geoip:private — не зависит от geoip.dat.
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
      inbounds: [
        {
          tag: 'api',
          listen: '127.0.0.1',
          port: this.statsApiPort,
          protocol: 'dokodemo-door',
          settings: { address: '127.0.0.1' },
        },
        {
          tag: 'ws-cdn',
          // Только localhost — снаружи этот порт слушает nginx, он же
          // терминирует TLS настоящим сертификатом Cloudflare и проксирует
          // сюда обычным HTTP/WS. Xray сам TLS для этого инбаунда не делает.
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
        },
        {
          tag: 'reality-direct',
          // Только localhost: снаружи 443 слушает nginx (stream + ssl_preread) и
          // отдаёт сюда всё, чей SNI не равен домену CDN.
          listen: '127.0.0.1',
          port: this.internalRealityPort,
          protocol: 'vless',
          settings: {
            clients: realityClients,
            decryption: 'none',
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            // Принимаем PROXY protocol от nginx — иначе Xray читает заголовок
            // "PROXY TCP4 ..." как начало ClientHello и рвёт соединение
            // ("REALITY: processed invalid connection ... failed to read client
            // hello"), а source IP у всех был бы 127.0.0.1.
            tcpSettings: { acceptProxyProtocol: true },
            realitySettings: {
              show: false,
              dest: this.realityDest,
              // xver — это версия PROXY protocol, которую Reality ШЛЁТ на dest,
              // а не принимает. Маскировочный сайт про PROXY ничего не знает,
              // поэтому 0. Приём настроен выше в tcpSettings.
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
        },
      ],
      outbounds: [
        // UseIPv4: на VPS исходящий IPv6 не маршрутизируется — без этого Xray
        // пытается резолвить домены (YouTube и т.п.) в AAAA-запись и зависает.
        {
          protocol: 'freedom',
          tag: 'direct',
          settings: { domainStrategy: 'UseIPv4' },
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

    this.logger.log(
      `xray запущен (pid=${proc.pid}): ws-cdn на localhost:${this.internalWsPort} (за nginx:${this.port}), reality-direct на localhost:${this.internalRealityPort} (за nginx:${this.realityPort}, SNI-роутинг)`,
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
