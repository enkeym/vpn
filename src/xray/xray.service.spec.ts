import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'node:util';
import { createConnection, Socket } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { XrayService } from './xray.service';
import { SubscriptionService } from '../subscription/subscription.service';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(() => true),
}));
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(
    JSON.stringify({
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
  let child: ChildProcess;
  let listening: boolean;

  beforeEach(async () => {
    jest.useFakeTimers();
    process.env.PUBLIC_IPV4 = '';
    process.env.XRAY_ENABLED = 'true';
    process.env.WG_HOST = 'direct.example.test';
    process.env.XRAY_REALITY_PORT = '2053';
    process.env.XRAY_INTERNAL_REALITY_PORT = '8444';
    process.env.XRAY_INTERNAL_STEAL_PORT = '8446';
    listening = true;
    child = new ChildProcess();
    Object.defineProperty(child, 'exitCode', { value: null });
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
        SubscriptionService,
      ],
    })
      .setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn() })
      .compile();
    service = module.get(XrayService);
    await service.onModuleInit();
    Reflect.set(service, 'enabled', true);
    Reflect.set(service, 'currentProc', child);
    jest.mocked(promisify(execFile)).mockClear();
  });

  afterEach(async () => {
    await module.close();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('uses the Reality port in links and subscription parameters', () => {
    const uuid = 'test-client';
    const direct = new URL(service.buildRealityClientLink('test', uuid));

    expect(direct.hostname).toBe('direct.example.test');
    expect(direct.port).toBe('2053');
    expect(service.getPublicParams()).toEqual(
      expect.objectContaining({
        host: direct.hostname,
        realityPort: Number(direct.port),
      }),
    );
  });

  it('exports a Reality link with the actual TLS parameters', () => {
    const subscription = module.get(SubscriptionService);
    const peer = { name: 'Тест #1', vlessUuid: 'test-client' };

    const links = subscription.buildShareLinks(peer);
    const link = new URL(links[0]);
    const decoded = Buffer.from(
      subscription.buildBase64Subscription(peer),
      'base64',
    ).toString('utf-8');

    expect(links).toHaveLength(1);
    expect(decoded).toBe(links[0]);
    expect(link.protocol).toBe('vless:');
    expect(link.hostname).toBe('direct.example.test');
    expect(link.searchParams.get('security')).toBe('reality');
    expect(link.searchParams.get('type')).toBe('tcp');
    expect(link.searchParams.get('flow')).toBe('xtls-rprx-vision');
    expect(link.searchParams.get('sni')).toBe('www.wikipedia.org');
    expect(link.searchParams.get('fp')).toBe('chrome');
    expect(decodeURIComponent(link.hash.slice(1))).toBe(
      `${peer.name} · Reality`,
    );
  });

  it('routes subscription DNS through VPN without a server resolution loop', () => {
    const subscription = module.get(SubscriptionService);

    const config = subscription.buildSingBoxConfig({
      name: 'Тест',
      vlessUuid: 'test-client',
    });

    expect(config).toEqual(
      expect.objectContaining({
        outbounds: expect.arrayContaining([
          expect.objectContaining({
            type: 'vless',
            tag: 'Reality · direct.example.test',
            server: 'direct.example.test',
            flow: 'xtls-rprx-vision',
            tls: expect.objectContaining({
              server_name: 'www.wikipedia.org',
              reality: expect.objectContaining({
                enabled: true,
                public_key: 'test-public',
                short_id: '01234567',
              }),
            }),
          }),
          expect.objectContaining({
            tag: 'auto',
            outbounds: ['Reality · direct.example.test'],
          }),
        ]),
        dns: expect.objectContaining({
          final: 'dns-remote',
          servers: [
            expect.objectContaining({ tag: 'dns-remote', detour: 'select' }),
            { type: 'https', tag: 'dns-bootstrap', server: '1.1.1.1' },
          ],
        }),
      }),
    );
    expect(JSON.stringify(config)).not.toContain('"type":"direct"');

    const reality = (config.outbounds as Record<string, unknown>[]).find(
      (outbound) => outbound.type === 'vless',
    );
    expect(reality).not.toHaveProperty('domain_resolver');
    expect(config.route).not.toHaveProperty('default_domain_resolver');

    const withoutDns = { ...config };
    delete withoutDns.dns;
    expect(JSON.stringify(withoutDns)).not.toContain('dns-bootstrap');
    expect(JSON.stringify(withoutDns)).not.toContain('dns-remote');

    const full = subscription.buildFullSingBoxConfig({
      name: 'Тест',
      vlessUuid: 'test-client',
    });
    const fullReality = (full.outbounds as Record<string, unknown>[]).find(
      (outbound) => outbound.type === 'vless',
    );
    expect(fullReality).toMatchObject({
      domain_resolver: { server: 'dns-bootstrap', strategy: 'prefer_ipv4' },
    });
    expect(full.route).toMatchObject({ default_domain_resolver: 'dns-remote' });
  });

  it('checks the public listener and the internal Reality listener', async () => {
    expect(await service.isHealthy()).toBe(true);
    expect(createConnection).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: service.realityPort,
    });
    expect(createConnection).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 8444,
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
