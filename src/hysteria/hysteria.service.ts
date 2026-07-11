import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as path from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Mutex } from 'async-mutex';

const execAsync = promisify(exec);

/**
 * Пауза коалесцирования перезапуска: серия изменений пиров (массовое
 * продление/удаление) сливается в ОДИН перезапуск Hysteria вместо N подряд —
 * меньше обрывов активных соединений. Совпадает по смыслу с константой в XrayService.
 */
const RELOAD_DEBOUNCE_MS = 1500;

/** Клиент Hysteria2: имя пира и его userpass-пароль. */
export interface IHysteriaClient {
  name: string;
  password: string;
}

interface IHysteriaParams {
  obfsPassword: string;
  /** Секрет для локального trafficStats API (см. getTrafficStats). */
  trafficStatsSecret: string;
}

/**
 * Управляет процессом Hysteria2 (QUIC/UDP, самоподписанный сертификат без
 * домена) по образцу XrayService — как альтернативный протокол на случай,
 * если TCP-based VLESS+Reality режется DPI на конкретной сети клиента.
 * obfs=salamander дополнительно маскирует сигнатуру QUIC-хендшейка,
 * masquerade подставляет реальный сайт для нераспознанных подключений
 * (аналог decoy-поведения Reality).
 */
@Injectable()
export class HysteriaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HysteriaService.name);

  private readonly certPath = path.join(
    process.cwd(),
    '/configs/hysteria-cert.pem',
  );
  private readonly keyPath = path.join(
    process.cwd(),
    '/configs/hysteria-key.pem',
  );
  private readonly paramsPath = path.join(
    process.cwd(),
    '/configs/hysteria-params.json',
  );
  private readonly configPath = path.join(
    process.cwd(),
    '/configs/hysteria.yaml',
  );

  public readonly port = Number(process.env.HYSTERIA_PORT || 8443);
  private readonly host = process.env.HOST;
  private readonly masqueradeUrl =
    process.env.HYSTERIA_MASQUERADE_URL || 'https://www.wikipedia.org';
  /** Внутренний порт trafficStats API — только localhost, наружу не публикуется. */
  private readonly trafficStatsPort = Number(
    process.env.HYSTERIA_STATS_PORT || 8899,
  );
  /**
   * Заявленная клиенту пропускная способность — попадает в sing-box-подписку
   * (up_mbps/down_mbps) и включает Brutal-конгестию на клиенте. Сервер по
   * умолчанию (ignoreClientBandwidth=false) уважает эти значения, поэтому
   * правка hysteria.yaml не нужна. 0 = не задано → fallback на BBR (текущее
   * поведение). Выставлять ~80-90%% реального канала клиента, иначе Brutal
   * шлёт агрессивно и растёт loss.
   */
  private readonly upMbps = Number(process.env.HYSTERIA_UP_MBPS || 0);
  private readonly downMbps = Number(process.env.HYSTERIA_DOWN_MBPS || 0);

  private readonly mutex = new Mutex();

  private params!: IHysteriaParams;
  private clients: IHysteriaClient[] = [];

  private currentProc: ChildProcess | null = null;
  /** true во время намеренной остановки — чтобы обработчик exit не перезапускал. */
  private shuttingDown = false;
  /** Промис инициализации onModuleInit — см. аналогичное поле в XrayService. */
  private initPromise: Promise<void> = Promise.resolve();

  /** Подпись уже применённого набора клиентов — если новый совпадает, перезапуск пропускается. */
  private appliedSignature = '';
  /** Последний запрошенный набор — применяется одним перезапуском после дебаунса. */
  private pendingClients: IHysteriaClient[] | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadWaiters: Array<() => void> = [];

  async onModuleInit(): Promise<void> {
    if (!this.host) throw new Error('HOST в .env не задан');

    this.initPromise = this.mutex
      .runExclusive(async () => {
        await this.loadOrGenerateParams();
        await this.ensureCertificate();
        await this.writeConfig();
        this.startProcess();
      })
      .catch((error) => {
        this.logger.error(
          `Не удалось инициализировать Hysteria2: ${
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
   * Пересобрать список клиентов, переписать hysteria.yaml и перезапустить процесс.
   * Вызывается PeersService при старте и при добавлении/удалении пира.
   */
  async syncClients(clients: IHysteriaClient[]): Promise<void> {
    await this.initPromise;

    if (!this.params) {
      this.logger.warn(
        'Hysteria2 не инициализирован (нет параметров) — пропускаю синхронизацию клиентов',
      );
      return;
    }

    // No-op guard + дебаунс: userpass-набор встроен в hysteria.yaml, смена
    // требует перезаписи и перезапуска процесса — коалесцируем серию
    // изменений в один рестарт и пропускаем его, если набор не менялся.
    if (this.clientsSignature(clients) === this.appliedSignature) {
      return;
    }

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
  private clientsSignature(clients: IHysteriaClient[]): string {
    return clients
      .map((c) => `${c.name}:${c.password}`)
      .sort()
      .join('|');
  }

  /** Применяет последний отложенный набор одним перезапуском Hysteria. */
  private async applyReload(): Promise<void> {
    const clients = this.pendingClients;
    if (!clients) return;
    this.pendingClients = null;

    await this.mutex.runExclusive(async () => {
      this.clients = clients;
      await this.writeConfig();
      await this.stopProcess();
      this.startProcess();
    });
    this.appliedSignature = this.clientsSignature(clients);
    this.logger.log(`Hysteria2 синхронизирован: ${clients.length} клиент(ов)`);
  }

  /** Публичные параметры для сборки клиентской ссылки. */
  getPublicParams(): {
    host: string;
    port: number;
    obfsPassword: string;
    upMbps: number;
    downMbps: number;
  } {
    return {
      host: this.host as string,
      port: this.port,
      obfsPassword: this.params.obfsPassword,
      upMbps: this.upMbps,
      downMbps: this.downMbps,
    };
  }

  /**
   * hysteria2://-ссылка для клиента. insecure=1 обязателен — сертификат
   * самоподписанный (нет домена/CA), клиент штатно пропускает проверку
   * цепочки доверия в этом режиме.
   */
  buildClientLink(name: string, password: string): string {
    if (!this.params) {
      throw new Error(
        'Hysteria2 не инициализирован — невозможно собрать ссылку',
      );
    }

    const p = this.getPublicParams();
    const query = new URLSearchParams({
      insecure: '1',
      obfs: 'salamander',
      'obfs-password': p.obfsPassword,
      sni: p.host,
    });

    // auth.type: userpass на сервере требует "имя:пароль" в userinfo —
    // один пароль без имени пользователя сервер сопоставить не может
    // (аутентификация тихо падает и уходит в masquerade-фолбэк).
    const userinfo = `${encodeURIComponent(name)}:${encodeURIComponent(password)}`;

    return `hysteria2://${userinfo}@${p.host}:${p.port}/?${query.toString()}#${encodeURIComponent(
      name,
    )}`;
  }

  private async loadOrGenerateParams(): Promise<void> {
    if (existsSync(this.paramsPath)) {
      const raw = await readFile(this.paramsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IHysteriaParams>;

      if (parsed.obfsPassword && parsed.trafficStatsSecret) {
        this.params = {
          obfsPassword: parsed.obfsPassword,
          trafficStatsSecret: parsed.trafficStatsSecret,
        };
        return;
      }

      if (parsed.obfsPassword) {
        // Миграция со старого params-файла без trafficStatsSecret.
        this.params = {
          obfsPassword: parsed.obfsPassword,
          trafficStatsSecret: randomBytes(16).toString('hex'),
        };
        await writeFile(this.paramsPath, JSON.stringify(this.params, null, 2));
        return;
      }
    }

    this.params = {
      obfsPassword: randomBytes(16).toString('hex'),
      trafficStatsSecret: randomBytes(16).toString('hex'),
    };
    await writeFile(this.paramsPath, JSON.stringify(this.params, null, 2));
    this.logger.log('Сгенерирован новый obfs-пароль Hysteria2');
  }

  private async ensureCertificate(): Promise<void> {
    if (existsSync(this.certPath) && existsSync(this.keyPath)) return;

    await execAsync(
      `openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout ${this.keyPath} -out ${this.certPath} -days 3650 -subj "/CN=${this.host}"`,
    );
    this.logger.log('Сгенерирован самоподписанный сертификат для Hysteria2');
  }

  private buildServerConfig(): string {
    const lines: string[] = [
      `listen: :${this.port}`,
      '',
      'tls:',
      `  cert: ${this.certPath}`,
      `  key: ${this.keyPath}`,
      '',
      'auth:',
      '  type: userpass',
    ];

    // Hysteria2 фатально падает на старте, если auth.userpass пуст —
    // подставляем недостижимый плейсхолдер, пока нет реальных клиентов.
    lines.push('  userpass:');
    if (this.clients.length === 0) {
      lines.push(`    _placeholder: ${randomBytes(16).toString('hex')}`);
    } else {
      for (const client of this.clients) {
        lines.push(`    ${client.name}: ${client.password}`);
      }
    }

    lines.push(
      '',
      'obfs:',
      '  type: salamander',
      '  salamander:',
      `    password: ${this.params.obfsPassword}`,
      '',
      'masquerade:',
      '  type: proxy',
      '  proxy:',
      `    url: ${this.masqueradeUrl}`,
      '    rewriteHost: true',
      '',
      'trafficStats:',
      `  listen: 127.0.0.1:${this.trafficStatsPort}`,
      `  secret: ${this.params.trafficStatsSecret}`,
      '',
    );

    return lines.join('\n');
  }

  /**
   * Кумулятивный per-user трафик (растёт с момента старта процесса — не
   * дельта). Ключ Map — имя клиента (peer.name), как в auth.userpass.
   * Ошибка не должна ронять вызов — просто возвращаем пустую карту.
   */
  async getTrafficStats(): Promise<Map<string, { tx: number; rx: number }>> {
    const result = new Map<string, { tx: number; rx: number }>();

    if (!this.params) return result;

    try {
      const response = await fetch(
        `http://127.0.0.1:${this.trafficStatsPort}/traffic`,
        { headers: { Authorization: this.params.trafficStatsSecret } },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const parsed = (await response.json()) as Record<
        string,
        { tx: number; rx: number }
      >;

      for (const [name, stats] of Object.entries(parsed)) {
        result.set(name, stats);
      }
    } catch (error) {
      this.logger.warn(
        `Не удалось получить статистику Hysteria2: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }

    return result;
  }

  private async writeConfig(): Promise<void> {
    await writeFile(this.configPath, this.buildServerConfig());
  }

  private startProcess(): void {
    const proc = spawn('hysteria', ['server', '-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HYSTERIA_LOG_LEVEL: 'debug' },
    });
    this.currentProc = proc;

    proc.stdout?.on('data', (chunk: Buffer) =>
      this.logger.debug(`[hysteria] ${chunk.toString().trim()}`),
    );
    proc.stderr?.on('data', (chunk: Buffer) =>
      this.logger.warn(`[hysteria] ${chunk.toString().trim()}`),
    );
    proc.on('error', (error) =>
      this.logger.error(`Ошибка запуска hysteria: ${error.message}`),
    );
    proc.on('exit', (code, signal) => {
      if (this.currentProc === proc) this.currentProc = null;
      if (this.shuttingDown) return;

      this.logger.error(
        `Процесс hysteria завершился (code=${code}, signal=${signal}) — перезапуск через 2с`,
      );
      setTimeout(() => {
        if (!this.shuttingDown && !this.currentProc) this.startProcess();
      }, 2000);
    });

    this.logger.log(
      `hysteria запущен (pid=${proc.pid}), порт ${this.port}/udp`,
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
      // Страховка: если hysteria не завершился за 5с — убиваем принудительно.
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
