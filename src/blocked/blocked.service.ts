import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as schema from '../database/schema';
import { DRIZZLE } from 'src/database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';

export type TBlockedUser = typeof schema.blockedUsers.$inferSelect;

// Кеш блокировки: telegramId -> { isBlocked: boolean, expiresAt: number }
interface BlockedCacheEntry {
  isBlocked: boolean;
  expiresAt: number;
}

@Injectable()
export class BlockedUsersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockedUsersService.name);

  // Кеш проверки блокировки (TTL 5 минут)
  private readonly blockedCache = new Map<string, BlockedCacheEntry>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут
  private readonly CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // Очистка каждые 10 минут
  private cacheCleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
  ) {}

  onModuleInit() {
    // Запускаем периодическую очистку кеша
    this.cacheCleanupInterval = setInterval(() => {
      this.cleanupExpiredCache();
    }, this.CACHE_CLEANUP_INTERVAL_MS);

    this.logger.log('Кеш блокировки инициализирован');
  }

  onModuleDestroy() {
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = null;
    }
  }

  /**
   * Очистка устаревших записей кеша
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.blockedCache.entries()) {
      if (value.expiresAt <= now) {
        this.blockedCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(
        `Очищено ${cleaned} устаревших записей кеша блокировки`,
      );
    }
  }

  /**
   * Заблокировать пользователя
   */
  async blockUser(
    telegramId: string,
    blockedBy: string,
    reason?: string,
  ): Promise<TBlockedUser> {
    // Проверяем, не заблокирован ли уже
    const existing = await this.db.query.blockedUsers.findFirst({
      where: eq(schema.blockedUsers.telegramId, telegramId),
    });
    if (existing) {
      throw new Error('Пользователь уже заблокирован');
    }

    const [blocked] = await this.db
      .insert(schema.blockedUsers)
      .values({
        telegramId,
        blockedBy,
        reason: reason || null,
      })
      .returning();

    // Инвалидируем кеш
    this.invalidateCache(telegramId);

    this.logger.log(`Пользователь ${telegramId} заблокирован`);
    return blocked;
  }

  /**
   * Разблокировать пользователя
   */
  async unblockUser(telegramId: string): Promise<void> {
    await this.db
      .delete(schema.blockedUsers)
      .where(eq(schema.blockedUsers.telegramId, telegramId));

    // Инвалидируем кеш
    this.invalidateCache(telegramId);

    this.logger.log(`Пользователь ${telegramId} разблокирован`);
  }

  /**
   * Проверка блокировки (с кешированием)
   */
  async isBlocked(telegramId: string): Promise<boolean> {
    // Проверяем кеш
    const cached = this.blockedCache.get(telegramId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.isBlocked;
    }

    // Запрос к БД
    const blocked = await this.db.query.blockedUsers.findFirst({
      where: eq(schema.blockedUsers.telegramId, telegramId),
    });
    const isBlocked = !!blocked;

    // Сохраняем в кеш
    this.blockedCache.set(telegramId, {
      isBlocked,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return isBlocked;
  }

  /**
   * Получить информацию о блокировке
   */
  async getBlockedUser(telegramId: string): Promise<TBlockedUser | null> {
    const blocked = await this.db.query.blockedUsers.findFirst({
      where: eq(schema.blockedUsers.telegramId, telegramId),
    });
    return blocked ?? null;
  }

  /**
   * Инвалидация кеша для конкретного пользователя
   */
  invalidateCache(telegramId: string): void {
    this.blockedCache.delete(telegramId);
  }

  /**
   * Полная очистка кеша блокировки
   */
  clearCache(): void {
    this.blockedCache.clear();
  }

  /**
   * Получить статистику кеша (для мониторинга)
   */
  getCacheStats() {
    return {
      blockedCacheSize: this.blockedCache.size,
    };
  }
}
