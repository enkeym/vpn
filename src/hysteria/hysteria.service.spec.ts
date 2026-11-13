import { ChildProcess, spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import axios from 'axios';
import { HysteriaService } from './hysteria.service';

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

interface IHysteriaInternals {
  secrets: {
    passwordSecret: string;
    obfsPassword: string;
    statsSecret: string;
  } | null;
  enabled: boolean;
  buildConfig: (clients: Array<{ name: string }>) => string;
}

const SECRETS = {
  passwordSecret: 'password-secret',
  obfsPassword: 'obfs-secret',
  statsSecret: 'stats-secret',
};

function makeService(obfs: boolean): HysteriaService {
  process.env.WG_HOST = 'vpn.example.test';
  process.env.HY2_SNI = 'r.example.test';
  process.env.HY2_PORT = '443';
  process.env.HY2_OBFS = obfs ? 'true' : 'false';

  const service = new HysteriaService();
  const internals = service as unknown as IHysteriaInternals;
  internals.secrets = SECRETS;
  internals.enabled = true;
  return service;
}

describe('HysteriaService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('derives a stable password per peer without storing it', () => {
    const service = makeService(true);

    expect(service.getPassword('Тест')).toBe(service.getPassword('Тест'));
    expect(service.getPassword('Тест')).not.toBe(service.getPassword('Другой'));
    expect(service.getPassword('Тест')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('builds a hysteria2 link with sni and salamander obfs', () => {
    const link = makeService(true).buildShareLink('Тест');

    expect(link).toContain('hysteria2://');
    expect(link).toMatch(
      /^hysteria2:\/\/Тест:[0-9a-f]{32}@vpn\.example\.test:443\//,
    );
    expect(link).toContain('@vpn.example.test:443/');
    expect(link).toContain('sni=r.example.test');
    expect(link).toContain('obfs=salamander');
    expect(link).toContain(`obfs-password=${SECRETS.obfsPassword}`);
  });

  it('drops obfs parameters when obfs is disabled', () => {
    const link = makeService(false).buildShareLink('Тест');

    expect(link).not.toContain('obfs');
  });

  it('writes every peer into the userpass map', () => {
    const service = makeService(true);
    const config = (service as unknown as IHysteriaInternals).buildConfig([
      { name: 'Тест' },
      { name: 'Другой' },
    ]);

    expect(config).toContain('type: userpass');
    expect(config).toContain(JSON.stringify(service.getPassword('Тест')));
    expect(config).toContain(JSON.stringify(service.getPassword('Другой')));
    expect(config).toContain(`secret: ${JSON.stringify(SECRETS.statsSecret)}`);
  });

  it('returns no link while the channel is disabled', () => {
    const service = makeService(true);
    (service as unknown as IHysteriaInternals).enabled = false;

    expect(service.buildShareLink('Тест')).toBeNull();
  });

  it('returns no link when HY2_SHARE_LINKS=false', () => {
    process.env.HY2_SHARE_LINKS = 'false';
    const service = makeService(true);

    expect(service.isShareLinkEnabled()).toBe(false);
    expect(service.buildShareLink('Тест')).toBeNull();
  });

  it('tunes QUIC receive windows and keep-alive in the server config', () => {
    const config = (
      makeService(true) as unknown as IHysteriaInternals
    ).buildConfig([{ name: 'Тест' }]);

    expect(config).toContain('initStreamReceiveWindow: 8388608');
    expect(config).toContain('maxStreamReceiveWindow: 8388608');
    expect(config).toContain('initConnReceiveWindow: 20971520');
    expect(config).toContain('maxConnReceiveWindow: 20971520');
    expect(config).toContain('keepAlivePeriod: 10s');
    expect(config).toContain('maxIdleTimeout: 30s');
  });

  it('maps tx to uplink and rx to downlink without clearing the counters', async () => {
    const service = makeService(true);
    const get = jest
      .spyOn(axios, 'get')
      .mockResolvedValue({ data: { Тест: { tx: 100, rx: 900 } } });

    const stats = await service.getTrafficStats();

    expect(stats.get('Тест')).toEqual({ uplink: 100, downlink: 900 });
    const [, options] = get.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty('params');
    expect(options.headers).toEqual({ Authorization: SECRETS.statsSecret });
  });

  it('coalesces two syncs into a single restart', async () => {
    jest.useFakeTimers();
    const spawnMock = jest.mocked(spawn);
    spawnMock.mockImplementation(() => new ChildProcess());
    const service = makeService(true);

    const first = service.syncClients([{ name: 'Тест' }]);
    const second = service.syncClients([{ name: 'Другой' }]);
    await jest.advanceTimersByTimeAsync(2000);
    await Promise.all([first, second]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenLastCalledWith(
      expect.stringContaining('hysteria.yaml'),
      expect.stringContaining(`"Другой":`),
    );
  });

  it('does not spawn without peers and drops the stale config', async () => {
    jest.useFakeTimers();
    const service = makeService(true);

    const sync = service.syncClients([]);
    await jest.advanceTimersByTimeAsync(2000);
    await sync;

    expect(jest.mocked(spawn)).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(
      expect.stringContaining('hysteria.yaml'),
    );
  });

  it('does not count a planned restart as a crash', async () => {
    jest.useFakeTimers();
    const children: ChildProcess[] = [];
    jest.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      jest.spyOn(child, 'kill').mockImplementation(() => {
        child.emit('exit', 0, null);
        return true;
      });
      children.push(child);
      return child;
    });
    const service = makeService(true);

    // Семь плановых перезапусков: лимит MAX_RAPID_RESTARTS (5) не должен
    // исчерпаться, иначе следующий реальный сбой останется без автоподъёма.
    for (let i = 0; i < 7; i++) {
      const sync = service.syncClients([{ name: `Пир-${i}` }]);
      await jest.advanceTimersByTimeAsync(2000);
      await sync;
    }

    expect(jest.mocked(spawn)).toHaveBeenCalledTimes(7);
    expect(children).toHaveLength(7);
  });
});
