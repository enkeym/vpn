import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as schema from '../database/schema';
import { DRIZZLE } from 'src/database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import type { WgService } from 'src/wg/wg.service';
import { randomBytes } from 'node:crypto';

type TPeer = typeof schema.peers.$inferInsert;
type TPeerSelect = typeof schema.peers.$inferSelect;

interface ICreatePeer {
  telegramId: string;
  username?: string;
}

@Injectable()
export class PeersService {
  private readonly logger = new Logger(PeersService.name);

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
    private readonly wgService: WgService,
  ) {}

  async onModuleInit() {
    await this.syncWgWithDb();
  }

  private async syncWgWithDb() {
    const activePeers = await this.db.query.peers.findMany({
      where: eq(schema.peers.paused, false),
    });

    if (!activePeers) return;

    const peers = activePeers.map((peer) => ({
      name: peer.name,
      publicKey: peer.publicKey,
      presharedKey: peer.presharedKey!,
      ip: peer.ip,
    }));

    await this.wgService.restoreConfigs(peers);
  }

  async createPeer(dto: ICreatePeer) {
    const peerName = `${dto.telegramId.slice(0, 5)}${randomBytes(5).toString('hex')}`;

    const existing = await this.findPeer(peerName);

    if (existing) {
      throw new BadRequestException(
        `Конфиг с именем ${peerName} уже существует`,
      );
    }

    const usedPeers = await this.db.query.peers.findMany({
      columns: { ip: true },
    });
    const usedIps = new Set(usedPeers.map((peer) => peer.ip));

    const credentials = await this.wgService.generateClientCredentials(usedIps);

    const peerData: TPeer = {
      telegramId: dto.telegramId,
      username: dto.username || null,
      name: peerName,
      publicKey: credentials.publicKey,
      privateKey: credentials.privateKey,
      presharedKey: credentials.presharedKey,
      ip: credentials.ip,
      endpoint: `${this.wgService.host}:${this.wgService.port}`,
      paused: false,
    };

    const [newPeer] = await this.db
      .insert(schema.peers)
      .values(peerData)
      .returning();

    try {
      const config = await this.wgService.createClientConfig(
        newPeer.name,
        credentials,
      );

      return { peer: newPeer, config };
    } catch (error) {
      this.logger.error(
        `Ошибка создания конфига: ${error instanceof Error ? error.message : error}`,
      );
      await this.db.delete(schema.peers).where(eq(schema.peers.id, newPeer.id));
      throw error;
    }
  }

  async findPeer(peerName: string): Promise<TPeerSelect> {
    const peer = await this.db.query.peers.findFirst({
      where: eq(schema.peers.name, peerName),
    });

    if (!peer) {
      throw new NotFoundException(`Конфиг с именем ${peerName} не найден`);
    }

    return peer;
  }

  async updatedPeer(peerName: string) {
    const peer = await this.findPeer(peerName);
    const shouldPause = !peer.paused;

    await this.db
      .update(schema.peers)
      .set({ paused: shouldPause })
      .where(eq(schema.peers.name, peerName));

    if (shouldPause) {
      await this.wgService.removePeer(peer.publicKey);
    } else {
      if (!peer.presharedKey)
        throw new InternalServerErrorException('Нет presharedKey');

      await this.wgService.createClientConfig(peer.name, {
        publicKey: peer.publicKey,
        privateKey: peer.privateKey,
        presharedKey: peer.presharedKey,
        ip: peer.ip,
      });
    }
  }

  async deletePeer(peerName: string) {
    const peer = await this.findPeer(peerName);

    await this.db.delete(schema.peers).where(eq(schema.peers.name, peerName));

    if (!peer.paused) {
      await this.wgService.removePeer(peer.publicKey);
    }

    return { message: `Конфиг ${peerName} успешно удален` };
  }

  async allPeers() {
    return await this.db.query.peers.findMany({
      orderBy: [desc(schema.peers.createdAt)],
    });
  }
}
