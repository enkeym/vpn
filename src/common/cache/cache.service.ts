import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/**
 * Универсальный TTL-кеш с автоматической очисткой и метриками
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly caches = new Map<string, Map<string, CacheEntry<unknown>>>();
  private readonly stats = new Map<string, CacheStats>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  private readonly DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 минут
  private readonly CLEANUP_INTERVAL_MS = 60 * 1000; // Очистка каждую минуту

  constructor() {
    this.startCleanupInterval();
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Получить или создать namespace для кеша
   */
  private getNamespace<T>(namespace: string): Map<string, CacheEntry<T>> {
    if (!this.caches.has(namespace)) {
      this.caches.set(namespace, new Map());
      this.stats.set(namespace, { hits: 0, misses: 0, size: 0 });
    }
    return this.caches.get(namespace) as Map<string, CacheEntry<T>>;
  }

  /**
   * Получить значение из кеша
   */
  get<T>(namespace: string, key: string): T | null {
    const cache = this.getNamespace<T>(namespace);
    const entry = cache.get(key);
    const stats = this.stats.get(namespace)!;

    if (!entry) {
      stats.misses++;
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      stats.size = cache.size;
      stats.misses++;
      return null;
    }

    stats.hits++;
    return entry.value;
  }

  /**
   * Записать значение в кеш
   */
  set<T>(namespace: string, key: string, value: T, ttlMs?: number): void {
    const cache = this.getNamespace<T>(namespace);
    const stats = this.stats.get(namespace)!;

    cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.DEFAULT_TTL_MS),
    });

    stats.size = cache.size;
  }

  /**
   * Удалить ключ из кеша
   */
  delete(namespace: string, key: string): boolean {
    const cache = this.caches.get(namespace);
    if (!cache) return false;

    const deleted = cache.delete(key);
    if (deleted) {
      this.stats.get(namespace)!.size = cache.size;
    }
    return deleted;
  }

  /**
   * Удалить все ключи с определённым префиксом
   */
  deleteByPrefix(namespace: string, prefix: string): number {
    const cache = this.caches.get(namespace);
    if (!cache) return 0;

    let deleted = 0;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
        deleted++;
      }
    }

    if (deleted > 0) {
      this.stats.get(namespace)!.size = cache.size;
    }
    return deleted;
  }

  /**
   * Очистить весь namespace
   */
  clear(namespace: string): void {
    const cache = this.caches.get(namespace);
    if (cache) {
      cache.clear();
      this.stats.get(namespace)!.size = 0;
    }
  }

  /**
   * Очистить все кеши
   */
  clearAll(): void {
    for (const namespace of this.caches.keys()) {
      this.clear(namespace);
    }
  }

  /**
   * Получить статистику кеша
   */
  getStats(namespace?: string): Record<string, CacheStats> | CacheStats | null {
    if (namespace) {
      return this.stats.get(namespace) ?? null;
    }

    const result: Record<string, CacheStats> = {};
    for (const [ns, stats] of this.stats.entries()) {
      result[ns] = { ...stats };
    }
    return result;
  }

  /**
   * Получить или вычислить значение (cache-aside pattern)
   */
  async getOrCompute<T>(
    namespace: string,
    key: string,
    compute: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const cached = this.get<T>(namespace, key);
    if (cached !== null) {
      return cached;
    }

    const value = await compute();
    this.set(namespace, key, value, ttlMs);
    return value;
  }

  /**
   * Запустить периодическую очистку
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Очистить устаревшие записи
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let totalCleaned = 0;

    for (const [namespace, cache] of this.caches.entries()) {
      let cleaned = 0;
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAt <= now) {
          cache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.stats.get(namespace)!.size = cache.size;
        totalCleaned += cleaned;
      }
    }

    if (totalCleaned > 0) {
      this.logger.debug(`Очищено ${totalCleaned} устаревших записей кеша`);
    }
  }
}

/**
 * Константы namespace для разных типов данных
 */
export const CACHE_NAMESPACES = {
  PEERS_BY_USER: 'peers_by_user',
  PEER_BY_NAME: 'peer_by_name',
  ALL_PEERS: 'all_peers',
  USED_IPS: 'used_ips',
  FAMILY_MEMBERS: 'family_members',
  WG_CONFIG: 'wg_config',
  HAS_USED_TRIAL: 'has_used_trial',
  HAS_USED_DISCOUNT: 'has_used_discount',
} as const;

/**
 * TTL константы
 */
export const CACHE_TTL = {
  SHORT: 30 * 1000, // 30 секунд
  MEDIUM: 2 * 60 * 1000, // 2 минуты
  LONG: 5 * 60 * 1000, // 5 минут
  VERY_LONG: 15 * 60 * 1000, // 15 минут
} as const;
