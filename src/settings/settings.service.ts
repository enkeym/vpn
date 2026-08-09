import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DRIZZLE } from 'src/database/database.module';
import * as schema from 'src/database/schema';

const PAYMENT_ENABLED_KEY = 'payment_enabled';
const TEST_PAYMENT_KEY = 'test_payment';

/**
 * Runtime-настройки бота, персистентные в БД (app_settings) с in-memory кешем
 * на процесс: запись мгновенно видна следующему чтению, без TTL и рестарта.
 * При отсутствии строки в БД используется дефолт из .env (совместимость
 * с прежним поведением на уже задеплоенных инсталляциях).
 */
@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, boolean>();

  constructor(
    @Inject(DRIZZLE)
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly configService: ConfigService,
  ) {}

  async isPaymentEnabled(): Promise<boolean> {
    return this.getBool(
      PAYMENT_ENABLED_KEY,
      this.configService.get<string>('HIDE_USER_PAYMENT_MENU') !== 'true',
    );
  }

  async setPaymentEnabled(value: boolean): Promise<void> {
    await this.setBool(PAYMENT_ENABLED_KEY, value);
  }

  async isTestPayment(): Promise<boolean> {
    return this.getBool(
      TEST_PAYMENT_KEY,
      this.configService.get<string>('TEST_PAYMENT') === 'true',
    );
  }

  async setTestPayment(value: boolean): Promise<void> {
    await this.setBool(TEST_PAYMENT_KEY, value);
  }

  private async getBool(key: string, defaultValue: boolean): Promise<boolean> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const row = await this.db.query.appSettings.findFirst({
      where: eq(schema.appSettings.key, key),
    });
    const value = row ? row.value === 'true' : defaultValue;
    this.cache.set(key, value);
    return value;
  }

  private async setBool(key: string, value: boolean): Promise<void> {
    const raw = String(value);
    await this.db
      .insert(schema.appSettings)
      .values({ key, value: raw })
      .onConflictDoUpdate({
        target: schema.appSettings.key,
        set: { value: raw, updatedAt: new Date() },
      });
    this.cache.set(key, value);
  }
}
