import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as schema from '../database/schema';
import { DRIZZLE } from 'src/database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { desc, eq, like, sql } from 'drizzle-orm';
import {
  CacheService,
  CacheStats,
  CACHE_NAMESPACES,
  CACHE_TTL,
} from 'src/common/cache/cache.service';

export type TFamilyMember = typeof schema.familyMembers.$inferSelect;

// Кеш членства: telegramId -> { isMember: boolean, expiresAt: number }
interface MembershipCacheEntry {
  isMember: boolean;
  expiresAt: number;
}

@Injectable()
export class FamilyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FamilyService.name);

  // Кеш проверки членства (TTL 5 минут)
  private readonly membershipCache = new Map<string, MembershipCacheEntry>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут
  private readonly CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // Очистка каждые 10 минут
  private cacheCleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
    private readonly cacheService: CacheService,
  ) {}

  onModuleInit() {
    // Запускаем периодическую очистку кеша
    this.cacheCleanupInterval = setInterval(() => {
      this.cleanupExpiredCache();
    }, this.CACHE_CLEANUP_INTERVAL_MS);

    this.logger.log('Кеш членства инициализирован');
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

    for (const [key, value] of this.membershipCache.entries()) {
      if (value.expiresAt <= now) {
        this.membershipCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Очищено ${cleaned} устаревших записей кеша членства`);
    }
  }

  /**
   * Инвалидировать кеш списка всех членов
   */
  private invalidateAllMembersCache(): void {
    this.cacheService.clear(CACHE_NAMESPACES.FAMILY_MEMBERS);
  }

  /**
   * Добавление члена группы по telegramId
   * displayName опционален - если не указан, будет использован telegramId
   */
  async addMember(
    addedBy: string,
    telegramId: string,
    displayName?: string,
  ): Promise<TFamilyMember> {
    // Проверяем, нет ли уже такого пользователя
    const existingById = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.telegramId, telegramId),
    });
    if (existingById) {
      throw new Error('Пользователь с таким ID уже в группе');
    }

    const [member] = await this.db
      .insert(schema.familyMembers)
      .values({
        telegramId,
        displayName: displayName || null,
        addedBy,
      })
      .returning();

    // Инвалидируем кеш для нового участника
    this.invalidateMembershipCache(telegramId);
    this.invalidateAllMembersCache();

    const name = displayName || telegramId;
    this.logger.log(`Добавлен член группы: ${name}`);
    return member;
  }

  async removeMemberById(memberId: string): Promise<void> {
    // Разрешаем короткий ID (первые 8 символов) так же, как в findMemberById
    const member = await this.findMemberById(memberId);

    await this.db
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.id, member.id));

    // Инвалидируем кеш
    if (member) {
      this.invalidateMembershipCache(member.telegramId);
    }
    this.invalidateAllMembersCache();

    this.logger.log(`Удален член группы: ${member.id}`);
  }

  /**
   * Поиск члена группы по ID (поддерживает как полный UUID, так и сокращённый)
   * ОПТИМИЗАЦИЯ: Использует SQL LIKE вместо загрузки всех записей
   */
  async findMemberById(memberId: string): Promise<TFamilyMember> {
    // Сначала пробуем найти по полному ID
    let member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.id, memberId),
    });

    // Если не нашли и ID короткий, ищем по prefix через SQL LIKE
    if (!member && memberId.length < 36) {
      member = await this.db.query.familyMembers.findFirst({
        where: like(schema.familyMembers.id, `${memberId}%`),
      });
    }

    if (!member) {
      throw new NotFoundException(`Член группы не найден`);
    }

    return member;
  }

  async findMemberByTelegramId(
    telegramId: string,
  ): Promise<TFamilyMember | null> {
    const member = await this.db.query.familyMembers.findFirst({
      where: eq(schema.familyMembers.telegramId, telegramId),
    });
    return member ?? null;
  }

  /**
   * Проверка доступа: только по telegramId (с кешированием)
   */
  async isMember(telegramId: string): Promise<boolean> {
    // Проверяем кеш
    const cached = this.membershipCache.get(telegramId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.isMember;
    }

    // Запрос к БД
    const byId = await this.findMemberByTelegramId(telegramId);
    const isMember = !!byId;

    // Сохраняем в кеш
    this.membershipCache.set(telegramId, {
      isMember,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return isMember;
  }

  /**
   * Инвалидация кеша для конкретного пользователя
   */
  invalidateMembershipCache(telegramId: string): void {
    this.membershipCache.delete(telegramId);
  }

  /**
   * Полная очистка кеша членства
   */
  clearMembershipCache(): void {
    this.membershipCache.clear();
  }

  async getAllMembers(): Promise<TFamilyMember[]> {
    // Проверяем кеш
    const cached = this.cacheService.get<TFamilyMember[]>(
      CACHE_NAMESPACES.FAMILY_MEMBERS,
      'all',
    );
    if (cached) {
      return cached;
    }

    const members = await this.db.query.familyMembers.findMany({
      orderBy: [desc(schema.familyMembers.createdAt)],
    });

    // Сохраняем в кеш
    this.cacheService.set(
      CACHE_NAMESPACES.FAMILY_MEMBERS,
      'all',
      members,
      CACHE_TTL.MEDIUM,
    );

    return members;
  }

  /**
   * Получить членов группы конкретного админа
   */
  async getMembersByAdmin(adminId: string): Promise<TFamilyMember[]> {
    // Проверяем кеш
    const cacheKey = `by_admin:${adminId}`;
    const cached = this.cacheService.get<TFamilyMember[]>(
      CACHE_NAMESPACES.FAMILY_MEMBERS,
      cacheKey,
    );
    if (cached) {
      return cached;
    }

    const members = await this.db.query.familyMembers.findMany({
      where: eq(schema.familyMembers.addedBy, adminId),
      orderBy: [desc(schema.familyMembers.createdAt)],
    });

    // Сохраняем в кеш
    this.cacheService.set(
      CACHE_NAMESPACES.FAMILY_MEMBERS,
      cacheKey,
      members,
      CACHE_TTL.MEDIUM,
    );

    return members;
  }

  /**
   * Проверить, что член группы принадлежит админу
   */
  async isMemberOwnedByAdmin(
    memberId: string,
    adminId: string,
  ): Promise<boolean> {
    const member = await this.findMemberById(memberId);
    return member.addedBy === adminId;
  }

  /**
   * Обновить displayName участника
   */
  async updateDisplayName(
    memberId: string,
    displayName: string,
  ): Promise<void> {
    await this.db
      .update(schema.familyMembers)
      .set({ displayName })
      .where(eq(schema.familyMembers.id, memberId));

    // Инвалидируем кеш
    this.invalidateAllMembersCache();

    this.logger.log(`Обновлено имя участника ${memberId}: ${displayName}`);
  }

  /**
   * Получить отображаемое имя участника
   */
  getDisplayName(member: TFamilyMember): string {
    return member.displayName || member.telegramId;
  }

  /**
   * Получить статистику кеша (для мониторинга)
   */
  getCacheStats(): {
    membershipCacheSize: number;
    globalCache: CacheStats | null;
  } {
    return {
      membershipCacheSize: this.membershipCache.size,
      globalCache: this.cacheService.getStats(
        CACHE_NAMESPACES.FAMILY_MEMBERS,
      ) as CacheStats | null,
    };
  }
}
