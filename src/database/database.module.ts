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
        const dbPath = path.join(process.cwd(), 'src/database', 'vpn.db');
        const dbDir = path.dirname(dbPath);

        if (!existsSync(dbDir)) {
          logger.log(`Папка не найдена. Создаю: ${dbDir}`);
          mkdirSync(dbDir, { recursive: true });

          // try {
          //   logger.log('Запуск генерации миграций...');
          //   execSync('pnpm run generate', { stdio: 'inherit' });
          // } catch (error) {
          //   logger.error('Ошибка при генерации миграций: ', error);
          // }
        }

        const sqlite = new Database(dbPath);
        const db = drizzle(sqlite, { schema });
        migrate(db, { migrationsFolder: './drizzle' });

        return db;
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
