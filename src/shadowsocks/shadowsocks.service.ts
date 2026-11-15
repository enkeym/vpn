import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHmac, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { Mutex } from 'async-mutex';

const RELOAD_DEBOUNCE_MS = 1500;
const RESTART_DELAY_MS = 3000;
const MAX_RAPID_RESTARTS = 5;
const RAPID_RESTART_RESET_MS = 60_000;

export const SHADOWSOCKS_2022_AES_256_GCM = '2022-blake3-aes-256-gcm';
const SERVER_KEY_LABEL = 'shadowsocks-server-key';

export interface IShadowsocksClient {
  name: string;
}

export interface IShadowsocksPublicParams {
  host: string;
  port: number;
  method: string;
}

interface IShadowsocksSecrets {
  masterSecret: string;
}

@Injectable()
export class ShadowsocksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShadowsocksService.name);

  private readonly configPath = path.join(
    process.cwd(),
    '/configs/shadowsocks.json',
  );
  private readonly secretsPath = path.join(
    process.cwd(),
    '/configs/ss-auth.json',
  );

  public readonly port = Number(process.env.SS_PORT || 2096);
  private readonly method =
    process.env.SS_METHOD || SHADOWSOCKS_2022_AES_256_GCM;
  private readonly host = process.env.WG_HOST || '';
  private readonly shareLinksEnabled = process.env.SS_SHARE_LINKS !== 'false';

  private readonly mutex = new Mutex();

  private enabled = false;
  private secrets: IShadowsocksSecrets | null = null;

  private currentProc: ChildProcess | null = null;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private rapidRestarts = 0;

  private appliedSignature = '';
  private pendingClients: IShadowsocksClient[] | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadPromise: Promise<void> | null = null;

  private initPromise: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    if (process.env.SS_ENABLED === 'false') {
      this.logger.warn('Shadowsocks выключен (SS_ENABLED=false)');
      return;
    }

    if (!this.host) {
      this.logger.warn(
        'Shadowsocks не запущен: не задан WG_HOST — некуда указывать ссылку',
      );
      return;
    }

    if (!this.isBinaryAvailable()) {
      this.logger.warn(
        'Shadowsocks не запущен: бинарник ssserver не найден в образе',
      );
      return;
    }

    this.secrets = await this.loadOrGenerateSecrets();
    this.enabled = true;

    this.initPromise = this.mutex
      .runExclusive(() => this.applyClients([]))
      .catch((error: unknown) => {
        this.logger.error(
          `Shadowsocks не запустился: ${
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

  isShareLinkEnabled(): boolean {
    return this.enabled && this.shareLinksEnabled;
  }

  getPublicParams(): IShadowsocksPublicParams {
    return {
      host: this.host,
      port: this.port,
      method: this.method,
    };
  }

  getServerKey(): string | null {
    if (!this.secrets) return null;
    return createHmac('sha256', this.secrets.masterSecret)
      .update(SERVER_KEY_LABEL)
      .digest('base64');
  }

  getPeerKey(peerName: string): string | null {
    if (!this.secrets) return null;
    return createHmac('sha256', this.secrets.masterSecret)
      .update(peerName)
      .digest('base64');
  }

  buildShareLink(peerName: string): string | null {
    const peerKey = this.getPeerKey(peerName);
    if (!this.isShareLinkEnabled() || !peerKey) return null;

    const userInfo = Buffer.from(`${this.method}:${peerKey}`).toString(
      'base64url',
    );
    return `ss://${userInfo}@${this.host}:${this.port}#${encodeURIComponent(peerName)}`;
  }

  async syncClients(clients: IShadowsocksClient[]): Promise<void> {
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

  private isBinaryAvailable(): boolean {
    const probe = spawnSync('ssserver', ['--version'], { timeout: 5000 });
    return probe.status === 0;
  }

  private async loadOrGenerateSecrets(): Promise<IShadowsocksSecrets> {
    if (existsSync(this.secretsPath)) {
      const raw = await readFile(this.secretsPath, 'utf-8');
      return JSON.parse(raw) as IShadowsocksSecrets;
    }

    const secrets: IShadowsocksSecrets = {
      masterSecret: randomBytes(32).toString('hex'),
    };
    await writeFile(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: 0o600,
    });
    return secrets;
  }

  private signatureOf(clients: IShadowsocksClient[]): string {
    return clients
      .map((client) => `${client.name}:${this.getPeerKey(client.name)}`)
      .sort()
      .join('\n');
  }

  private async applyClients(clients: IShadowsocksClient[]): Promise<void> {
    if (!this.enabled || !this.secrets) return;

    const signature = this.signatureOf(clients);
    if (signature === this.appliedSignature && this.currentProc) return;

    if (clients.length === 0) {
      await this.stopProcess();
      await unlink(this.configPath).catch(() => undefined);
      this.appliedSignature = signature;
      return;
    }

    await writeFile(
      this.configPath,
      JSON.stringify(this.buildConfig(clients), null, 2),
    );

    const wasRunning = Boolean(this.currentProc);
    await this.restartProcess();
    this.appliedSignature = signature;
    this.logger.log(
      `Shadowsocks: ${clients.length} пиров, ${wasRunning ? 'перезапуск' : 'старт'} на TCP/UDP :${this.port}`,
    );
  }

  private buildConfig(clients: IShadowsocksClient[]): Record<string, unknown> {
    return {
      servers: [
        {
          server: '::',
          server_port: this.port,
          method: this.method,
          password: this.getServerKey(),
          mode: 'tcp_and_udp',
          users: clients.map((client) => ({
            name: client.name,
            password: this.getPeerKey(client.name),
          })),
        },
      ],
    };
  }

  private async restartProcess(): Promise<void> {
    await this.stopProcess();

    const proc = spawn('ssserver', ['-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentProc = proc;
    const steadyTimer = setTimeout(() => {
      this.rapidRestarts = 0;
    }, RAPID_RESTART_RESET_MS);
    steadyTimer.unref();

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.logger.debug(`[ssserver] ${text}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.logger.debug(`[ssserver] ${text}`);
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(steadyTimer);
      if (this.currentProc !== proc) return;
      this.currentProc = null;
      if (this.shuttingDown) return;

      this.logger.warn(
        `Shadowsocks завершился (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;

    this.rapidRestarts++;
    if (this.rapidRestarts > MAX_RAPID_RESTARTS) {
      this.logger.error(
        `Shadowsocks падает больше ${MAX_RAPID_RESTARTS} раз подряд — перезапуск остановлен, проверьте конфиг ${this.configPath}`,
      );
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartProcess().catch((error: unknown) => {
        this.logger.error(
          `Не удалось перезапустить Shadowsocks: ${
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
