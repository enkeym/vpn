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

/**
 * Постоянные параметры Reality-сервера. Приватный ключ x25519 живёт только на
 * сервере, публичный (pbk) и shortId раздаются клиентам в vless://-ссылке.
 * Генерируются один раз и хранятся в configs/xray-reality.json, чтобы
 * переживать рестарт (как H1-H4/I1-I5 у AmneziaWG).
 */
export interface IXrayRealityParams {
  privateKey: string;
  publicKey: string;
  shortId: string;
}

/** Клиент Reality: имя пира и его VLESS-UUID (id из БД). */
export interface IXrayClient {
  name: string;
  uuid: string;
}

interface IXrayInboundClient {
  id: string;
  flow: string;
}

/**
 * Управляет процессом Xray-core (VLESS + XTLS-Reality) по образцу WgService:
 * генерирует/читает Reality-ключи, собирает configs/xray.json из списка
 * клиентов и надзирает за дочерним процессом `xray`, перезапуская его при
 * падении или изменении списка пиров.
 */
@Injectable()
export class XrayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XrayService.name);

  private readonly paramsPath = path.join(
    process.cwd(),
    '/configs/xray-reality.json',
  );
  private readonly configPath = path.join(process.cwd(), '/configs/xray.json');

  public readonly port = Number(process.env.XRAY_PORT || 443);
  private readonly host = process.env.WG_HOST;
  private readonly realityDest =
    process.env.XRAY_REALITY_DEST || 'www.microsoft.com:443';
  private readonly realitySni =
    process.env.XRAY_REALITY_SNI || 'www.microsoft.com';

  private readonly mutex = new Mutex();

  private params!: IXrayRealityParams;
  private clients: IXrayClient[] = [];

  private currentProc: ChildProcess | null = null;
  /** true во время намеренной остановки — чтобы обработчик exit не перезапускал. */
  private shuttingDown = false;

  async onModuleInit(): Promise<void> {
    if (!this.host) throw new Error('WG_HOST в .env не задан');

    // Ошибка инициализации Xray не должна ронять весь бот (AWG и остальное
    // продолжают работать) — логируем и продолжаем, Reality поднимется после
    // исправления окружения.
    try {
      await this.mutex.runExclusive(async () => {
        await this.loadOrGenerateRealityParams();
        await this.writeConfig();
        this.startProcess();
      });
    } catch (error) {
      this.logger.error(
        `Не удалось инициализировать Xray/Reality: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopProcess();
  }

  /**
   * Пересобрать список клиентов, переписать xray.json и перезапустить процесс.
   * Вызывается PeersService при старте и при добавлении/удалении пира.
   */
  async syncClients(clients: IXrayClient[]): Promise<void> {
    if (!this.params) {
      this.logger.warn(
        'Reality не инициализирован (нет ключей) — пропускаю синхронизацию клиентов',
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

  /** Публичные параметры для сборки клиентской ссылки. */
  getPublicParams(): {
    host: string;
    port: number;
    publicKey: string;
    shortId: string;
    sni: string;
  } {
    return {
      host: this.host as string,
      port: this.port,
      publicKey: this.params.publicKey,
      shortId: this.params.shortId,
      sni: this.realitySni,
    };
  }

  /**
   * vless://-ссылка для клиента (v2rayNG / Hiddify / NekoBox / sing-box).
   * flow=xtls-rprx-vision + fp=chrome — актуальный набор против DPI ТСПУ.
   */
  buildClientLink(name: string, uuid: string): string {
    if (!this.params) {
      throw new InternalServerErrorException(
        'Reality не инициализирован — невозможно собрать vless-ссылку',
      );
    }

    const p = this.getPublicParams();
    const query = new URLSearchParams({
      type: 'tcp',
      security: 'reality',
      encryption: 'none',
      pbk: p.publicKey,
      fp: 'chrome',
      sni: p.sni,
      sid: p.shortId,
      flow: 'xtls-rprx-vision',
    });

    return `vless://${uuid}@${p.host}:${p.port}?${query.toString()}#${encodeURIComponent(
      name,
    )}`;
  }

  private async loadOrGenerateRealityParams(): Promise<void> {
    if (existsSync(this.paramsPath)) {
      const raw = await readFile(this.paramsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IXrayRealityParams>;

      if (parsed.privateKey && parsed.publicKey && parsed.shortId) {
        this.params = {
          privateKey: parsed.privateKey,
          publicKey: parsed.publicKey,
          shortId: parsed.shortId,
        };
        return;
      }

      this.logger.warn(
        'configs/xray-reality.json неполный — регенерирую Reality-ключи (все клиенты должны заново скачать конфиг)',
      );
    }

    this.params = await this.generateRealityParams();
    await writeFile(this.paramsPath, JSON.stringify(this.params, null, 2));
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
      flow: 'xtls-rprx-vision',
    }));

    return {
      log: { loglevel: 'warning' },
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
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              show: false,
              dest: this.realityDest,
              xver: 0,
              serverNames: [this.realitySni],
              privateKey: this.params.privateKey,
              shortIds: ['', this.params.shortId],
            },
          },
          sniffing: {
            enabled: true,
            destOverride: ['http', 'tls', 'quic'],
          },
        },
      ],
      outbounds: [
        { protocol: 'freedom', tag: 'direct' },
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
