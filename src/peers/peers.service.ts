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
import { NotificationService } from 'src/notification/notification.service';
import {
  CacheService,
  CacheStats,
  CACHE_NAMESPACES,
  CACHE_TTL,
} from 'src/common/cache/cache.service';
import * as QRCode from 'qrcode';

export type TPeer = typeof schema.peers.$inferInsert;
export type TPeerSelect = typeof schema.peers.$inferSelect;

const SYNC_MAX_RETRIES = 5;
const SYNC_RETRY_DELAY_MS = 2000;

function calculateExpiresAt(durationDays: SubscriptionDuration): Date {
  const now = new Date();
  return new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class PeersService {
  private readonly logger = new Logger(PeersService.name);
  private readonly createPeerMutex = new Mutex();

  // Локальный кеш использованных IP для быстрого доступа (критичная оптимизация)
  private usedIpsCache: Set<string> | null = null;
  private usedIpsCacheTime = 0;
  private readonly USED_IPS_CACHE_TTL = 60 * 1000; // 1 минута

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
    private readonly wgService: WgService,
    private readonly notificationService: NotificationService,
    private readonly cacheService: CacheService,
  ) {}

  async onModuleInit() {
    // Прогреваем кеш IP адресов при старте
    await this.warmUpIpsCache();
    await this.syncWgWithDb();
  }

  /**
   * Прогрев кеша IP адресов при старте
   */
  private async warmUpIpsCache(): Promise<void> {
    const usedPeers = await this.db.query.peers.findMany({
      columns: { ip: true },
    });
    this.usedIpsCache = new Set(usedPeers.map((peer) => peer.ip));
    this.usedIpsCacheTime = Date.now();
    this.logger.log(`Кеш IP прогрет: ${this.usedIpsCache.size} адресов`);
  }

  /**
   * Получить использованные IP адреса (с кешированием)
   */
  private async getUsedIps(): Promise<Set<string>> {
    const now = Date.now();

    // Проверяем актуальность локального кеша
    if (
      this.usedIpsCache &&
      now - this.usedIpsCacheTime < this.USED_IPS_CACHE_TTL
    ) {
      return new Set(this.usedIpsCache);
    }

    // Обновляем кеш
    const usedPeers = await this.db.query.peers.findMany({
      columns: { ip: true },
    });
    this.usedIpsCache = new Set(usedPeers.map((peer) => peer.ip));
    this.usedIpsCacheTime = now;

    return new Set(this.usedIpsCache);
  }

  /**
   * Добавить IP в локальный кеш
   */
  private addIpToCache(ip: string): void {
    if (this.usedIpsCache) {
      this.usedIpsCache.add(ip);
    }
  }

  /**
   * Удалить IP из локального кеша
   */
  private removeIpFromCache(ip: string): void {
    if (this.usedIpsCache) {
      this.usedIpsCache.delete(ip);
    }
  }

  /**
   * Инвалидировать кеш пиров пользователя
   */
  private invalidateUserPeersCache(telegramId: string): void {
    this.cacheService.delete(CACHE_NAMESPACES.PEERS_BY_USER, telegramId);
    this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);
  }

  /**
   * Инвалидировать кеш конкретного пира
   */
  private invalidatePeerCache(peerName: string): void {
    this.cacheService.delete(CACHE_NAMESPACES.PEER_BY_NAME, peerName);
  }

  private async syncWgWithDb() {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
      try {
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

        // Успешная синхронизация
        if (attempt > 1) {
          this.logger.log(
            `Синхронизация WG с БД успешна с ${attempt}-й попытки`,
          );
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `Ошибка синхронизации WG с БД (попытка ${attempt}/${SYNC_MAX_RETRIES}): ${lastError.message}`,
        );

        if (attempt < SYNC_MAX_RETRIES) {
          const delay = SYNC_RETRY_DELAY_MS * attempt; // Экспоненциальная задержка
          this.logger.warn(`Повторная попытка через ${delay}мс...`);
          await sleep(delay);
        }
      }
    }

    // Все попытки исчерпаны - отправляем уведомление админам
    const errorDetails = [
      `Не удалось синхронизировать конфигурацию WireGuard с базой данных после ${SYNC_MAX_RETRIES} попыток.`,
      ``,
      `*Ошибка:* \`${lastError?.message || 'Неизвестная ошибка'}\``,
      ``,
      `Требуется ручное вмешательство для восстановления работы VPN.`,
    ].join('\n');

    await this.notificationService.notifyCriticalError(
      'Сбой синхронизации WireGuard',
      errorDetails,
      SYNC_MAX_RETRIES,
    );

    this.logger.error(
      `КРИТИЧЕСКАЯ ОШИБКА: Синхронизация WG с БД провалена после ${SYNC_MAX_RETRIES} попыток. Уведомление отправлено админам.`,
    );
  }

  async createPeer(dto: ICreatePeer) {
    return await this.createPeerMutex.runExclusive(async () => {
      if (!dto.telegramId || String(dto.telegramId).trim() === '') {
        throw new BadRequestException('telegramId обязателен');
      }

      const telegramIdStr = String(dto.telegramId);
      const peerName = `${telegramIdStr.slice(0, 3)}${randomBytes(3).toString('hex')}`;

      // Быстрая проверка через кеш
      const cachedPeer = this.cacheService.get<TPeerSelect>(
        CACHE_NAMESPACES.PEER_BY_NAME,
        peerName,
      );
      if (cachedPeer) {
        throw new BadRequestException(
          `Конфиг с именем ${peerName} уже существует`,
        );
      }

      const existing = await this.db.query.peers.findFirst({
        where: eq(schema.peers.name, peerName),
      });

      if (existing) {
        throw new BadRequestException(
          `Конфиг с именем ${peerName} уже существует`,
        );
      }

      // Используем кешированные IP
      const usedIps = await this.getUsedIps();
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

      // Обновляем кеш IP
      this.addIpToCache(credentials.ip);

      try {
        const config = await this.wgService.createClientConfig(
          newPeer.name,
          credentials,
        );

        // Инвалидируем кеши
        this.invalidateUserPeersCache(dto.telegramId);

        return { peer: newPeer, config };
      } catch (error) {
        this.logger.error(
          `Ошибка создания конфига: ${error instanceof Error ? error.message : error}`,
        );

        // Откатываем изменения
        await this.db
          .delete(schema.peers)
          .where(eq(schema.peers.id, newPeer.id));
        this.removeIpFromCache(credentials.ip);

        throw error;
      }
    });
  }

  async findPeer(peerName: string): Promise<TPeerSelect> {
    // Проверяем кеш
    const cached = this.cacheService.get<TPeerSelect>(
      CACHE_NAMESPACES.PEER_BY_NAME,
      peerName,
    );
    if (cached) {
      return cached;
    }

    const peer = await this.db.query.peers.findFirst({
      where: eq(schema.peers.name, peerName),
    });

    if (!peer) {
      throw new NotFoundException(`Конфиг с именем ${peerName} не найден`);
    }

    // Сохраняем в кеш
    this.cacheService.set(
      CACHE_NAMESPACES.PEER_BY_NAME,
      peerName,
      peer,
      CACHE_TTL.MEDIUM,
    );

    return peer;
  }

  async updatedPeer(peerName: string) {
    const peer = await this.findPeer(peerName);
    const shouldPause = !peer.paused;

    await this.db
      .update(schema.peers)
      .set({ paused: shouldPause })
      .where(eq(schema.peers.name, peerName));

    // Инвалидируем кеши
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

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

      // Повторно инвалидируем после отката
      this.invalidatePeerCache(peerName);
      this.invalidateUserPeersCache(peer.telegramId);

      throw error;
    }
  }

  async deletePeer(peerName: string) {
    const peer = await this.findPeer(peerName);

    await this.db.delete(schema.peers).where(eq(schema.peers.name, peerName));

    // Обновляем кеши
    this.removeIpFromCache(peer.ip);
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

    if (!peer.paused) {
      try {
        await this.wgService.removePeer(peer.publicKey);
      } catch (error) {
        this.logger.error(`Не удалось удалить пир из WG: ${error}`);
      }
    }

    return { message: `Конфиг ${peerName} успешно удален` };
  }

  async getPeersByTelegramId(telegramId: string): Promise<TPeerSelect[]> {
    // Проверяем кеш
    const cached = this.cacheService.get<TPeerSelect[]>(
      CACHE_NAMESPACES.PEERS_BY_USER,
      telegramId,
    );
    if (cached) {
      return cached;
    }

    const peers = await this.db.query.peers.findMany({
      where: eq(schema.peers.telegramId, telegramId),
      orderBy: [desc(schema.peers.createdAt)],
    });

    // Сохраняем в кеш
    this.cacheService.set(
      CACHE_NAMESPACES.PEERS_BY_USER,
      telegramId,
      peers,
      CACHE_TTL.MEDIUM,
    );

    return peers;
  }

  async setConfigMessageId(peerName: string, messageId: number) {
    await this.db
      .update(schema.peers)
      .set({ configMessageId: messageId })
      .where(eq(schema.peers.name, peerName));

    // Инвалидируем кеш пира
    this.invalidatePeerCache(peerName);
  }

  async allPeers(): Promise<TPeerSelect[]> {
    // Проверяем кеш
    const cached = this.cacheService.get<TPeerSelect[]>(
      CACHE_NAMESPACES.ALL_PEERS,
      'all',
    );
    if (cached) {
      return cached;
    }

    const peers = await this.db.query.peers.findMany({
      orderBy: [desc(schema.peers.createdAt)],
    });

    // Сохраняем в кеш с коротким TTL (данные часто меняются)
    this.cacheService.set(
      CACHE_NAMESPACES.ALL_PEERS,
      'all',
      peers,
      CACHE_TTL.SHORT,
    );

    return peers;
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

        // Инвалидируем кеши
        this.invalidatePeerCache(peer.name);
        this.invalidateUserPeersCache(peer.telegramId);

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

    // Инвалидируем кеши
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

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
    const peer = await this.findPeer(peerName);

    await this.db
      .update(schema.peers)
      .set({ description })
      .where(eq(schema.peers.name, peerName));

    // Инвалидируем кеши
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

    this.logger.log(
      `Обновлено описание конфига ${peerName}: ${description || '(удалено)'}`,
    );
  }

  /**
   * Проверяет, можно ли заменить конфиг (прошло ли 24 часа с последней замены)
   */
  canReplacePeer(peer: TPeerSelect): {
    canReplace: boolean;
    hoursLeft?: number;
  } {
    if (!peer.lastReplacedAt) {
      return { canReplace: true };
    }

    const now = new Date();
    const lastReplaced = new Date(peer.lastReplacedAt);
    const hoursSinceLastReplace =
      (now.getTime() - lastReplaced.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastReplace >= 24) {
      return { canReplace: true };
    }

    return {
      canReplace: false,
      hoursLeft: Math.ceil(24 - hoursSinceLastReplace),
    };
  }

  /**
   * Заменяет конфиг: удаляет старый и создаёт новый с теми же параметрами (тариф, срок)
   * Можно заменять только раз в 24 часа
   */
  async replacePeer(
    peerName: string,
  ): Promise<{ peer: TPeerSelect; config: string }> {
    return await this.createPeerMutex.runExclusive(async () => {
      const oldPeer = await this.findPeer(peerName);

      // Проверяем, можно ли заменить
      const { canReplace, hoursLeft } = this.canReplacePeer(oldPeer);
      if (!canReplace) {
        throw new BadRequestException(
          `Заменить конфиг можно только раз в 24 часа. Осталось: ${hoursLeft} ч.`,
        );
      }

      // Сохраняем текущий срок действия (expiresAt) - это важно!
      const currentExpiresAt = oldPeer.expiresAt;

      // Удаляем старый пир из WireGuard (если не на паузе)
      if (!oldPeer.paused) {
        try {
          await this.wgService.removePeer(oldPeer.publicKey);
        } catch (error) {
          this.logger.error(`Ошибка удаления старого пира из WG: ${error}`);
        }
      }

      // Генерируем новые ключи
      const usedIps = await this.getUsedIps();
      // Исключаем старый IP из списка занятых
      usedIps.delete(oldPeer.ip);

      const credentials =
        await this.wgService.generateClientCredentials(usedIps);

      // Обновляем запись в БД с новыми ключами, но сохраняем срок
      const [updatedPeer] = await this.db
        .update(schema.peers)
        .set({
          publicKey: credentials.publicKey,
          privateKey: credentials.privateKey,
          presharedKey: credentials.presharedKey,
          ip: credentials.ip,
          endpoint: `${this.wgService.host}:${this.wgService.port}`,
          paused: false, // Активируем конфиг при замене
          expiresAt: currentExpiresAt, // Сохраняем тот же срок!
          lastReplacedAt: new Date(),
        })
        .where(eq(schema.peers.name, peerName))
        .returning();

      // Обновляем кеш IP
      this.removeIpFromCache(oldPeer.ip);
      this.addIpToCache(credentials.ip);

      // Инвалидируем кеши
      this.invalidatePeerCache(peerName);
      this.invalidateUserPeersCache(oldPeer.telegramId);

      // Создаём новый конфиг в WireGuard
      try {
        const config = await this.wgService.createClientConfig(
          peerName,
          credentials,
        );

        this.logger.log(`Конфиг ${peerName} успешно заменён`);
        return { peer: updatedPeer, config };
      } catch (error) {
        // Если не удалось создать конфиг в WG, откатываем изменения
        this.logger.error(`Ошибка создания нового конфига в WG: ${error}`);
        await this.db
          .update(schema.peers)
          .set({
            publicKey: oldPeer.publicKey,
            privateKey: oldPeer.privateKey,
            presharedKey: oldPeer.presharedKey,
            ip: oldPeer.ip,
            endpoint: oldPeer.endpoint,
            paused: oldPeer.paused,
            lastReplacedAt: oldPeer.lastReplacedAt,
          })
          .where(eq(schema.peers.name, peerName));

        // Откатываем кеш IP
        this.removeIpFromCache(credentials.ip);
        this.addIpToCache(oldPeer.ip);

        // Инвалидируем кеши после отката
        this.invalidatePeerCache(peerName);
        this.invalidateUserPeersCache(oldPeer.telegramId);

        throw error;
      }
    });
  }

  /**
   * Генерирует строку конфига WireGuard для существующего пира
   */
  generatePeerConfig(peer: TPeerSelect): string {
    if (!peer.presharedKey) {
      throw new InternalServerErrorException(
        'Отсутствует presharedKey у пира',
      );
    }

    return `[Interface]
PrivateKey = ${peer.privateKey}
Address = ${peer.ip}/32
DNS = 1.1.1.1, 8.8.8.8
MTU = 1420

[Peer]
PublicKey = ${this.wgService.host ? '' : ''}${peer.endpoint?.split(':')[0] ? '' : ''}
PresharedKey = ${peer.presharedKey}
Endpoint = ${peer.endpoint}
AllowedIPs = ${process.env.WG_ALLOWED_IPS || '0.0.0.0/0'}
PersistentKeepalive = 25
`;
  }

  /**
   * Генерирует строку конфига WireGuard для существующего пира
   */
  async getPeerConfigString(peerName: string): Promise<string> {
    const peer = await this.findPeer(peerName);

    // Получаем публичный ключ сервера через endpoint
    const serverPublicKey = await this.getServerPublicKey();

    return `[Interface]
PrivateKey = ${peer.privateKey}
Address = ${peer.ip}/32
DNS = 1.1.1.1, 8.8.8.8
MTU = 1420

[Peer]
PublicKey = ${serverPublicKey}
PresharedKey = ${peer.presharedKey}
Endpoint = ${peer.endpoint}
AllowedIPs = ${process.env.WG_ALLOWED_IPS || '0.0.0.0/0'}
PersistentKeepalive = 25
`;
  }

  /**
   * Генерирует QR-код для конфига пира (возвращает Buffer с PNG изображением)
   */
  async generatePeerQrCode(peerName: string): Promise<Buffer> {
    const config = await this.getPeerConfigString(peerName);

    return QRCode.toBuffer(config, {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  }

  /**
   * Получить публичный ключ сервера (кешируется в WgService)
   */
  private async getServerPublicKey(): Promise<string> {
    // Используем exec для получения публичного ключа из приватного
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Читаем конфиг сервера для получения приватного ключа
    const fs = await import('fs/promises');
    const path = await import('path');
    const configPath = path.join(process.cwd(), '/configs/wg0.conf');
    const configContent = await fs.readFile(configPath, 'utf-8');

    // Извлекаем приватный ключ
    const privateKeyMatch = configContent.match(/PrivateKey\s*=\s*(.+)/);
    if (!privateKeyMatch) {
      throw new InternalServerErrorException(
        'Не удалось найти приватный ключ сервера',
      );
    }

    const privateKey = privateKeyMatch[1].trim();
    const { stdout } = await execAsync(`echo '${privateKey}' | wg pubkey`);
    return stdout.trim();
  }

  /**
   * Получить статистику кеша (для мониторинга)
   */
  getCacheStats(): {
    usedIpsCache: number;
    usedIpsCacheAge: number | null;
    globalCache: Record<string, CacheStats> | CacheStats | null;
  } {
    return {
      usedIpsCache: this.usedIpsCache?.size ?? 0,
      usedIpsCacheAge: this.usedIpsCacheTime
        ? Date.now() - this.usedIpsCacheTime
        : null,
      globalCache: this.cacheService.getStats(),
    };
  }
}
