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

/** Клиент Hysteria2: имя пира и его userpass-пароль. */
export interface IHysteriaClient {
  name: string;
  password: string;
}

interface IHysteriaParams {
  obfsPassword: string;
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
  private readonly host = process.env.WG_HOST;
  private readonly masqueradeUrl =
    process.env.HYSTERIA_MASQUERADE_URL || 'https://www.wikipedia.org';

  private readonly mutex = new Mutex();

  private params!: IHysteriaParams;
  private clients: IHysteriaClient[] = [];

  private currentProc: ChildProcess | null = null;
  /** true во время намеренной остановки — чтобы обработчик exit не перезапускал. */
  private shuttingDown = false;
  /** Промис инициализации onModuleInit — см. аналогичное поле в XrayService. */
  private initPromise: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    if (!this.host) throw new Error('WG_HOST в .env не задан');

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

    await this.mutex.runExclusive(async () => {
      this.clients = clients;
      await this.writeConfig();
      await this.stopProcess();
      this.startProcess();
    });
    this.logger.log(`Hysteria2 синхронизирован: ${clients.length} клиент(ов)`);
  }

  /** Публичные параметры для сборки клиентской ссылки. */
  getPublicParams(): { host: string; port: number; obfsPassword: string } {
    return {
      host: this.host as string,
      port: this.port,
      obfsPassword: this.params.obfsPassword,
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

    return `hysteria2://${encodeURIComponent(password)}@${p.host}:${p.port}/?${query.toString()}#${encodeURIComponent(
      name,
    )}`;
  }

  private async loadOrGenerateParams(): Promise<void> {
    if (existsSync(this.paramsPath)) {
      const raw = await readFile(this.paramsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IHysteriaParams>;

      if (parsed.obfsPassword) {
        this.params = { obfsPassword: parsed.obfsPassword };
        return;
      }
    }

    this.params = { obfsPassword: randomBytes(16).toString('hex') };
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
    );

    return lines.join('\n');
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
