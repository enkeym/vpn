import {
  Injectable,
  OnModuleInit,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { WgConfig } from 'wireguard-tools';
import * as path from 'path';
import { existsSync } from 'fs';
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

export interface IDbPeer {
  name: string;
  publicKey: string;
  presharedKey: string;
  ip: string;
}

interface ParsedConfigCache {
  config: WgConfig;
  timestamp: number;
}

@Injectable()
export class WgService implements OnModuleInit {
  private readonly logger = new Logger(WgService.name);

  private readonly filePath = path.join(process.cwd(), '/configs/wg0.conf');
  private readonly interfaceAddress = '10.8.0.1/16';
  private readonly allowedIps = process.env.WG_ALLOWED_IPS || '0.0.0.0/0';
  private readonly clientDns = '1.1.1.1, 8.8.8.8';

  public readonly port = Number(process.env.WG_PORT || 51820);
  public readonly host = process.env.WG_HOST;

  private _serverPublicKeyCache: string | null = null;
  private readonly configMutex = new Mutex();

  // Кеш парсированного конфига для избежания повторного парсинга
  private configCache: ParsedConfigCache | null = null;
  private readonly CONFIG_CACHE_TTL = 30 * 1000; // 30 секунд

  async onModuleInit() {
    if (!this.host) throw new Error(`WG_HOST в .env не задан`);

    await this.configMutex.runExclusive(async () => {
      await this.generateServerConfig();
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
    await server.writeToFile();

    this.logger.log(`Серверная конфигурация создана: ${this.filePath}`);
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
    try {
      await execAsync(
        `sudo bash -c 'wg syncconf wg0 <(wg-quick strip ${this.filePath})'`,
      );
      this.logger.log('Интерфейс wg0 синхронизирован');
    } catch (error) {
      this.logger.error(
        `Ошибка синхронизации WireGuard: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async startInterfaceUp() {
    if (await this.isInterfaceUp()) {
      this.logger.log('Интерфейс wg0 уже активен');
      return;
    }

    try {
      await execAsync(`sudo wg-quick up ${this.filePath}`);
      this.logger.log('Интерфейс wg0 успешно поднят');
    } catch (error) {
      try {
        await execAsync(`sudo wg-quick down ${this.filePath}`);
      } catch {}

      throw new Error(
        `Не удалось поднять интерфейс: ${error instanceof Error ? error.message : error}`,
      );
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
      const serverPublicKey = await this.getServerPublicKey();

      server.addPeer({
        publicKey: credentials.publicKey,
        preSharedKey: credentials.presharedKey,
        allowedIps: [`${credentials.ip}/32`],
      });

      await server.writeToFile();
      this.logger.log(`Клиент ${name} добавлен в конфиг: ${credentials.ip}`);

      // Инвалидируем кеш после записи
      this.invalidateConfigCache();

      await this.syncSystem();

      return `[Interface]
PrivateKey = ${credentials.privateKey}
Address = ${credentials.ip}/32
DNS = ${this.clientDns}
MTU = 1420

[Peer]
PublicKey = ${serverPublicKey}
PresharedKey = ${credentials.presharedKey}
Endpoint = ${this.host}:${this.port}
AllowedIPs = ${this.allowedIps}
PersistentKeepalive = 25
`;
    });
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

        await server.writeToFile();
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

    await server.writeToFile();

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
