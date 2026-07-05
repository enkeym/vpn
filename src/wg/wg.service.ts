import {
  Injectable,
  OnModuleInit,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { WgConfig } from 'wireguard-tools';
import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { randomInt } from 'crypto';
import { getNextFreeIp, parseWgConfig } from './wg.utils';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { Mutex } from 'async-mutex';

const execAsync = promisify(exec);

interface ICredentialsProps {
  publicKey: string;
  privateKey: string;
  presharedKey: string;
  ip: string;
}

export interface IClientConfigProps {
  privateKey: string;
  presharedKey: string | null;
  ip: string;
  /** Endpoint из БД пира; по умолчанию — текущий host:port сервера */
  endpoint?: string;
}

export interface IDbPeer {
  name: string;
  publicKey: string;
  presharedKey: string;
  ip: string;
}

export interface IWgPeerRuntimeStats {
  publicKey: string;
  latestHandshakeAt: Date | null;
  rxBytes: number;
  txBytes: number;
}

interface ParsedConfigCache {
  config: WgConfig;
  timestamp: number;
}

interface IAwgParams {
  Jc: number;
  Jmin: number;
  Jmax: number;
  S1: number;
  S2: number;
  H1: number;
  H2: number;
  H3: number;
  H4: number;
  I1: string;
  I2: string;
  I3: string;
  I4: string;
  I5: string;
}

@Injectable()
export class WgService implements OnModuleInit {
  private readonly logger = new Logger(WgService.name);

  private readonly filePath = path.join(process.cwd(), '/configs/wg0.conf');
  private readonly interfaceAddress = '10.8.0.1/16';
  private readonly allowedIps = process.env.WG_ALLOWED_IPS || '0.0.0.0/0';
  private readonly clientDns = '1.1.1.1, 8.8.8.8';

  public readonly port = Number(process.env.WG_PORT || 443);
  public readonly host = process.env.WG_HOST;

  private _serverPublicKeyCache: string | null = null;
  private readonly configMutex = new Mutex();

  // Кеш парсированного конфига для избежания повторного парсинга
  private configCache: ParsedConfigCache | null = null;
  private readonly CONFIG_CACHE_TTL = 30 * 1000; // 30 секунд

  // Параметры обфускации AmneziaWG: одинаковы на сервере и во всех клиентских
  // конфигах. Jc/Jmin/Jmax/S1/S2 — фиксированные безопасные значения,
  // H1-H4 и I1-I5 генерируются один раз и хранятся в wg0.conf (переживают рестарт).
  private awgParams!: IAwgParams;

  async onModuleInit() {
    if (!this.host) throw new Error(`WG_HOST в .env не задан`);

    await this.configMutex.runExclusive(async () => {
      await this.loadOrGenerateAwgParams();
      await this.generateServerConfig();
      await this.syncListenPort();
      await this.getServerPublicKey();
      await this.startInterfaceUp();
      await this.syncSystem();
    });
  }

  private async generateServerConfig() {
    if (existsSync(this.filePath)) {
      this.logger.log(`Конфиг найден: ${this.filePath}`);
      return;
    }

    const server = new WgConfig({
      filePath: this.filePath,
      wgInterface: {
        address: [this.interfaceAddress],
        listenPort: this.port,
        postUp: [
          'iptables -A FORWARD -i %i -j ACCEPT',
          'iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE',
        ],
        postDown: [
          'iptables -D FORWARD -i %i -j ACCEPT',
          'iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE',
        ],
      },
    });

    await server.generateKeys();
    await this.writeServerConfig(server);

    this.logger.log(`Серверная конфигурация создана: ${this.filePath}`);
  }

  /**
   * generateServerConfig() пишет ListenPort только при создании нового файла,
   * поэтому смена WG_PORT в .env не влияет на уже существующий wg0.conf —
   * приводим ListenPort в файле в соответствие с текущим env перед подъёмом интерфейса.
   */
  private async syncListenPort(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    const raw = await readFile(this.filePath, 'utf-8');
    const match = raw.match(/^ListenPort\s*=\s*(\d+)/m);
    const currentPort = match ? Number(match[1]) : null;

    if (currentPort === this.port) return;

    this.logger.warn(
      `ListenPort в wg0.conf (${currentPort}) не совпадает с WG_PORT (${this.port}) — обновляю`,
    );
    const patched = raw.replace(
      /^ListenPort\s*=\s*\d+/m,
      `ListenPort = ${this.port}`,
    );
    await writeFile(this.filePath, patched);
  }

  /**
   * Получить парсированный конфиг с кешированием
   */
  private async getConfig(): Promise<WgConfig> {
    const now = Date.now();

    // Проверяем кеш
    if (
      this.configCache &&
      now - this.configCache.timestamp < this.CONFIG_CACHE_TTL
    ) {
      return this.configCache.config;
    }

    // Парсим конфиг и сохраняем в кеш
    const config = await parseWgConfig(this.filePath);
    this.configCache = { config, timestamp: now };

    return config;
  }

  /**
   * Инвалидировать кеш конфига
   */
  private invalidateConfigCache(): void {
    this.configCache = null;
  }

  private buildAwgConfigBlock(params: IAwgParams): string {
    return [
      `Jc = ${params.Jc}`,
      `Jmin = ${params.Jmin}`,
      `Jmax = ${params.Jmax}`,
      `S1 = ${params.S1}`,
      `S2 = ${params.S2}`,
      `H1 = ${params.H1}`,
      `H2 = ${params.H2}`,
      `H3 = ${params.H3}`,
      `H4 = ${params.H4}`,
      `I1 = ${params.I1}`,
      `I2 = ${params.I2}`,
      `I3 = ${params.I3}`,
      `I4 = ${params.I4}`,
      `I5 = ${params.I5}`,
    ].join('\n');
  }

  private generateAwgParams(): IAwgParams {
    const usedHeaders = new Set<number>();
    const nextHeader = () => {
      let value: number;
      do {
        value = randomInt(5, 2 ** 31 - 1);
      } while (usedHeaders.has(value));
      usedHeaders.add(value);
      return value;
    };

    return {
      Jc: 4,
      Jmin: 40,
      Jmax: 70,
      S1: 50,
      S2: 100,
      H1: nextHeader(),
      H2: nextHeader(),
      H3: nextHeader(),
      H4: nextHeader(),
      ...this.generateAwgSignaturePackets(),
    };
  }

  /**
   * I1-I5 — сигнатурные пакеты AmneziaWG 2.0 (CPS-формат). I1 маскирует
   * хендшейк под QUIC Initial-пакет (первый байт и версия рандомизируются
   * при генерации, чтобы не превратиться в общий для всех отпечаток —
   * пример из документации Amnezia использует фиксированные байты и явно
   * не годится для прямого копирования). I2-I5 добавляют энтропию.
   * Теги <r>/<t>/<rc>/<rd> разворачивает в случайные байты amneziawg-go
   * на лету при отправке каждого пакета, поэтому сами строки — шаблон,
   * а не готовые данные.
   */
  private generateAwgSignaturePackets(): Pick<
    IAwgParams,
    'I1' | 'I2' | 'I3' | 'I4' | 'I5'
  > {
    const quicFirstBytes = [0xc0, 0xc1, 0xc2, 0xc3];
    const quicFirstByte = quicFirstBytes[randomInt(0, quicFirstBytes.length)]
      .toString(16)
      .padStart(2, '0');
    const quicVersions = ['00000001', '6b3343cf'];
    const quicVersion = quicVersions[randomInt(0, quicVersions.length)];
    // <r N> ограничен документацией AmneziaWG значением 1000 — превышение
    // приводило к "Unknown section" при импорте в мобильном приложении.
    const i1BodyLen = randomInt(900, 1000);

    return {
      I1: `<b 0x${quicFirstByte}${quicVersion}><r ${i1BodyLen}><t>`,
      I2: `<r ${randomInt(80, 200)}><rd ${randomInt(4, 12)}>`,
      I3: `<rc ${randomInt(8, 24)}><r ${randomInt(60, 150)}><t>`,
      I4: `<r ${randomInt(100, 250)}>`,
      I5: `<rd ${randomInt(4, 10)}><rc ${randomInt(4, 10)}><r ${randomInt(80, 180)}><t>`,
    };
  }

  private parseAwgParamsFromFile(raw: string): IAwgParams | null {
    const getNumber = (key: string) => {
      const match = raw.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'));
      return match ? Number(match[1]) : undefined;
    };

    const getString = (key: string) => {
      const match = raw.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
      return match ? match[1].trim() : undefined;
    };

    const params = {
      Jc: getNumber('Jc'),
      Jmin: getNumber('Jmin'),
      Jmax: getNumber('Jmax'),
      S1: getNumber('S1'),
      S2: getNumber('S2'),
      H1: getNumber('H1'),
      H2: getNumber('H2'),
      H3: getNumber('H3'),
      H4: getNumber('H4'),
      I1: getString('I1'),
      I2: getString('I2'),
      I3: getString('I3'),
      I4: getString('I4'),
      I5: getString('I5'),
    };

    if (Object.values(params).some((value) => value === undefined)) {
      return null;
    }

    return params as IAwgParams;
  }

  /**
   * H1-H4 должны быть одинаковыми на сервере и у всех клиентов, поэтому
   * генерируются один раз при первом старте и затем читаются из wg0.conf.
   * Если конфиг уже существует (миграция со старого WireGuard-конфига без
   * этих полей), параметры генерируются и дописываются в него на месте —
   * список пиров при этом не трогается.
   */
  private async loadOrGenerateAwgParams(): Promise<void> {
    if (!existsSync(this.filePath)) {
      this.awgParams = this.generateAwgParams();
      return;
    }

    const raw = await readFile(this.filePath, 'utf-8');
    const parsed = this.parseAwgParamsFromFile(raw);

    if (parsed) {
      this.awgParams = parsed;
      return;
    }

    this.logger.warn(
      'В wg0.conf отсутствуют параметры обфускации AmneziaWG — генерирую и дописываю (миграция со старого конфига). Все клиенты должны заново скачать конфиг.',
    );
    this.awgParams = this.generateAwgParams();

    const patched = raw.replace(
      '[Interface]',
      `[Interface]\n${this.buildAwgConfigBlock(this.awgParams)}`,
    );
    await writeFile(this.filePath, patched);
  }

  /**
   * wireguard-tools при каждом writeToFile() перегенерирует файл из объекта
   * WgConfig и не знает о полях AmneziaWG, поэтому они всегда дописываются
   * повторно после стандартной записи.
   */
  private async writeServerConfig(server: WgConfig): Promise<void> {
    await server.writeToFile();

    const raw = await readFile(this.filePath, 'utf-8');
    const patched = raw.replace(
      '[Interface]',
      `[Interface]\n${this.buildAwgConfigBlock(this.awgParams)}`,
    );

    await writeFile(this.filePath, patched);
  }

  public async getServerPublicKey(): Promise<string> {
    if (this._serverPublicKeyCache) {
      return this._serverPublicKeyCache;
    }

    const server = await this.getConfig();
    const privateKey = server.wgInterface.privateKey;

    if (!privateKey) {
      throw new InternalServerErrorException(
        'Приватный ключ сервера не найден в конфиге',
      );
    }

    const WG_KEY_REGEX = /^[A-Za-z0-9+/]{42,43}={0,2}$/;
    if (!WG_KEY_REGEX.test(privateKey)) {
      throw new InternalServerErrorException(
        'Неверный формат приватного ключа',
      );
    }

    try {
      const publicKey = await new Promise<string>((resolve, reject) => {
        const proc = spawn('wg', ['pubkey'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        proc.stdout?.on('data', (chunk) => (stdout += chunk));
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`wg pubkey exited with code ${code}`));
        });
        proc.stdin?.write(privateKey + '\n');
        proc.stdin?.end();
      });
      this._serverPublicKeyCache = publicKey;
      return publicKey;
    } catch (error) {
      throw new InternalServerErrorException(
        `Ошибка получения публичного ключа: ${error}`,
      );
    }
  }

  private async isInterfaceUp() {
    try {
      await execAsync('ip link show wg0');
      return true;
    } catch {
      return false;
    }
  }

  private async syncSystem() {
    const tmpConfigPath = path.join(
      os.tmpdir(),
      `wg0-stripped-${Date.now()}-${process.pid}.conf`,
    );

    try {
      const { stdout: stripped } = await execAsync(
        `awg-quick strip ${this.filePath}`,
      );
      await writeFile(tmpConfigPath, stripped);
      await execAsync(`sudo awg syncconf wg0 ${tmpConfigPath}`);
      this.logger.log('Интерфейс wg0 синхронизирован');
    } catch (error) {
      this.logger.error(
        `Ошибка синхронизации WireGuard: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      await unlink(tmpConfigPath).catch(() => {});
    }
  }

  private async startInterfaceUp() {
    if (await this.isInterfaceUp()) {
      this.logger.log('Интерфейс wg0 уже активен');
      return;
    }

    try {
      await execAsync(`sudo awg-quick up ${this.filePath}`);
      this.logger.log('Интерфейс wg0 успешно поднят');
    } catch (error) {
      try {
        await execAsync(`sudo awg-quick down ${this.filePath}`);
      } catch {}

      throw new Error(
        `Не удалось поднять интерфейс: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async getPeerRuntimeStats(): Promise<Map<string, IWgPeerRuntimeStats>> {
    try {
      const { stdout } = await execAsync('awg show wg0 dump');
      const lines = stdout.trim().split('\n').filter(Boolean);
      const stats = new Map<string, IWgPeerRuntimeStats>();

      for (const line of lines.slice(1)) {
        const fields = line.split('\t');
        const publicKey = fields[0];
        const latestHandshake = Number(fields[4] || 0);
        const rxBytes = Number(fields[5] || 0);
        const txBytes = Number(fields[6] || 0);

        if (!publicKey) continue;

        stats.set(publicKey, {
          publicKey,
          latestHandshakeAt:
            latestHandshake > 0 ? new Date(latestHandshake * 1000) : null,
          rxBytes: Number.isFinite(rxBytes) ? rxBytes : 0,
          txBytes: Number.isFinite(txBytes) ? txBytes : 0,
        });
      }

      return stats;
    } catch (error) {
      this.logger.error(
        `Ошибка получения статистики WireGuard: ${error instanceof Error ? error.message : error}`,
      );
      return new Map();
    }
  }

  async generateClientCredentials(
    usedIpsFromDb: Set<string>,
  ): Promise<ICredentialsProps> {
    const server = await this.getConfig();
    const serverIps =
      server.wgInterface.address?.map((address) => address.split('/')[0]) || [];

    serverIps.forEach((ip) => usedIpsFromDb.add(ip));

    const clientIp = getNextFreeIp(usedIpsFromDb);
    const clientWg = new WgConfig({});
    await clientWg.generateKeys({ preSharedKey: true });

    if (
      !clientWg.publicKey ||
      !clientWg.wgInterface.privateKey ||
      !clientWg.preSharedKey
    ) {
      throw new BadRequestException('Не удалось сгенерировать ключи клиента');
    }

    return {
      publicKey: clientWg.publicKey,
      privateKey: clientWg.wgInterface.privateKey,
      presharedKey: clientWg.preSharedKey,
      ip: clientIp,
    };
  }

  async createClientConfig(name: string, credentials: ICredentialsProps) {
    return await this.configMutex.runExclusive(async () => {
      // Инвалидируем кеш перед изменениями
      this.invalidateConfigCache();

      const server = await this.getConfig();

      server.addPeer({
        publicKey: credentials.publicKey,
        preSharedKey: credentials.presharedKey,
        allowedIps: [`${credentials.ip}/32`],
      });

      await this.writeServerConfig(server);
      this.logger.log(`Клиент ${name} добавлен в конфиг: ${credentials.ip}`);

      // Инвалидируем кеш после записи
      this.invalidateConfigCache();

      await this.syncSystem();

      return this.buildClientConfigString({
        privateKey: credentials.privateKey,
        presharedKey: credentials.presharedKey,
        ip: credentials.ip,
      });
    });
  }

  /**
   * Собирает строку клиентского конфига AmneziaWG.
   * Единый формат для создания пира, QR-кода и повторной выдачи файла —
   * AWG-блок обфускации обязан присутствовать везде, иначе handshake не пройдёт.
   */
  async buildClientConfigString(props: IClientConfigProps): Promise<string> {
    const serverPublicKey = await this.getServerPublicKey();

    return `[Interface]
PrivateKey = ${props.privateKey}
Address = ${props.ip}/32
DNS = ${this.clientDns}
MTU = 1420
${this.buildAwgConfigBlock(this.awgParams)}

[Peer]
PublicKey = ${serverPublicKey}
PresharedKey = ${props.presharedKey}
Endpoint = ${props.endpoint ?? `${this.host}:${this.port}`}
AllowedIPs = ${this.allowedIps}
PersistentKeepalive = 25
`;
  }

  async removePeer(publicKey: string) {
    return this.removePeers([publicKey]);
  }

  async removePeers(publicKeys: string[]): Promise<void> {
    if (publicKeys.length === 0) return;

    return await this.configMutex.runExclusive(async () => {
      this.invalidateConfigCache();

      const server = await this.getConfig();
      const keysSet = new Set(publicKeys);

      if (
        server.peers?.some(
          (peer) => peer.publicKey && keysSet.has(peer.publicKey),
        )
      ) {
        server.peers = server.peers.filter(
          (peer) => !peer.publicKey || !keysSet.has(peer.publicKey),
        );

        await this.writeServerConfig(server);
        this.invalidateConfigCache();
        await this.syncSystem();
        this.logger.log(`Удалено пиров из WG: ${publicKeys.length}`);
      }
    });
  }

  async restoreConfigs(dbPeers: IDbPeer[]) {
    return await this.configMutex.runExclusive(async () => {
      this.invalidateConfigCache();

      const server = await this.getConfig();
      const serverPeers = server.peers || [];
      const fileKeys = new Set(serverPeers.map((p) => p.publicKey));

      const isSyncRequired =
        serverPeers.length !== dbPeers.length ||
        dbPeers.some((peer) => !fileKeys.has(peer.publicKey));

      if (isSyncRequired) {
        this.logger.warn(
          `Обнаружен рассинхрон конфигурации (Файл: ${serverPeers.length}, БД: ${dbPeers.length}). Запуск восстановления...`,
        );
        await this.rebuildServerConfig(dbPeers);
      } else {
        this.logger.log('Конфигурация WireGuard синхронизирована с БД.');
      }
    });
  }

  private async rebuildServerConfig(peers: IDbPeer[]) {
    const server = await this.getConfig();

    server.peers = [];

    for (const peer of peers) {
      server.addPeer({
        publicKey: peer.publicKey,
        preSharedKey: peer.presharedKey || undefined,
        allowedIps: [`${peer.ip}/32`],
      });
    }

    await this.writeServerConfig(server);

    this.invalidateConfigCache();

    await this.syncSystem();
    this.logger.log(
      `Конфигурация восстановлена. Активных пиров: ${peers.length}`,
    );
  }

  /**
   * Получить статистику (для мониторинга)
   */
  getStats() {
    return {
      configCached: this.configCache !== null,
      configCacheAge: this.configCache
        ? Date.now() - this.configCache.timestamp
        : null,
      serverPublicKeyCached: this._serverPublicKeyCache !== null,
    };
  }
}
