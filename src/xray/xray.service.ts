import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import * as path from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Mutex } from 'async-mutex';

const execAsync = promisify(exec);

/** Клиент VLESS: имя пира и его UUID (id из БД). */
export interface IXrayClient {
  name: string;
  uuid: string;
}

interface IXrayInboundClient {
  id: string;
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
  public readonly realityPort = Number(process.env.REALITY_PORT || 8443);
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

    await this.mutex.runExclusive(async () => {
      this.clients = clients;
      await this.writeConfig();
      await this.stopProcess();
      this.startProcess();
    });
    this.logger.log(`Xray синхронизирован: ${clients.length} клиент(ов)`);
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
      fp: 'random',
      sni: this.realitySni,
      sid: this.realityParams.shortId,
    });

    return `vless://${uuid}@${this.host}:${this.realityPort}?${query.toString()}#${encodeURIComponent(
      name,
    )}`;
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
    const privateKey = stdout.match(/Private key:\s*(\S+)/i)?.[1];
    const publicKey = stdout.match(/Public key:\s*(\S+)/i)?.[1];

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

  private buildServerConfig(): Record<string, unknown> {
    const inboundClients: IXrayInboundClient[] = this.clients.map((client) => ({
      id: client.uuid,
    }));

    return {
      log: { loglevel: 'warning' },
      // Резолвим имена на сервере только через IPv4 (исходящий IPv6 на VPS
      // не маршрутизируется). queryStrategy UseIPv4 не даёт запрашивать AAAA.
      dns: {
        servers: ['1.1.1.1', '8.8.8.8'],
        queryStrategy: 'UseIPv4',
      },
      inbounds: [
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
            },
          },
        },
        {
          tag: 'reality-direct',
          listen: '0.0.0.0',
          port: this.realityPort,
          protocol: 'vless',
          settings: {
            clients: inboundClients,
            decryption: 'none',
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              show: false,
              dest: this.realityDest,
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
      `xray запущен (pid=${proc.pid}): ws-cdn на localhost:${this.internalWsPort} (за nginx:${this.port}), reality-direct на ${this.realityPort}/tcp`,
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
