import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'node:util';
import { createConnection, Socket } from 'node:net';
import { writeFile } from 'fs/promises';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { XRAY_REALITY_FLOW, XrayService } from './xray.service';
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

  it('builds the single Reality link and base64 subscription', () => {
    const subscription = module.get(SubscriptionService);
    const peer = { name: 'Тест #1', vlessUuid: 'test-client' };

    const links = subscription.buildShareLinks(peer);
    const decoded = Buffer.from(
      subscription.buildBase64Subscription(peer),
      'base64',
    ).toString('utf-8');

    expect(links).toHaveLength(1);
    expect(decoded).toBe(links.join('\n'));

    const reality = new URL(links[0]);
    expect(reality.protocol).toBe('vless:');
    expect(reality.hostname).toBe('direct.example.test');
    expect(reality.port).toBe('2053');
    expect(reality.searchParams.get('type')).toBe('tcp');
    expect(reality.searchParams.get('security')).toBe('reality');
    expect(reality.searchParams.get('encryption')).toBe('none');
    expect(reality.searchParams.get('sni')).toBe('www.wikipedia.org');
    expect(reality.searchParams.get('fp')).toBe('chrome');
    expect(reality.searchParams.get('pbk')).toBe('test-public');
    expect(reality.searchParams.get('sid')).toBe('01234567');
    expect(reality.searchParams.get('flow')).toBe(XRAY_REALITY_FLOW);
    expect(decodeURIComponent(reality.hash.slice(1))).toBe(
      `${peer.name} · Reality`,
    );
  });

  it('keeps Reality client, server and user revocation consistent', async () => {
    const subscription = module.get(SubscriptionService);
    const peer = { name: 'peer-reality', vlessUuid: 'test-reality-client' };

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
        listen: string;
        port: number;
        settings: { clients: Array<Record<string, unknown>> };
        streamSettings?: {
          network: string;
          security: string;
          realitySettings: { serverNames: string[]; shortIds: string[] };
        };
      }>;
    };
    const inbound = config.inbounds.find(({ tag }) => tag === 'reality-direct');
    const [profile] = subscription.buildXrayConfigArray(peer);
    const outbounds = profile.outbounds as Array<{
      streamSettings: {
        realitySettings: {
          serverName: string;
          publicKey: string;
          shortId: string;
        };
      };
    }>;
    const [link] = subscription.buildShareLinks(peer);
    const uri = new URL(link);
    const serverReality = inbound?.streamSettings?.realitySettings;

    expect(inbound).toMatchObject({
      listen: '127.0.0.1',
      port: 8444,
      settings: {
        clients: [
          {
            id: peer.vlessUuid,
            email: peer.name,
            flow: XRAY_REALITY_FLOW,
          },
        ],
      },
      streamSettings: { network: 'tcp', security: 'reality' },
    });
    expect(outbounds[0].streamSettings.realitySettings.serverName).toBe(
      serverReality?.serverNames[0],
    );
    expect(serverReality?.shortIds).toContain(
      outbounds[0].streamSettings.realitySettings.shortId,
    );
    expect(uri.searchParams.get('pbk')).toBe(
      outbounds[0].streamSettings.realitySettings.publicKey,
    );
    expect(uri.searchParams.get('sid')).toBe(
      outbounds[0].streamSettings.realitySettings.shortId,
    );
    expect(uri.searchParams.get('sni')).toBe(serverReality?.serverNames[0]);
    expect(uri.searchParams.get('flow')).toBe(XRAY_REALITY_FLOW);

    const singBox = subscription.buildSingBoxConfig(peer);
    const vless = (singBox.outbounds as Record<string, unknown>[]).find(
      (outbound) => outbound.type === 'vless',
    );
    expect(vless).toMatchObject({
      server: 'direct.example.test',
      server_port: 2053,
      flow: XRAY_REALITY_FLOW,
      tls: {
        enabled: true,
        server_name: 'www.wikipedia.org',
        reality: {
          enabled: true,
          public_key: 'test-public',
          short_id: '01234567',
        },
      },
    });
    expect(vless).not.toHaveProperty('transport');

    const removed = service.syncClients([]);
    await jest.advanceTimersByTimeAsync(1500);
    await removed;

    for (const tag of [
      'reality-direct',
      'reality-grpc',
      'reality-xhttp',
      'vless-ws',
    ]) {
      expect(jest.mocked(promisify(execFile))).toHaveBeenCalledWith('xray', [
        'api',
        'rmu',
        '--server=127.0.0.1:8881',
        `-tag=${tag}`,
        peer.name,
      ]);
    }
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
        host: 'direct.example.test',
        realityPort: 2053,
        realitySni: 'www.wikipedia.org',
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
            tag: 'Reality · direct.example.test',
            server: 'direct.example.test',
            server_port: 2053,
            flow: XRAY_REALITY_FLOW,
            tls: expect.objectContaining({
              server_name: 'www.wikipedia.org',
              utls: expect.objectContaining({ fingerprint: 'chrome' }),
              reality: expect.objectContaining({
                enabled: true,
                public_key: 'test-public',
                short_id: '01234567',
              }),
            }),
          }),
          expect.objectContaining({
            tag: 'select',
            outbounds: ['Reality · direct.example.test'],
            default: 'Reality · direct.example.test',
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
    const fullVless = (full.outbounds as Record<string, unknown>[]).find(
      (outbound) => outbound.type === 'vless',
    );
    expect(fullVless).toMatchObject({
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
