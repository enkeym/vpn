import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { Mutex } from 'async-mutex';
import { WgConfig } from 'wireguard-tools';
import {
  assertValidObfuscation,
  generateHeaderProtectionKey,
  generateObfuscation,
  obfuscationLines,
  parseAwgConfig,
  readAdvancedFromEnv,
  readAwg3FromEnv,
  readObfuscationFromEnv,
  serializeAwgConfig,
  upgradeToAwg3,
  type IAwgServerConfig,
} from './awg.utils';
import {
  derivePublicKey,
  generateKeys,
  getNextFreeIp,
  getSubnetPrefix,
  readAllowedIps,
} from './wg.utils';
import {
  bringInterfaceUp,
  isBinaryAvailable,
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

/**
 * AmneziaWG 3 — форк WireGuard, маскирующий трафик мусорными пакетами, пакетами-
 * имитациями чужих протоколов и шифрованием заголовков. Живёт на отдельном
 * интерфейсе awg0: интерфейс с включённой обфускацией несовместим с обычными
 * WireGuard-клиентами, поэтому wg0 остаётся нетронутым и продолжает обслуживать
 * всех, кто пришёл раньше.
 *
 * Работает поверх userspace-реализации amneziawg-go (через /dev/net/tun) —
 * модуль ядра на хосте не нужен. Если бинарей нет, туннель остаётся выключенным,
 * приложение при этом стартует штатно.
 *
 * Клиенты: AmneziaVPN ≥ 5.0.0.5 или AmneziaWG ≥ 3.0.1 — более старые не понимают
 * диапазоны заголовков и header protection.
 */
@Injectable()
export class AwgService implements ITunnelService, OnModuleInit {
  readonly protocol = 'awg' as const;

  private readonly logger = new Logger(AwgService.name);

  private readonly filePath = path.join(process.cwd(), '/configs/awg0.conf');
  private readonly interfaceAddress = process.env.AWG_ADDRESS || '10.9.0.1/16';
  private readonly allowedIps = readAllowedIps();
  private readonly clientDns = '1.1.1.1, 8.8.8.8';
  /** Junk-пакеты добавляют объём — клиентский MTU ниже, чем у чистого WireGuard */
  private readonly clientMtu = Number(process.env.AWG_MTU || 1280);

  /**
   * Единственный параметр AWG 3, который обязан совпасть с клиентом. По
   * умолчанию выключен: AmneziaVPN при импорте .conf-файла отбрасывает
   * HeaderProtectionKey (importController переносит только Jc/S1..S4/H1..H4/
   * I1..I5), клиент шлёт хендшейк без шифрования заголовков и виснет.
   * Включать только если все клиенты — приложение AmneziaWG >= 3.0.1,
   * передающее .conf в туннель как есть.
   */
  private readonly headerProtection =
    process.env.AWG_HEADER_PROTECTION === 'true';

  /**
   * Апгрейд существующего awg0.conf до AWG 3 перевыпускает параметры обфускации
   * и разом отключает всех, кому конфиг уже выдан. Поэтому только по явному
   * запросу: молча ломать рабочий сервер при обновлении образа нельзя.
   */
  private readonly allowConfigUpgrade =
    process.env.AWG_ALLOW_CONFIG_UPGRADE === 'true';

  /** AWG 3 принимает и диапазон `22-30`: ровный интервал keepalive — тоже сигнатура */
  private readonly persistentKeepalive =
    process.env.AWG_PERSISTENT_KEEPALIVE || '25';

  private readonly binaries: ITunnelBinaries = {
    cli: 'awg',
    quick: 'awg-quick',
    interfaceName: 'awg0',
    env: { WG_QUICK_USERSPACE_IMPLEMENTATION: 'amneziawg-go' },
  };

  public readonly port = Number(process.env.AWG_PORT || 51821);
  public readonly host = process.env.WG_HOST || '';

  private enabled = false;
  private _serverPublicKeyCache: string | null = null;
  private readonly configMutex = new Mutex();

  async onModuleInit(): Promise<void> {
    if (process.env.AWG_ENABLED === 'false') {
      this.logger.log('AmneziaWG отключён (AWG_ENABLED=false)');
      return;
    }

    if (!this.host) {
      this.logger.warn('AmneziaWG не поднят: WG_HOST в .env не задан');
      return;
    }

    const missing: string[] = [];
    for (const binary of [
      this.binaries.cli,
      this.binaries.quick,
      'amneziawg-go',
    ]) {
      if (!(await isBinaryAvailable(binary))) missing.push(binary);
    }

    if (missing.length > 0) {
      this.logger.warn(
        `AmneziaWG недоступен — нет бинарей: ${missing.join(', ')}. ` +
          'Пересоберите образ (docker compose build), чтобы включить обфускацию. WireGuard продолжает работать.',
      );
      return;
    }

    try {
      await this.configMutex.runExclusive(async () => {
        await this.generateServerConfig();
        await this.getServerPublicKey();
        await this.startInterfaceUp();
        await this.syncSystem();
      });

      this.enabled = true;
      const { obfuscation, awg3 } = await this.getConfig();
      this.logger.log(
        `AmneziaWG 3 активен: ${this.binaries.interfaceName} на :${this.port}, ` +
          `Jc=${obfuscation.jc} S1=${obfuscation.s1} S2=${obfuscation.s2} ` +
          `S3=${obfuscation.s3} S4=${obfuscation.s4}, header protection: ` +
          (awg3.headerProtectionKey ? 'включена' : 'выключена'),
      );
    } catch (error) {
      // Падение awg0 не должно ронять бота и рабочий wg0
      this.logger.error(
        `AmneziaWG не запущен: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async generateServerConfig(): Promise<void> {
    if (existsSync(this.filePath)) {
      this.logger.log(`Конфиг AmneziaWG найден: ${this.filePath}`);
      await this.upgradeExistingConfig();
      return;
    }

    const server = new WgConfig({});
    await server.generateKeys();
    const privateKey = server.wgInterface.privateKey;

    if (!privateKey) {
      throw new Error('Не удалось сгенерировать приватный ключ для AmneziaWG');
    }

    // Параметры из .env, иначе — уникальные для этого сервера (одинаковые
    // у всех значения сами по себе становятся сигнатурой для DPI)
    const obfuscation = readObfuscationFromEnv() ?? generateObfuscation();
    const awg3 = readAwg3FromEnv();
    if (this.headerProtection) {
      awg3.headerProtectionKey ??= generateHeaderProtectionKey();
    } else {
      // Флаг — выключатель: заданный в .env ключ его не переопределяет
      delete awg3.headerProtectionKey;
    }
    // В .env могли приехать короткие S1..S4 — с header protection они не работают
    assertValidObfuscation(obfuscation, awg3);

    const iface = this.binaries.interfaceName;

    await this.writeConfig({
      privateKey,
      address: this.interfaceAddress,
      listenPort: this.port,
      obfuscation,
      advanced: readAdvancedFromEnv(),
      awg3,
      postUp: [
        `iptables -A FORWARD -i ${iface} -j ACCEPT`,
        'iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE',
      ],
      postDown: [
        `iptables -D FORWARD -i ${iface} -j ACCEPT`,
        'iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE',
      ],
      peers: [],
    });

    this.logger.log(`Конфигурация AmneziaWG создана: ${this.filePath}`);
  }

  /**
   * Конфиг, созданный до AWG 3, поднимется и так, но обфускация останется на
   * уровне первой версии — дозаполняем недостающие поля на месте.
   *
   * Любая такая правка меняет параметры обфускации, а значит разом отключает
   * всех, кому конфиг уже выдан, поэтому по умолчанию только пишем
   * предупреждение: применяется она лишь при AWG_ALLOW_CONFIG_UPGRADE=true.
   */
  private async upgradeExistingConfig(): Promise<void> {
    const config = await this.getConfig();

    // upgradeToAwg3 правит config на месте, но пока файл не перезаписан, правки
    // живут только в этом локальном объекте — getConfig читает файл заново
    const changes = upgradeToAwg3(
      config,
      this.headerProtection,
      readAwg3FromEnv(),
    );

    // Header protection выключили в .env, а ключ в файле остался: с ним клиенты,
    // ради которых его и выключают, всё равно не подключатся
    if (!this.headerProtection && config.awg3.headerProtectionKey) {
      delete config.awg3.headerProtectionKey;
      changes.push('HeaderProtectionKey');
    }

    if (changes.length === 0) return;

    if (!this.allowConfigUpgrade) {
      this.logger.warn(
        `Конфиг AmneziaWG расходится с текущими настройками AWG 3 (${changes.join(', ')}). ` +
          'Обновление отключило бы всех, кому конфиг уже выдан, поэтому пропущено: ' +
          'задайте AWG_ALLOW_CONFIG_UPGRADE=true, чтобы применить.',
      );
      return;
    }

    await this.writeConfig(config);
    this.logger.warn(
      `Конфиг AmneziaWG обновлён до AWG 3 (${changes.join(', ')}). ` +
        'Старые выданные файлы больше не подключатся: клиентам нужно заново скачать конфиг из бота.',
    );
  }

  private async getConfig(): Promise<IAwgServerConfig> {
    return parseAwgConfig(await readFile(this.filePath, 'utf8'));
  }

  private async writeConfig(config: IAwgServerConfig): Promise<void> {
    await writeFile(this.filePath, serializeAwgConfig(config), { mode: 0o600 });
  }

  async getServerPublicKey(): Promise<string> {
    if (this._serverPublicKeyCache) {
      return this._serverPublicKeyCache;
    }

    const { privateKey } = await this.getConfig();
    this._serverPublicKeyCache = await derivePublicKey(privateKey);

    return this._serverPublicKeyCache;
  }

  private async startInterfaceUp(): Promise<void> {
    if (await isInterfaceUp(this.binaries.interfaceName)) {
      this.logger.log(`Интерфейс ${this.binaries.interfaceName} уже активен`);
      return;
    }

    await bringInterfaceUp(this.binaries, this.filePath);
    this.logger.log(`Интерфейс ${this.binaries.interfaceName} успешно поднят`);
  }

  private async syncSystem(): Promise<void> {
    try {
      await syncInterface(this.binaries, this.filePath);
      this.logger.log(
        `Интерфейс ${this.binaries.interfaceName} синхронизирован`,
      );
    } catch (error) {
      this.logger.error(
        `Ошибка синхронизации AmneziaWG: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async generateClientCredentials(
    usedIps: Set<string>,
  ): Promise<ITunnelCredentials> {
    const config = await this.getConfig();
    const prefix = getSubnetPrefix(config.address);

    // Адрес самого интерфейса занят сервером
    usedIps.add(config.address.split('/')[0]);

    return await generateKeys(getNextFreeIp(usedIps, prefix));
  }

  async createClientConfig(
    name: string,
    credentials: ITunnelCredentials,
  ): Promise<string> {
    return await this.configMutex.runExclusive(async () => {
      const config = await this.getConfig();

      config.peers.push({
        publicKey: credentials.publicKey,
        presharedKey: credentials.presharedKey,
        allowedIps: [`${credentials.ip}/32`],
      });

      await this.writeConfig(config);
      await this.syncSystem();
      this.logger.log(`Клиент ${name} добавлен в AmneziaWG: ${credentials.ip}`);

      return await this.buildClientConfig({
        privateKey: credentials.privateKey,
        presharedKey: credentials.presharedKey,
        ip: credentials.ip,
        endpoint: `${this.host}:${this.port}`,
      });
    });
  }

  async buildClientConfig(peer: IClientConfigInput): Promise<string> {
    const serverPublicKey = await this.getServerPublicKey();
    const { obfuscation, advanced, awg3 } = await this.getConfig();

    return `[Interface]
PrivateKey = ${peer.privateKey}
Address = ${peer.ip}/32
DNS = ${this.clientDns}
MTU = ${this.clientMtu}
${obfuscationLines(obfuscation, advanced, awg3)}

[Peer]
PublicKey = ${serverPublicKey}
PresharedKey = ${peer.presharedKey ?? ''}
Endpoint = ${peer.endpoint}
AllowedIPs = ${this.allowedIps}
PersistentKeepalive = ${this.persistentKeepalive}
`;
  }

  async removePeer(publicKey: string): Promise<void> {
    return this.removePeers([publicKey]);
  }

  async removePeers(publicKeys: string[]): Promise<void> {
    if (publicKeys.length === 0) return;

    return await this.configMutex.runExclusive(async () => {
      const config = await this.getConfig();
      const keysSet = new Set(publicKeys);

      if (!config.peers.some((peer) => keysSet.has(peer.publicKey))) return;

      config.peers = config.peers.filter(
        (peer) => !keysSet.has(peer.publicKey),
      );

      await this.writeConfig(config);
      await this.syncSystem();
      this.logger.log(`Удалено пиров из AmneziaWG: ${publicKeys.length}`);
    });
  }

  async restoreConfigs(dbPeers: IDbPeer[]): Promise<void> {
    if (!this.enabled) return;

    return await this.configMutex.runExclusive(async () => {
      const config = await this.getConfig();
      const fileKeys = new Set(config.peers.map((peer) => peer.publicKey));

      const isSyncRequired =
        config.peers.length !== dbPeers.length ||
        dbPeers.some((peer) => !fileKeys.has(peer.publicKey));

      if (!isSyncRequired) {
        this.logger.log('Конфигурация AmneziaWG синхронизирована с БД.');
        return;
      }

      this.logger.warn(
        `Рассинхрон AmneziaWG (файл: ${config.peers.length}, БД: ${dbPeers.length}). Восстановление...`,
      );

      config.peers = dbPeers.map((peer) => ({
        publicKey: peer.publicKey,
        presharedKey: peer.presharedKey || undefined,
        allowedIps: [`${peer.ip}/32`],
      }));

      await this.writeConfig(config);
      await this.syncSystem();
      this.logger.log(
        `Конфигурация AmneziaWG восстановлена. Активных пиров: ${dbPeers.length}`,
      );
    });
  }

  async getPeerRuntimeStats(): Promise<Map<string, IPeerRuntimeStats>> {
    if (!this.enabled) return new Map();

    try {
      return await readRuntimeStats(this.binaries);
    } catch (error) {
      this.logger.error(
        `Ошибка получения статистики AmneziaWG: ${error instanceof Error ? error.message : error}`,
      );
      return new Map();
    }
  }
}
