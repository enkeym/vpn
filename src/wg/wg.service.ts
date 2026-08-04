import {
  Injectable,
  OnModuleInit,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { WgConfig } from 'wireguard-tools';
import * as path from 'path';
import { existsSync } from 'fs';
import {
  derivePublicKey,
  generateKeys,
  getNextFreeIp,
  getSubnetPrefix,
  parseWgConfig,
  readAllowedIps,
} from './wg.utils';
import {
  bringInterfaceUp,
  isInterfaceUp,
  readRuntimeStats,
  syncInterface,
  type ITunnelBinaries,
} from './tunnel.runtime';
import type {
  IClientConfigInput,
  IDbPeer,
  IPeerRuntimeStats,
  ITunnelCredentials,
  ITunnelService,
} from './tunnel.types';
import { Mutex } from 'async-mutex';

interface ParsedConfigCache {
  config: WgConfig;
  timestamp: number;
}

/** Классический WireGuard на wg0 — базовый туннель, обслуживает всех клиентов по умолчанию */
@Injectable()
export class WgService implements ITunnelService, OnModuleInit {
  readonly protocol = 'wg' as const;

  private readonly logger = new Logger(WgService.name);

  private readonly filePath = path.join(process.cwd(), '/configs/wg0.conf');
  private readonly interfaceAddress = '10.8.0.1/16';
  private readonly allowedIps = readAllowedIps();
  private readonly clientDns = '1.1.1.1, 8.8.8.8';
  private readonly clientMtu = Number(process.env.WG_MTU || 1420);

  private readonly binaries: ITunnelBinaries = {
    cli: 'wg',
    quick: 'wg-quick',
    interfaceName: 'wg0',
  };

  public readonly port = Number(process.env.WG_PORT || 51820);
  public readonly host = process.env.WG_HOST as string;

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

    // Страховка на случай обращения до onModuleInit: файла может ещё не быть
    if (!existsSync(this.filePath)) {
      await this.generateServerConfig();
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

  /** wg0 обязателен: без него onModuleInit бросает и приложение не стартует */
  isEnabled(): boolean {
    return true;
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

    try {
      this._serverPublicKeyCache = await derivePublicKey(privateKey);
      return this._serverPublicKeyCache;
    } catch (error) {
      throw new InternalServerErrorException(
        `Ошибка получения публичного ключа: ${error}`,
      );
    }
  }

  private async syncSystem() {
    try {
      await syncInterface(this.binaries, this.filePath);
      this.logger.log('Интерфейс wg0 синхронизирован');
    } catch (error) {
      this.logger.error(
        `Ошибка синхронизации WireGuard: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async startInterfaceUp() {
    if (await isInterfaceUp(this.binaries.interfaceName)) {
      this.logger.log('Интерфейс wg0 уже активен');
      return;
    }

    await bringInterfaceUp(this.binaries, this.filePath);
    this.logger.log('Интерфейс wg0 успешно поднят');
  }

  async getPeerRuntimeStats(): Promise<Map<string, IPeerRuntimeStats>> {
    try {
      return await readRuntimeStats(this.binaries);
    } catch (error) {
      this.logger.error(
        `Ошибка получения статистики WireGuard: ${error instanceof Error ? error.message : error}`,
      );
      return new Map();
    }
  }

  async generateClientCredentials(
    usedIpsFromDb: Set<string>,
  ): Promise<ITunnelCredentials> {
    const server = await this.getConfig();
    const addresses = server.wgInterface.address ?? [];

    // Адреса самого интерфейса заняты сервером
    addresses.forEach((address) => usedIpsFromDb.add(address.split('/')[0]));

    const prefix = getSubnetPrefix(addresses[0] ?? this.interfaceAddress);

    return await generateKeys(getNextFreeIp(usedIpsFromDb, prefix));
  }

  async createClientConfig(name: string, credentials: ITunnelCredentials) {
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

      return this.renderClientConfig(
        {
          privateKey: credentials.privateKey,
          presharedKey: credentials.presharedKey,
          ip: credentials.ip,
          endpoint: `${this.host}:${this.port}`,
        },
        serverPublicKey,
      );
    });
  }

  /** Конфиг существующего пира — ключи в БД, публичный ключ сервера берём из wg0.conf */
  async buildClientConfig(peer: IClientConfigInput): Promise<string> {
    return this.renderClientConfig(peer, await this.getServerPublicKey());
  }

  private renderClientConfig(
    peer: IClientConfigInput,
    serverPublicKey: string,
  ): string {
    return `[Interface]
PrivateKey = ${peer.privateKey}
Address = ${peer.ip}/32
DNS = ${this.clientDns}
MTU = ${this.clientMtu}

[Peer]
PublicKey = ${serverPublicKey}
PresharedKey = ${peer.presharedKey ?? ''}
Endpoint = ${peer.endpoint}
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
