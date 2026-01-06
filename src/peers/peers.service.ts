import { Inject, Injectable, Logger } from '@nestjs/common';
import * as schema from '../database/schema';
import { DRIZZLE } from 'src/database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

// type TPeer = typeof schema.peers.$inferInsert;

@Injectable()
export class PeersService {
  private readonly logger = new Logger(PeersService.name);

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
  ) {}
}
