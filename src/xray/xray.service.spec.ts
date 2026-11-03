import { ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, Socket } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { XrayService } from './xray.service';

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
}));
jest.mock('child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  const { promisify } = jest.requireActual<typeof import('util')>('util');
  return {
    ...actual,
    exec: Object.assign(jest.fn(), {
      [promisify.custom]: jest
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '' }),
    }),
    execFile: Object.assign(jest.fn(), {
      [promisify.custom]: jest
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '' }),
    }),
    spawn: jest.fn(),
  };
});
jest.mock('node:net', () => ({
  ...jest.requireActual<typeof import('node:net')>('node:net'),
  createConnection: jest.fn(),
}));

describe('XrayService health and proxy recovery', () => {
  const originalEnv = { ...process.env };
  let module: TestingModule;
  let service: XrayService;
  let listening: boolean;

  beforeEach(async () => {
    jest.useFakeTimers();
    process.env.PUBLIC_IPV4 = '';
    process.env.XRAY_ENABLED = 'true';
    process.env.WG_HOST = 'direct.example.test';
    process.env.XRAY_DOMAIN = 'vpn.example.test';
    process.env.XRAY_REALITY_PORT = '2053';
    process.env.XRAY_INTERNAL_REALITY_PORT = '8444';
    process.env.XRAY_INTERNAL_WS_PORT = '8880';
    listening = true;
    const child = new ChildProcess();
    jest.spyOn(child, 'kill').mockImplementation(() => {
      child.emit('exit', 0, null);
      return true;
    });
    jest.mocked(spawn).mockReturnValue(child);
    jest.mocked(createConnection).mockImplementation(() => {
      const socket = new Socket();
      void Promise.resolve().then(() =>
        socket.emit(listening ? 'connect' : 'error', new Error('refused')),
      );
      return socket;
    });
    jest
      .mocked(promisify(execFile))
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    module = await Test.createTestingModule({
      providers: [
        ConfigService,
        NotificationService,
        HostNetworkService,
        XrayService,
      ],
    })
      .setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn() })
      .compile();
    service = module.get(XrayService);
    await service.onModuleInit();
    jest.mocked(promisify(execFile)).mockClear();
  });

  afterEach(async () => {
    await module.close();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('uses one public port for both channel links and subscription parameters', () => {
    const uuid = 'test-client';
    const cdn = new URL(service.buildClientLink('test', uuid));
    const direct = new URL(service.buildRealityClientLink('test', uuid));

    expect(cdn.hostname).toBe('vpn.example.test');
    expect(direct.hostname).toBe('direct.example.test');
    expect(cdn.port).toBe('2053');
    expect(direct.port).toBe(cdn.port);
    expect(service.getPublicParams()).toEqual(
      expect.objectContaining({
        host: direct.hostname,
        domain: cdn.hostname,
        realityPort: Number(cdn.port),
      }),
    );
  });

  it('checks the public listener and both internal channels', async () => {
    expect(await service.isHealthy()).toBe(true);
    expect(createConnection).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: service.realityPort,
    });
    expect(createConnection).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 8444,
    });
    expect(createConnection).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 8880,
    });

    listening = false;

    expect(await service.isHealthy()).toBe(false);
  });

  it('starts nginx after two consecutive listener failures', async () => {
    listening = false;

    await service.restoreProxy();
    expect(promisify(execFile)).not.toHaveBeenCalled();
    await service.restoreProxy();

    expect(promisify(execFile)).toHaveBeenCalledWith(
      'nginx',
      ['-t'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(promisify(execFile)).toHaveBeenCalledWith(
      'nginx',
      ['-c', '/etc/nginx/nginx.conf'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('resets the failure count when the listener recovers', async () => {
    listening = false;
    await service.restoreProxy();
    listening = true;
    await service.restoreProxy();
    listening = false;
    await service.restoreProxy();

    expect(promisify(execFile)).not.toHaveBeenCalled();
  });

  it('does not start nginx when its configuration is invalid', async () => {
    listening = false;
    jest
      .mocked(promisify(execFile))
      .mockRejectedValue(new Error('invalid configuration'));

    await service.restoreProxy();
    await service.restoreProxy();

    expect(promisify(execFile)).toHaveBeenCalledTimes(1);
  });
});
