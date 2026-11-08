import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { CacheService } from 'src/common/cache/cache.service';
import * as schema from '../database/schema';
import { FamilyService } from './family.service';

describe('FamilyService.addMember guards', () => {
  function createService(): FamilyService {
    return new FamilyService(
      {} as unknown as BetterSQLite3Database<typeof schema>,
      {} as unknown as CacheService,
    );
  }

  it('rejects adding the administrator themselves', async () => {
    const service = createService();

    await expect(
      service.addMember('100', '100', undefined, () => false),
    ).rejects.toThrow('Нельзя добавить себя в группу');
  });

  it('rejects adding another administrator', async () => {
    const service = createService();

    await expect(
      service.addMember('100', '200', undefined, (id) => id === '200'),
    ).rejects.toThrow('Администратора нельзя добавить в группу');
  });
});
