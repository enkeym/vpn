import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { WgConfig } from 'wireguard-tools';
import * as path from 'path';
import { existsSync } from 'fs';
import { getNextFreeIp } from './wg.utils';
import { execSync } from 'child_process';

@Injectable()
export class WgService implements OnModuleInit {
  private readonly logger = new Logger(WgService.name);

  private readonly filePath = path.join(process.cwd(), '/configs/wg0.conf');
  private readonly interfaceAddress = '10.8.0.2/16';
  private readonly port = Number(process.env.WG_PORT || 51820);
  private readonly host = process.env.WG_HOST;
  private readonly allowedIps = process.env.WG_ALLOWED_IPS;

  // Создание конфига при запуске
  async onModuleInit() {
    if (!this.host) {
      throw new Error(`WG_HOST в .env не задан или нет .env`);
    }

    await this.generateServerConfig();
  }

  private async generateServerConfig() {
    if (existsSync(this.filePath)) {
      console.log(`Конфиг уже существует: ${this.filePath}`);
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

    this.logger.log(`Серверная конфигурация успешно создана: ${this.filePath}`);
  }

  async createClientConfig(name: string) {
    const server = new WgConfig({ filePath: this.filePath });
    await server.parseFile();

    const serverPrivateKey = server.wgInterface.privateKey;

    if (!serverPrivateKey) {
      throw new Error('Не удалось получить приватный ключ сервера');
    }

    const serverPublicKey = execSync(`echo '${serverPrivateKey}' | wg pubkey`)
      .toString()
      .trim();

    const usedIps = new Set<string>();

    if (server.wgInterface.address) {
      usedIps.add(server.wgInterface.address[0].split('/')[0]);
    }

    server.peers?.forEach((peer) => {
      peer.allowedIps?.forEach((ip) => usedIps.add(ip.split('/')[0]));
    });

    const clientIp = getNextFreeIp(usedIps);

    const client = new WgConfig({});
    await client.generateKeys({ preSharedKey: true });

    server.addPeer({
      publicKey: client.publicKey,
      preSharedKey: client.preSharedKey,
      allowedIps: [`${clientIp}/32`],
    });

    await server.writeToFile();
    this.logger.log(`Клиент ${name} добавлен: ${clientIp}`);

    return `[Interface]
PrivateKey = ${client.wgInterface.privateKey}
Address = ${clientIp}/32
DNS = 1.1.1.1, 8.8.8.8
MTU = 1420

[Peer]
PublicKey = ${serverPublicKey}
PresharedKey = ${client.preSharedKey}
Endpoint = ${this.host}:${this.port}
AllowedIPs = ${this.allowedIps}
PersistentKeepalive = 25
`;
  }
}
