import { ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Api } from 'grammy';
import * as schema from '../database/schema';
import { DRIZZLE } from '../database/database.module';
import { CacheService } from '../common/cache/cache.service';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { AwgService } from '../wg/awg.service';
import { XrayService } from '../xray/xray.service';
import { PeersService } from './peers.service';
import { sendCreatedPeerMessage } from '../bot/utils/peer-media';

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

  it('issues and replaces VLESS access without AWG files or binaries', async () => {
    await module.get(XrayService).onModuleInit();
    jest.mocked(writeFile).mockClear();
    const created = await peers.createPeer({
      telegramId: '123',
      durationDays: 30,
    });
    const replaced = await peers.replacePeer(created.peer.name);
    const vlessUuid = replaced.peer.vlessUuid;
    if (!vlessUuid) throw new Error('VLESS UUID is missing');

    expect(created.config).toBe('');
    expect(replaced.config).toBe('');
    expect(replaced.peer.vlessUuid).not.toBe(created.peer.vlessUuid);
    expect(replaced.peer.expiresAt).toEqual(created.peer.expiresAt);
    const text = await peers.getPeerVlessText(replaced.peer.name);
    expect(text).toContain(replaced.peer.vlessUuid);
    expect(text).not.toContain(created.peer.vlessUuid);
    const configs = jest.mocked(writeFile).mock.calls.map(([, data]) => data);
    expect(configs.at(-1)).toContain(replaced.peer.vlessUuid);
    expect(configs.at(-1)).not.toContain(created.peer.vlessUuid);
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

    const api = new Api('123:test');
    const sendMessage = jest.spyOn(api, 'sendMessage').mockResolvedValue({
      message_id: 1,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Test' },
      text: 'delivered',
    });
    const sendDocument = jest.spyOn(api, 'sendDocument');

    await sendCreatedPeerMessage(
      api,
      '123',
      peers,
      replaced.peer,
      replaced.config,
      'Created',
      true,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '123',
      expect.stringContaining(vlessUuid),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
    expect(sendDocument).not.toHaveBeenCalled();
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

  it('rolls back issuance and trial usage when Xray cannot apply the config', async () => {
    await module.get(XrayService).onModuleInit();
    jest.mocked(writeFile).mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(
      peers.createPeer({ telegramId: '123', isTrial: true }),
    ).rejects.toThrow('disk unavailable');

    expect(sqlite.prepare('SELECT count(*) AS count FROM peers').get()).toEqual(
      { count: 0 },
    );
    expect(await peers.hasUsedTrial('123')).toBe(false);
  });

  it('preserves the old access when replacing fails in Xray', async () => {
    await module.get(XrayService).onModuleInit();
    const created = await peers.createPeer({
      telegramId: '123',
      durationDays: 30,
    });
    jest.mocked(writeFile).mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(peers.replacePeer(created.peer.name)).rejects.toThrow(
      'disk unavailable',
    );

    const peer = await peers.findPeer(created.peer.name);
    expect(peer.vlessUuid).toBe(created.peer.vlessUuid);
    expect(peer.expiresAt).toEqual(created.peer.expiresAt);
    expect(peer.lastReplacedAt).toBeNull();
  });
});
