import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'node:util';
import { createConnection, Socket } from 'node:net';
import { writeFile } from 'fs/promises';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { XrayService } from './xray.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { HysteriaService } from '../hysteria/hysteria.service';

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
  unlink: jest.fn().mockResolvedValue(undefined),
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

  async function createModule(config: Record<string, unknown> = {}) {
    return Test.createTestingModule({
      providers: [
        { provide: ConfigService, useValue: new ConfigService(config) },
        NotificationService,
        HostNetworkService,
        XrayService,
        SubscriptionService,
        HysteriaService,
      ],
    })
      .setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn() })
      .compile();
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    process.env.PUBLIC_IPV4 = '';
    process.env.XRAY_ENABLED = 'true';
    process.env.WG_HOST = 'direct.example.test';
    process.env.XRAY_REALITY_PORT = '2053';
    process.env.XRAY_INTERNAL_REALITY_PORT = '8444';
    process.env.XRAY_INTERNAL_STEAL_PORT = '8446';
    process.env.XRAY_WS_HOST = 'cdn.example.test';
    process.env.XRAY_WS_PORT = '8002';
    delete process.env.XRAY_CDN_XHTTP_HOST;
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
    module = await createModule();
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

  it('builds the single CDN WS link and base64 subscription', () => {
    const subscription = module.get(SubscriptionService);
    const peer = { name: 'Тест #1', vlessUuid: 'test-client' };

    const links = subscription.buildShareLinks(peer);
    const decoded = Buffer.from(
      subscription.buildBase64Subscription(peer),
      'base64',
    ).toString('utf-8');

    expect(links).toHaveLength(1);
    expect(decoded).toBe(links.join('\n'));

    const ws = new URL(links[0]);
    expect(ws.protocol).toBe('vless:');
    expect(ws.hostname).toBe('cdn.example.test');
    expect(ws.port).toBe('443');
    expect(ws.searchParams.get('type')).toBe('ws');
    expect(ws.searchParams.get('security')).toBe('tls');
    expect(ws.searchParams.get('host')).toBe('cdn.example.test');
    expect(ws.searchParams.get('sni')).toBe('cdn.example.test');
    expect(ws.searchParams.get('path')).toBe('/ws');
    expect(ws.searchParams.get('fp')).toBe('chrome');
    expect(ws.searchParams.get('flow')).toBeNull();
    expect(decodeURIComponent(ws.hash.slice(1))).toBe(`${peer.name} · CDN WS`);
  });

  it('keeps CDN XHTTP client, server and user revocation consistent', async () => {
    await module.close();
    module = await createModule({
      XRAY_CDN_XHTTP_HOST: 'cdn.example.test',
      XRAY_CDN_XHTTP_PATH: '/0123456789abcdef/',
      XRAY_CDN_XHTTP_PORT: '8003',
    });
    service = module.get(XrayService);
    await service.onModuleInit();
    const subscription = module.get(SubscriptionService);
    const peer = { name: 'peer-cdn', vlessUuid: 'test-cdn-client' };

    const added = service.syncClients([
      { name: peer.name, uuid: peer.vlessUuid },
    ]);
    await jest.advanceTimersByTimeAsync(1500);
    await added;
    const configCall = jest
      .mocked(writeFile)
      .mock.calls.findLast(
        ([file]) =>
          typeof file === 'string' && file.endsWith('/configs/xray.json'),
      );
    const configData = configCall?.[1];
    if (typeof configData !== 'string')
      throw new Error('Xray config was not written');
    const config = JSON.parse(configData) as {
      inbounds: Array<{
        tag: string;
        streamSettings?: Record<string, unknown>;
      }>;
    };
    const inbound = config.inbounds.find(
      ({ tag }) => tag === 'vless-cdn-xhttp',
    );
    const [profile, wsProfile] = subscription.buildXrayConfigArray(peer);
    const outbounds = profile.outbounds as Array<{
      settings: { vnext: Array<{ address: string }> };
      streamSettings: { xhttpSettings: Record<string, unknown> };
    }>;
    const [link] = subscription.buildShareLinks(peer);
    const uri = new URL(link);

    expect(inbound).toMatchObject({
      listen: '127.0.0.1',
      port: 8003,
      settings: { clients: [{ id: peer.vlessUuid, email: peer.name }] },
      streamSettings: { network: 'xhttp', security: 'none' },
    });
    expect(profile.remarks).toBe('CDN XHTTP');
    expect(wsProfile.remarks).toBe('CDN WS');
    expect(outbounds[0].streamSettings.xhttpSettings).toEqual(
      inbound?.streamSettings?.xhttpSettings,
    );
    expect(uri.searchParams.get('type')).toBe('xhttp');
    expect(uri.searchParams.get('mode')).toBe('packet-up');
    expect(uri.searchParams.get('path')).toBe('/0123456789abcdef/');
    expect(JSON.parse(uri.searchParams.get('extra') ?? '{}')).toEqual(
      outbounds[0].streamSettings.xhttpSettings.extra,
    );
    expect(JSON.stringify([profile, link])).not.toContain(
      'direct.example.test',
    );
    expect(subscription.buildSingBoxConfig(peer)).toMatchObject({
      outbounds: expect.arrayContaining([
        expect.objectContaining({
          transport: expect.objectContaining({ type: 'ws' }),
        }),
      ]),
    });

    const removed = service.syncClients([]);
    await jest.advanceTimersByTimeAsync(1500);
    await removed;

    expect(jest.mocked(promisify(execFile))).toHaveBeenCalledWith('xray', [
      'api',
      'rmu',
      '--server=127.0.0.1:8881',
      '-tag=vless-cdn-xhttp',
      peer.name,
    ]);
  });

  it.each([
    { XRAY_CDN_XHTTP_PATH: '/short/' },
    { XRAY_CDN_XHTTP_HOST: 'https://cdn.example.test' },
    { XRAY_CDN_XHTTP_PORT: '65536' },
    { XRAY_CDN_XHTTP_PORT: 'NaN' },
  ])('rejects invalid CDN XHTTP settings: %j', async (overrides) => {
    await expect(
      createModule({
        XRAY_CDN_XHTTP_HOST: 'cdn.example.test',
        XRAY_CDN_XHTTP_PATH: '/0123456789abcdef/',
        ...overrides,
      }),
    ).rejects.toThrow('Некорректные XRAY_CDN_XHTTP_HOST/PORT/PATH');
  });

  it('builds three Reality inbounds with flow only on TCP', () => {
    const buildServerConfig = Reflect.get(service, 'buildServerConfig') as (
      clients?: Array<{ name: string; uuid: string }>,
    ) => {
      inbounds: Array<{
        tag: string;
        port: number;
        settings: { clients: Array<Record<string, unknown>> };
        streamSettings: {
          network: string;
          grpcSettings?: Record<string, unknown>;
          xhttpSettings?: Record<string, unknown>;
        };
      }>;
    };

    const config = buildServerConfig.call(service, [
      { name: 'peer-a', uuid: 'uuid-a' },
    ]);
    const reality = config.inbounds.filter((inbound) =>
      inbound.tag.startsWith('reality-'),
    );

    expect(reality.map((inbound) => inbound.tag)).toEqual([
      'reality-direct',
      'reality-grpc',
      'reality-xhttp',
    ]);
    expect(reality.map((inbound) => inbound.port)).toEqual([
      8444, 27443, 27444,
    ]);

    const [tcp, grpc, xhttp] = reality;
    expect(tcp.settings.clients[0].flow).toBe('xtls-rprx-vision');
    expect(grpc.settings.clients[0]).not.toHaveProperty('flow');
    expect(xhttp.settings.clients[0]).not.toHaveProperty('flow');
    expect(grpc.streamSettings.network).toBe('grpc');
    expect(grpc.streamSettings.grpcSettings).toEqual({
      serviceName: 'grpc-vk',
      multiMode: true,
    });
    expect(xhttp.streamSettings.network).toBe('xhttp');
    expect(xhttp.streamSettings.xhttpSettings).toEqual({
      path: '/xhttp',
      mode: 'auto',
    });

    const activeInboundTags = Reflect.get(
      service,
      'activeInboundTags',
    ) as () => string[];
    expect(activeInboundTags.call(service)).toEqual([
      'reality-direct',
      'reality-grpc',
      'reality-xhttp',
      'vless-ws',
    ]);
  });

  it('serves the WebSocket channel on localhost behind the tunnel host', () => {
    const buildServerConfig = Reflect.get(service, 'buildServerConfig') as (
      clients?: Array<{ name: string; uuid: string }>,
    ) => {
      inbounds: Array<{
        tag: string;
        listen: string;
        port: number;
        protocol: string;
        settings: { clients: Array<Record<string, unknown>> };
        streamSettings: {
          network: string;
          security: string;
          wsSettings?: { path: string };
        };
      }>;
    };

    const config = buildServerConfig.call(service, [
      { name: 'peer-a', uuid: 'uuid-a' },
    ]);
    const ws = config.inbounds.find((inbound) => inbound.tag === 'vless-ws');

    expect(ws).toMatchObject({
      listen: '127.0.0.1',
      port: 8002,
      protocol: 'vless',
      streamSettings: {
        network: 'ws',
        security: 'none',
        wsSettings: { path: '/ws' },
      },
    });
    expect(ws?.settings.clients[0]).toEqual({
      id: 'uuid-a',
      email: 'peer-a',
    });
    expect(service.getPublicParams()).toEqual(
      expect.objectContaining({
        wsHost: 'cdn.example.test',
        wsPath: '/ws',
      }),
    );
  });

  it('omits the WebSocket inbound without a tunnel host', () => {
    const buildServerConfig = Reflect.get(service, 'buildServerConfig') as (
      clients?: Array<{ name: string; uuid: string }>,
    ) => { inbounds: Array<{ tag: string }> };

    Reflect.set(service, 'wsHost', '');
    const config = buildServerConfig.call(service, [
      { name: 'peer-a', uuid: 'uuid-a' },
    ]);

    expect(config.inbounds.map((inbound) => inbound.tag)).not.toContain(
      'vless-ws',
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
            tag: 'CDN WS · cdn.example.test',
            server: 'cdn.example.test',
            server_port: 443,
            tls: expect.objectContaining({
              server_name: 'cdn.example.test',
              utls: expect.objectContaining({ fingerprint: 'chrome' }),
            }),
            transport: expect.objectContaining({
              type: 'ws',
              path: '/ws',
              headers: { Host: 'cdn.example.test' },
            }),
          }),
          expect.objectContaining({
            tag: 'select',
            outbounds: ['CDN WS · cdn.example.test'],
            default: 'CDN WS · cdn.example.test',
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

    const vlessOutbounds = (
      config.outbounds as Record<string, unknown>[]
    ).filter((outbound) => outbound.type === 'vless');
    expect(vlessOutbounds).toHaveLength(1);
    expect(vlessOutbounds[0]).not.toHaveProperty('domain_resolver');

    const withoutDns = { ...config };
    delete withoutDns.dns;
    expect(JSON.stringify(withoutDns)).not.toContain('dns-bootstrap');
    expect(JSON.stringify(withoutDns)).not.toContain('dns-remote');

    const full = subscription.buildFullSingBoxConfig({
      name: 'Тест',
      vlessUuid: 'test-client',
    });
    const fullWs = (full.outbounds as Record<string, unknown>[]).find(
      (outbound) => outbound.type === 'vless',
    );
    expect(fullWs).toMatchObject({
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
