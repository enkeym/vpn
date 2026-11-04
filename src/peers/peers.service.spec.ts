import { ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as schema from '../database/schema';
import { DRIZZLE } from '../database/database.module';
import { CacheService } from '../common/cache/cache.service';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { AwgService } from '../wg/awg.service';
import { XrayService } from '../xray/xray.service';
import { PeersService } from './peers.service';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(() => true),
}));
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(
    JSON.stringify({
      wsPath: '/test',
      privateKey: 'test-private',
      publicKey: 'test-public',
      shortId: '01234567',
    }),
  ),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  const { promisify } = jest.requireActual<typeof import('util')>('util');
  return {
    ...actual,
    execFile: Object.assign(jest.fn(), {
      [promisify.custom]: jest
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '' }),
    }),
    spawn: jest.fn(),
  };
});

describe('PeersService without AWG', () => {
  const originalEnv = { ...process.env };
  let module: TestingModule;
  let sqlite: Database.Database;
  let peers: PeersService;

  beforeEach(async () => {
    process.env.PUBLIC_IPV4 = '';
    process.env.AWG_ENABLED = 'false';
    process.env.AWG_ADDRESS = '10.9.0.1/16';
    process.env.XRAY_ENABLED = 'true';
    process.env.WG_HOST = 'direct.example.test';
    process.env.XRAY_DOMAIN = 'vpn.example.test';
    jest.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      jest.spyOn(child, 'kill').mockImplementation(() => {
        child.emit('exit', 0, null);
        return true;
      });
      return child;
    });
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: 'drizzle' });
    module = await Test.createTestingModule({
      providers: [
        ConfigService,
        NotificationService,
        HostNetworkService,
        CacheService,
        AwgService,
        XrayService,
        PeersService,
        { provide: DRIZZLE, useValue: db },
      ],
    })
      .setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn() })
      .compile();
    await module.get(AwgService).onModuleInit();
    peers = module.get(PeersService);
    jest.mocked(writeFile).mockClear();
  });

  afterEach(async () => {
    jest.useFakeTimers();
    await module?.close();
    jest.clearAllTimers();
    jest.useRealTimers();
    sqlite?.close();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('refuses issuance when AWG is unavailable even if Xray is running', async () => {
    await module.get(XrayService).onModuleInit();
    jest.mocked(writeFile).mockClear();
    await expect(
      peers.createPeer({
        telegramId: '123',
        durationDays: 30,
      }),
    ).rejects.toThrow('VPN сейчас недоступен');
    expect(
      jest.mocked(spawn).mock.calls.some(([command]) => command === 'awg'),
    ).toBe(false);
    expect(
      jest
        .mocked(writeFile)
        .mock.calls.some(
          ([file]) => typeof file === 'string' && file.endsWith('awg0.conf'),
        ),
    ).toBe(false);
  });

  it('refuses issuance when both transports are unavailable', async () => {
    process.env.XRAY_ENABLED = 'false';
    await module.get(XrayService).onModuleInit();

    await expect(peers.createPeer({ telegramId: '123' })).rejects.toThrow(
      'VPN сейчас недоступен',
    );
    expect(sqlite.prepare('SELECT count(*) AS count FROM peers').get()).toEqual(
      { count: 0 },
    );
  });
});
