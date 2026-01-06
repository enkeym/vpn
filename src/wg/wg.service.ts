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
import { execSync } from 'child_process';

export interface ICredentialsProps {
  publicKey: string;
  privateKey: string;
  presharedKey: string;
  ip: string;
}

@Injectable()
export class WgService implements OnModuleInit {
  private readonly logger = new Logger(WgService.name);

  // Константы
  private readonly filePath = path.join(process.cwd(), '/configs/wg0.conf');
  private readonly interfaceAddress = '10.8.0.1/16'; // Исправлено на .1 (стандарт)
  private readonly port = Number(process.env.WG_PORT || 51820);
  private readonly host = process.env.WG_HOST;
  private readonly allowedIps = process.env.WG_ALLOWED_IPS || '0.0.0.0/0';
  private readonly clientDns = '1.1.1.1, 8.8.8.8';

  private _serverPublicKeyCache: string | null = null;

  async onModuleInit() {
    if (!this.host) {
      throw new Error(`WG_HOST в .env не задан`);
    }

    await this.generateServerConfig();
    await this.getServerPublicKey();
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
      },
    });

    await server.generateKeys();
    await server.writeToFile();

    this.logger.log(`Серверная конфигурация создана: ${this.filePath}`);
  }

  private async getConfig() {
    return parseWgConfig(this.filePath);
  }

  private syncSystem() {
    try {
      execSync(`wg syncconf wg0 <(wg-quick strip ${this.filePath})`, {
        shell: '/bin/bash',
      });
      this.logger.log(`Интерфейс wg0 синхронизирован`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`Ошибка синхронизации WireGuard: ${message}`);
    }
  }

  private async getServerPublicKey(): Promise<string> {
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

    const publicKey = execSync(`echo '${privateKey}' | wg pubkey`)
      .toString()
      .trim();

    this._serverPublicKeyCache = publicKey;
    return publicKey;
  }

  async generateClientCredentials(): Promise<ICredentialsProps> {
    const server = await this.getConfig();

    const usedIps = new Set(
      [
        ...(server.wgInterface.address ?? []),
        ...(server.peers?.flatMap((p) => p.allowedIps ?? []) ?? []),
      ].map((cidr) => cidr.split('/')[0]),
    );

    const clientIp = getNextFreeIp(usedIps);
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
    const server = await this.getConfig();
    const serverPublicKey = await this.getServerPublicKey();

    server.addPeer({
      publicKey: credentials.publicKey,
      preSharedKey: credentials.presharedKey,
      allowedIps: [`${credentials.ip}/32`],
    });

    await server.writeToFile();
    this.logger.log(`Клиент ${name} добавлен в конфиг: ${credentials.ip}`);

    this.syncSystem();

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
  }

  async removePeer(publicKey: string) {
    const server = await this.getConfig();
    if (!server.peers) return;

    const initialLength = server.peers.length;
    server.peers = server.peers.filter((p) => p.publicKey !== publicKey);

    if (server.peers.length !== initialLength) {
      await server.writeToFile();
      this.syncSystem();
      this.logger.log(`Пир удален: ${publicKey}`);
    }
  }
}
