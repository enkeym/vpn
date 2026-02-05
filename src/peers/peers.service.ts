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
import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import { WgService } from 'src/wg/wg.service';
import { randomBytes } from 'node:crypto';
import type { ICreatePeer, SubscriptionDuration } from './dto/create-peer.dto';
import { Mutex } from 'async-mutex';

export type TPeer = typeof schema.peers.$inferInsert;
type TPeerSelect = typeof schema.peers.$inferSelect;

function calculateExpiresAt(durationDays: SubscriptionDuration): Date {
  const now = new Date();
  return new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
}

@Injectable()
export class PeersService {
  private readonly logger = new Logger(PeersService.name);
  private readonly createPeerMutex = new Mutex();

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
    return await this.createPeerMutex.runExclusive(async () => {
      if (!dto.telegramId || String(dto.telegramId).trim() === '') {
        throw new BadRequestException('telegramId обязателен');
      }

      const telegramIdStr = String(dto.telegramId);
      const peerName = `${telegramIdStr.slice(0, 3)}${randomBytes(3).toString('hex')}`;

      const existing = await this.db.query.peers.findFirst({
        where: eq(schema.peers.name, peerName),
      });

      if (existing) {
        throw new BadRequestException(
          `Конфиг с именем ${peerName} уже существует`,
        );
      }

      const usedPeers = await this.db.query.peers.findMany({
        columns: { ip: true },
      });
      const usedIps = new Set(usedPeers.map((peer) => peer.ip));

      const credentials =
        await this.wgService.generateClientCredentials(usedIps);

      // Если durationDays не указан - конфиг бессрочный (expiresAt = null)
      const expiresAt = dto.durationDays
        ? calculateExpiresAt(dto.durationDays)
        : null;

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
        expiresAt,
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
        await this.db
          .delete(schema.peers)
          .where(eq(schema.peers.id, newPeer.id));
        throw error;
      }
    });
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

    try {
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
    } catch (error) {
      this.logger.error(
        `Ошибка обновления WG Для ${peerName}, отмена изменений`,
      );
      await this.db
        .update(schema.peers)
        .set({ paused: !shouldPause })
        .where(eq(schema.peers.name, peerName));

      throw error;
    }
  }

  async deletePeer(peerName: string) {
    const peer = await this.findPeer(peerName);

    await this.db.delete(schema.peers).where(eq(schema.peers.name, peerName));

    if (!peer.paused) {
      try {
        await this.wgService.removePeer(peer.publicKey);
      } catch (error) {
        this.logger.error(`Не удалось удалить пир из WG: ${error}`);
      }
    }

    return { message: `Конфиг ${peerName} успешно удален` };
  }

  async getPeersByTelegramId(telegramId: string) {
    return await this.db.query.peers.findMany({
      where: eq(schema.peers.telegramId, telegramId),
      orderBy: [desc(schema.peers.createdAt)],
    });
  }

  async setConfigMessageId(peerName: string, messageId: number) {
    await this.db
      .update(schema.peers)
      .set({ configMessageId: messageId })
      .where(eq(schema.peers.name, peerName));
  }

  async allPeers() {
    return await this.db.query.peers.findMany({
      orderBy: [desc(schema.peers.createdAt)],
    });
  }

  async deactivateExpiredPeers(): Promise<number> {
    const now = new Date();

    const expiredPeers = await this.db.query.peers.findMany({
      where: and(
        eq(schema.peers.paused, false),
        isNotNull(schema.peers.expiresAt),
        lte(schema.peers.expiresAt, now),
      ),
    });

    if (expiredPeers.length === 0) {
      return 0;
    }

    for (const peer of expiredPeers) {
      try {
        await this.db
          .update(schema.peers)
          .set({ paused: true })
          .where(eq(schema.peers.id, peer.id));

        await this.wgService.removePeer(peer.publicKey);

        this.logger.log(`Конфиг ${peer.name} деактивирован по истечению срока`);
      } catch (error) {
        this.logger.error(
          `Ошибка деактивации конфига ${peer.name}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return expiredPeers.length;
  }

  isExpired(peer: TPeerSelect): boolean {
    if (!peer.expiresAt) return false;
    return new Date() > peer.expiresAt;
  }

  async updatePeerExpiration(
    peerName: string,
    expiresAt: Date | null,
  ): Promise<void> {
    const peer = await this.findPeer(peerName);

    await this.db
      .update(schema.peers)
      .set({ expiresAt })
      .where(eq(schema.peers.name, peerName));

    // Если конфиг был на паузе из-за истечения срока, и мы продлили - включаем его
    if (peer.paused && expiresAt && expiresAt > new Date()) {
      await this.updatedPeer(peerName); // Это переключит статус
    }

    this.logger.log(
      `Обновлен срок действия конфига ${peerName}: ${expiresAt ? expiresAt.toISOString() : 'бессрочно'}`,
    );
  }

  async updatePeerDescription(
    peerName: string,
    description: string | null,
  ): Promise<void> {
    await this.findPeer(peerName);

    await this.db
      .update(schema.peers)
      .set({ description })
      .where(eq(schema.peers.name, peerName));

    this.logger.log(
      `Обновлено описание конфига ${peerName}: ${description || '(удалено)'}`,
    );
  }
}
