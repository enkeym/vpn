import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import axios from 'axios';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHmac, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { Mutex } from 'async-mutex';

const RELOAD_DEBOUNCE_MS = 1500;
const RESTART_DELAY_MS = 3000;
const MAX_RAPID_RESTARTS = 5;
const RAPID_RESTART_RESET_MS = 60_000;
const PASSWORD_HEX_LENGTH = 32;

export interface IHysteriaClient {
  name: string;
}

export interface IHysteriaPublicParams {
  host: string;
  port: number;
  sni: string;
  obfsPassword: string | null;
}

interface IHysteriaSecrets {
  passwordSecret: string;
  obfsPassword: string;
  statsSecret: string;
}

@Injectable()
export class HysteriaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HysteriaService.name);

  private readonly configPath = path.join(
    process.cwd(),
    '/configs/hysteria.yaml',
  );
  private readonly secretsPath = path.join(
    process.cwd(),
    '/configs/hysteria-auth.json',
  );

  public readonly port = Number(process.env.HY2_PORT || 443);
  private readonly sni =
    process.env.HY2_SNI || process.env.XRAY_REALITY_SNI || 'r.enkeym.site';
  private readonly statsPort = Number(process.env.HY2_STATS_PORT || 9999);
  private readonly obfsEnabled = process.env.HY2_OBFS !== 'false';
  private readonly certPath =
    process.env.HY2_CERT || path.join(process.cwd(), '/configs/steal-cert.pem');
  private readonly keyPath =
    process.env.HY2_KEY || path.join(process.cwd(), '/configs/steal-key.pem');
  private readonly host = process.env.WG_HOST || '';

  private readonly mutex = new Mutex();

  private enabled = false;
  private secrets: IHysteriaSecrets | null = null;

  private currentProc: ChildProcess | null = null;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private rapidRestarts = 0;

  private appliedSignature = '';
  private pendingClients: IHysteriaClient[] | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadPromise: Promise<void> | null = null;

  private initPromise: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    if (process.env.HY2_ENABLED === 'false') {
      this.logger.warn('Hysteria2 выключен (HY2_ENABLED=false)');
      return;
    }

    if (!this.host) {
      this.logger.warn(
        'Hysteria2 не запущен: не задан WG_HOST — некуда указывать ссылку',
      );
      return;
    }

    if (!this.isBinaryAvailable()) {
      this.logger.warn(
        'Hysteria2 не запущен: бинарник hysteria не найден в образе',
      );
      return;
    }

    if (!existsSync(this.certPath) || !existsSync(this.keyPath)) {
      this.logger.warn(
        `Hysteria2 не запущен: нет TLS-сертификата ${this.certPath} / ${this.keyPath}`,
      );
      return;
    }

    this.secrets = await this.loadOrGenerateSecrets();
    this.enabled = true;

    this.initPromise = this.mutex
      .runExclusive(() => this.applyClients([]))
      .catch((error: unknown) => {
        this.logger.error(
          `Hysteria2 не запустился: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    await this.initPromise;
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.stopProcess();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPublicParams(): IHysteriaPublicParams {
    return {
      host: this.host,
      port: this.port,
      sni: this.sni,
      obfsPassword: this.obfsEnabled
        ? (this.secrets?.obfsPassword ?? null)
        : null,
    };
  }

  getPassword(peerName: string): string | null {
    if (!this.secrets) return null;
    return createHmac('sha256', this.secrets.passwordSecret)
      .update(peerName)
      .digest('hex')
      .slice(0, PASSWORD_HEX_LENGTH);
  }

  buildShareLink(peerName: string): string | null {
    const password = this.getPassword(peerName);
    if (!this.enabled || !password) return null;

    const params = new URLSearchParams({ sni: this.sni, insecure: '0' });
    const obfsPassword = this.getPublicParams().obfsPassword;
    if (obfsPassword) {
      params.set('obfs', 'salamander');
      params.set('obfs-password', obfsPassword);
    }

    return `hysteria2://${password}@${this.host}:${this.port}/?${params.toString()}#${encodeURIComponent(peerName)}`;
  }

  async syncClients(clients: IHysteriaClient[]): Promise<void> {
    await this.initPromise;
    if (!this.enabled) return;

    this.pendingClients = clients;

    if (this.reloadTimer) return this.reloadPromise ?? undefined;

    const promise = new Promise<void>((resolve, reject) => {
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        const pending = this.pendingClients ?? [];
        this.mutex
          .runExclusive(() => this.applyClients(pending))
          .then(resolve, (error: unknown) =>
            reject(error instanceof Error ? error : new Error(String(error))),
          );
      }, RELOAD_DEBOUNCE_MS);
    });
    this.reloadPromise = promise;

    try {
      await promise;
    } finally {
      if (this.reloadPromise === promise) this.reloadPromise = null;
    }
  }

  async getTrafficStats(): Promise<
    Map<string, { uplink: number; downlink: number }>
  > {
    const result = new Map<string, { uplink: number; downlink: number }>();
    if (!this.enabled || !this.secrets) return result;

    try {
      const { data } = await axios.get<
        Record<string, { tx?: number; rx?: number }>
      >(`http://127.0.0.1:${this.statsPort}/traffic`, {
        headers: { Authorization: this.secrets.statsSecret },
        timeout: 5000,
      });

      for (const [user, stats] of Object.entries(data ?? {})) {
        result.set(user, {
          uplink: Number(stats.tx ?? 0),
          downlink: Number(stats.rx ?? 0),
        });
      }
    } catch (error) {
      this.logger.warn(
        `Не удалось получить статистику Hysteria2: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return result;
  }

  private isBinaryAvailable(): boolean {
    const probe = spawnSync('hysteria', ['version'], { timeout: 5000 });
    return probe.status === 0;
  }

  private async loadOrGenerateSecrets(): Promise<IHysteriaSecrets> {
    if (existsSync(this.secretsPath)) {
      const raw = await readFile(this.secretsPath, 'utf-8');
      return JSON.parse(raw) as IHysteriaSecrets;
    }

    const secrets: IHysteriaSecrets = {
      passwordSecret: randomBytes(32).toString('hex'),
      obfsPassword: randomBytes(16).toString('hex'),
      statsSecret: randomBytes(24).toString('hex'),
    };
    await writeFile(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: 0o600,
    });
    return secrets;
  }

  private signatureOf(clients: IHysteriaClient[]): string {
    return clients
      .map((client) => `${client.name}:${this.getPassword(client.name)}`)
      .sort()
      .join('\n');
  }

  private async applyClients(clients: IHysteriaClient[]): Promise<void> {
    if (!this.enabled || !this.secrets) return;

    const signature = this.signatureOf(clients);
    if (signature === this.appliedSignature && this.currentProc) return;

    await writeFile(this.configPath, this.buildConfig(clients));

    const wasRunning = Boolean(this.currentProc);
    await this.restartProcess();
    this.appliedSignature = signature;
    this.logger.log(
      `Hysteria2: ${clients.length} пиров, ${wasRunning ? 'перезапуск' : 'старт'} на UDP :${this.port}`,
    );
  }

  private buildConfig(clients: IHysteriaClient[]): string {
    const lines: string[] = [
      `listen: :${this.port}`,
      '',
      'tls:',
      `  cert: ${JSON.stringify(this.certPath)}`,
      `  key: ${JSON.stringify(this.keyPath)}`,
      '',
      'auth:',
      '  type: userpass',
    ];

    if (clients.length === 0) {
      lines.push('  userpass: {}');
    } else {
      lines.push('  userpass:');
      for (const client of clients) {
        const password = this.getPassword(client.name);
        if (!password) continue;
        lines.push(
          `    ${JSON.stringify(client.name)}: ${JSON.stringify(password)}`,
        );
      }
    }

    if (this.secrets && this.obfsEnabled) {
      lines.push(
        '',
        'obfs:',
        '  type: salamander',
        '  salamander:',
        `    password: ${JSON.stringify(this.secrets.obfsPassword)}`,
      );
    }

    lines.push(
      '',
      'masquerade:',
      '  type: proxy',
      '  proxy:',
      `    url: ${JSON.stringify(`https://${this.sni}`)}`,
      '    insecure: true',
    );

    if (this.secrets) {
      lines.push(
        '',
        'trafficStats:',
        `  listen: 127.0.0.1:${this.statsPort}`,
        `  secret: ${JSON.stringify(this.secrets.statsSecret)}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }

  private async restartProcess(): Promise<void> {
    await this.stopProcess();

    const proc = spawn('hysteria', ['server', '-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentProc = proc;
    const steadyTimer = setTimeout(() => {
      this.rapidRestarts = 0;
    }, RAPID_RESTART_RESET_MS);
    steadyTimer.unref();

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.logger.debug(`[hysteria] ${text}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.logger.debug(`[hysteria] ${text}`);
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(steadyTimer);
      if (this.currentProc === proc) this.currentProc = null;
      if (this.shuttingDown) return;

      this.logger.warn(
        `Hysteria2 завершился (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;

    this.rapidRestarts++;
    if (this.rapidRestarts > MAX_RAPID_RESTARTS) {
      this.logger.error(
        `Hysteria2 падает больше ${MAX_RAPID_RESTARTS} раз подряд — перезапуск остановлен, проверьте конфиг ${this.configPath}`,
      );
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartProcess().catch((error: unknown) => {
        this.logger.error(
          `Не удалось перезапустить Hysteria2: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, RESTART_DELAY_MS);
  }

  private async stopProcess(): Promise<void> {
    const proc = this.currentProc;
    if (!proc) return;

    this.currentProc = null;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.once('exit', done);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
        resolve();
      }, 5000).unref();
    });
  }
}
