import { Global, Module } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as path from 'path';
import * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const dbPath = path.join(process.cwd(), 'configs', 'vpn.db');
        const sqlite = new Database(dbPath);
        return drizzle(sqlite, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
