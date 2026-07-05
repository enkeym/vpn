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
import { spawn, ChildProcess } from 'child_process';
import { Mutex } from 'async-mutex';

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
 * Управляет процессом Xray-core (VLESS + WebSocket + TLS за Cloudflare CDN).
 * Клиент подключается к домену на Cloudflare (проксируемая A-запись, оранжевое
 * облако), Cloudflare терминирует внешний TLS и поднимает новое TLS-соединение
 * до этого сервера, аутентифицируясь сертификатом Cloudflare Origin CA —
 * поэтому блокировка по IP этого VPS тут не работает: клиент никогда не видит
 * реальный IP сервера, только IP Cloudflare. Пришёл на замену VLESS+Reality,
 * который на некоторых сетях клиентов резался DPI по IP сервера напрямую.
 */
@Injectable()
export class XrayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XrayService.name);

  private readonly wsParamsPath = path.join(
    process.cwd(),
    '/configs/xray-ws.json',
  );
  private readonly configPath = path.join(process.cwd(), '/configs/xray.json');
  private readonly certPath = path.join(
    process.cwd(),
    '/configs/cloudflare-cert.pem',
  );
  private readonly keyPath = path.join(
    process.cwd(),
    '/configs/cloudflare-key.pem',
  );

  public readonly port = Number(process.env.XRAY_PORT || 443);
  private readonly domain = process.env.XRAY_DOMAIN;

  private readonly mutex = new Mutex();

  private wsParams!: IXrayWsParams;
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
    if (!existsSync(this.certPath) || !existsSync(this.keyPath)) {
      throw new Error(
        `Не найден сертификат Cloudflare Origin CA: ${this.certPath} / ${this.keyPath}`,
      );
    }

    // Ошибка инициализации Xray не должна ронять весь бот (AWG и остальное
    // продолжают работать) — логируем и продолжаем.
    this.initPromise = this.mutex
      .runExclusive(async () => {
        await this.loadOrGenerateWsParams();
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

  /**
   * vless://-ссылка для клиента через Cloudflare CDN (WS+TLS). Реальный
   * сертификат домена, поэтому insecure не нужен.
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
          listen: '0.0.0.0',
          port: this.port,
          protocol: 'vless',
          settings: {
            clients: inboundClients,
            decryption: 'none',
          },
          streamSettings: {
            network: 'ws',
            security: 'tls',
            tlsSettings: {
              certificates: [
                { certificateFile: this.certPath, keyFile: this.keyPath },
              ],
            },
            wsSettings: {
              path: this.wsParams.wsPath,
            },
          },
          // sniffing извлекает реальный домен из TLS/HTTP — без него запросы,
          // где клиент уже зарезолвил имя в IPv6, уходили бы на мёртвый IPv6.
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

    this.logger.log(`xray запущен (pid=${proc.pid}), порт ${this.port}/tcp`);
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
