import { Global, Logger, Module } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as path from 'path';
import * as schema from './schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'fs';

export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const logger = new Logger('DatabaseModule');
        const dbPath = path.join(process.cwd(), 'data', 'vpn.db');
        const dbDir = path.dirname(dbPath);

        if (!existsSync(dbDir)) {
          logger.log(`Папка не найдена. Создаю: ${dbDir}`);
          mkdirSync(dbDir, { recursive: true });
        }

        const sqlite = new Database(dbPath);

        // Включаем WAL режим для лучшей производительности при параллельных операциях
        sqlite.pragma('journal_mode = WAL');
        // Синхронная запись только для критичных данных
        sqlite.pragma('synchronous = NORMAL');
        // Увеличиваем размер кеша (по умолчанию -2000 = 2MB)
        sqlite.pragma('cache_size = -8000'); // 8MB
        // Храним временные таблицы в памяти
        sqlite.pragma('temp_store = MEMORY');
        // Включаем проверку foreign keys
        sqlite.pragma('foreign_keys = ON');

        logger.log('SQLite оптимизации применены (WAL, cache, etc.)');

        const db = drizzle(sqlite, { schema });
        migrate(db, { migrationsFolder: './drizzle' });

        return db;
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
