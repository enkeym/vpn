import { ChildProcess, spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import {
  ShadowsocksService,
  SHADOWSOCKS_2022_AES_256_GCM,
} from './shadowsocks.service';

jest.mock('child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: jest.fn(),
    spawnSync: jest.fn(() => ({ status: 0 })),
  };
});
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

interface IShadowsocksInternals {
  secrets: { masterSecret: string } | null;
  enabled: boolean;
  buildConfig: (clients: Array<{ name: string }>) => Record<string, unknown>;
}

const SECRETS = { masterSecret: 'master-secret' };

function makeService(): ShadowsocksService {
  process.env.WG_HOST = 'vpn.example.test';
  process.env.SS_PORT = '2096';

  const service = new ShadowsocksService();
  const internals = service as unknown as IShadowsocksInternals;
  internals.secrets = SECRETS;
  internals.enabled = true;
  return service;
}

function firstServer(config: Record<string, unknown>): Record<string, unknown> {
  const servers = config.servers as Array<Record<string, unknown>>;
  return servers[0];
}

describe('ShadowsocksService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('derives a stable 32-byte key per peer without storing it', () => {
    const service = makeService();
    const key = service.getPeerKey('Тест');

    expect(key).toBe(service.getPeerKey('Тест'));
    expect(key).not.toBe(service.getPeerKey('Другой'));
    expect(Buffer.from(key ?? '', 'base64')).toHaveLength(32);
    expect(key).not.toBe(service.getServerKey());
  });

  it('builds an ss:// link that parses back to method and key', () => {
    const link = makeService().buildShareLink('Тест');

    expect(link).toMatch(/^ss:\/\/[^@]+@vpn\.example\.test:2096#/);
    const userInfo = Buffer.from(
      link?.split('//')[1]?.split('@')[0] ?? '',
      'base64url',
    ).toString();
    const [method, password] = userInfo.split(':');

    expect(method).toBe(SHADOWSOCKS_2022_AES_256_GCM);
    expect(password).toBe(makeService().getPeerKey('Тест'));
  });

  it('writes every peer into users with the 2022 method', () => {
    const service = makeService();
    const config = firstServer(
      (service as unknown as IShadowsocksInternals).buildConfig([
        { name: 'Тест' },
        { name: 'Другой' },
      ]),
    );
    const users = config.users as Array<Record<string, unknown>>;

    expect(config.method).toBe(SHADOWSOCKS_2022_AES_256_GCM);
    expect(config.mode).toBe('tcp_and_udp');
    expect(config.password).toBe(service.getServerKey());
    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({
      name: 'Тест',
      password: service.getPeerKey('Тест'),
    });
  });

  it('returns no link while the channel is disabled', () => {
    const service = makeService();
    (service as unknown as IShadowsocksInternals).enabled = false;

    expect(service.buildShareLink('Тест')).toBeNull();
  });

  it('returns no link when SS_SHARE_LINKS=false', () => {
    process.env.SS_SHARE_LINKS = 'false';
    const service = makeService();

    expect(service.isShareLinkEnabled()).toBe(false);
    expect(service.buildShareLink('Тест')).toBeNull();
  });

  it('coalesces two syncs into a single restart', async () => {
    jest.useFakeTimers();
    const spawnMock = jest.mocked(spawn);
    spawnMock.mockImplementation(() => new ChildProcess());
    const service = makeService();

    const first = service.syncClients([{ name: 'Тест' }]);
    const second = service.syncClients([{ name: 'Другой' }]);
    await jest.advanceTimersByTimeAsync(2000);
    await Promise.all([first, second]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenLastCalledWith(
      expect.stringContaining('shadowsocks.json'),
      expect.any(String),
    );
    const [, configJson] = jest.mocked(writeFile).mock.calls[0] as unknown as [
      string,
      string,
    ];
    const users = firstServer(JSON.parse(configJson)).users as Array<{
      name: string;
    }>;
    expect(users).toEqual([{ name: 'Другой', password: expect.any(String) }]);
  });

  it('does not spawn without peers and drops the stale config', async () => {
    jest.useFakeTimers();
    const service = makeService();

    const sync = service.syncClients([]);
    await jest.advanceTimersByTimeAsync(2000);
    await sync;

    expect(jest.mocked(spawn)).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(
      expect.stringContaining('shadowsocks.json'),
    );
  });

  it('does not count a planned restart as a crash', async () => {
    jest.useFakeTimers();
    jest.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      jest.spyOn(child, 'kill').mockImplementation(() => {
        child.emit('exit', 0, null);
        return true;
      });
      return child;
    });
    const service = makeService();

    for (let i = 0; i < 7; i++) {
      const sync = service.syncClients([{ name: `Пир-${i}` }]);
      await jest.advanceTimersByTimeAsync(2000);
      await sync;
    }

    expect(jest.mocked(spawn)).toHaveBeenCalledTimes(7);
  });
});
