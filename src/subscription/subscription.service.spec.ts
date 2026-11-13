import {
  XRAY_REALITY_FLOW,
  type IXrayPublicParams,
  type XrayService,
} from 'src/xray/xray.service';
import type {
  HysteriaService,
  IHysteriaPublicParams,
} from 'src/hysteria/hysteria.service';
import { SubscriptionService } from './subscription.service';

jest.mock('node:dns/promises', () => ({ resolve4: jest.fn() }));
import { resolve4 } from 'node:dns/promises';
const resolve4Mock = jest.mocked(resolve4);

const XRAY_PARAMS: IXrayPublicParams = {
  host: 'vpn.example.test',
  realityPort: 443,
  realityPublicKey: 'public-key',
  realityShortId: 'abcd1234',
  realitySni: 'www.wikipedia.org',
  grpcPort: 27443,
  grpcService: 'grpc-vk',
  xhttpPort: 27444,
  xhttpPath: '/xhttp',
  xhttpMode: 'auto',
  ipv6: true,
};

const PEER = { name: 'Тест', vlessUuid: 'uuid-1111' };

interface IOutbound {
  tag: string;
  protocol: string;
  settings: {
    vnext: Array<{
      address: string;
      port: number;
      users: Array<Record<string, unknown>>;
    }>;
  };
  streamSettings: {
    network: string;
    security?: string;
    realitySettings?: Record<string, string>;
    sockopt?: { domainStrategy?: string };
  };
}

const HYSTERIA_PARAMS: IHysteriaPublicParams = {
  host: 'vpn.example.test',
  port: 443,
  sni: 'www.wikipedia.org',
  obfsPassword: 'obfs-password',
};

function makeHysteria(
  overrides: Partial<{
    params: IHysteriaPublicParams;
    password: string | null;
    shareLinks: boolean;
  }> = {},
): HysteriaService {
  const disabled = overrides.password === null;
  const password = disabled ? null : (overrides.password ?? 'peer-password');
  const shareLinks = overrides.shareLinks ?? true;
  return {
    getPublicParams: () => overrides.params ?? HYSTERIA_PARAMS,
    getPassword: () => password,
    isShareLinkEnabled: () => shareLinks && password !== null,
    buildShareLink: () =>
      password === null
        ? null
        : `hysteria2://${PEER.name}:${password}@vpn.example.test:443/?sni=www.wikipedia.org#${PEER.name}`,
  } as unknown as HysteriaService;
}

function makeService(
  hysteria: HysteriaService = makeHysteria({ password: null }),
): SubscriptionService {
  const xray = {
    getPublicParams: () => XRAY_PARAMS,
    buildShareLinks: () => [`vless://${PEER.vlessUuid}@vpn.example.test:443`],
  };
  return new SubscriptionService(xray as unknown as XrayService, hysteria);
}

function outboundsOf(config: Record<string, unknown>): IOutbound[] {
  return config.outbounds as IOutbound[];
}

describe('SubscriptionService Xray config array', () => {
  it('returns the single Reality profile', () => {
    const profiles = makeService().buildXrayConfigArray(PEER);

    expect(profiles.map((profile) => profile.remarks)).toEqual(['Reality']);
  });

  it('uses the Reality transport with IPv4 dialing', () => {
    const [profile] = makeService().buildXrayConfigArray(PEER);
    const reality = outboundsOf(profile).find(
      (outbound) => outbound.tag === 'proxy-reality',
    )!;

    expect(reality.protocol).toBe('vless');
    expect(reality.settings.vnext[0].address).toBe(XRAY_PARAMS.host);
    expect(reality.settings.vnext[0].port).toBe(XRAY_PARAMS.realityPort);
    expect(reality.settings.vnext[0].users[0]).toEqual({
      id: PEER.vlessUuid,
      encryption: 'none',
      flow: XRAY_REALITY_FLOW,
    });
    expect(reality.streamSettings.network).toBe('tcp');
    expect(reality.streamSettings.security).toBe('reality');
    expect(reality.streamSettings.realitySettings).toEqual({
      serverName: XRAY_PARAMS.realitySni,
      fingerprint: 'chrome',
      publicKey: XRAY_PARAMS.realityPublicKey,
      shortId: XRAY_PARAMS.realityShortId,
    });
    expect(reality.streamSettings.sockopt).toEqual({
      domainStrategy: 'UseIPv4',
    });
  });

  it('routes all traffic through reality without other channels', () => {
    const [profile] = makeService().buildXrayConfigArray(PEER);

    expect(outboundsOf(profile).map((outbound) => outbound.tag)).toEqual([
      'proxy-reality',
      'direct',
      'block',
    ]);
    expect(profile.routing).toEqual({
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
      ],
    });
  });

  it('rejects a peer without a uuid', () => {
    expect(() =>
      makeService().buildXrayConfigArray({ name: 'Тест', vlessUuid: null }),
    ).toThrow('отсутствует vlessUuid');
  });

  it('carries no secrets besides the peer uuid', () => {
    const serialized = JSON.stringify(makeService().buildXrayConfigArray(PEER));

    expect(serialized).toContain(PEER.vlessUuid);
    expect(serialized).not.toContain('privateKey');
  });
});

describe('SubscriptionService subscription URL', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds the public URL with the requested format', () => {
    process.env.SUB_PUBLIC_URL = 'https://sub.example.test/';

    const url = makeService().buildSubscriptionUrl(PEER, 'xray');

    expect(url).toBe(
      `https://sub.example.test/sub/${PEER.vlessUuid}?format=xray`,
    );
  });

  it('keeps automatic client format selection when no format is requested', () => {
    process.env.SUB_PUBLIC_URL = 'https://sub.example.test/';

    const url = makeService().buildSubscriptionUrl(PEER);

    expect(url).toBe(`https://sub.example.test/sub/${PEER.vlessUuid}`);
  });

  it('returns null when the peer has no subscription UUID', () => {
    process.env.SUB_PUBLIC_URL = 'https://sub.example.test/';

    expect(
      makeService().buildSubscriptionUrl({ ...PEER, vlessUuid: null }),
    ).toBeNull();
  });

  it('returns null when no public URL is configured', () => {
    delete process.env.SUB_PUBLIC_URL;

    expect(makeService().buildSubscriptionUrl(PEER, 'xray')).toBeNull();
  });
});

describe('SubscriptionService Hysteria2 channel', () => {
  it('appends the hysteria2 link to the share links when the channel is live', () => {
    const links = makeService(makeHysteria()).buildShareLinks(PEER);

    expect(links).toHaveLength(2);
    expect(links[1]).toMatch(
      /^hysteria2:\/\/Тест:peer-password@vpn\.example\.test:443\//,
    );
  });

  it('keeps only Reality links when Hysteria2 is disabled', () => {
    const links = makeService().buildShareLinks(PEER);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^vless:\/\//);
  });

  it('adds a hysteria2 outbound to the sing-box config', () => {
    const config = makeService(makeHysteria()).buildSingBoxConfig(PEER);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;

    const hysteria = outbounds.find(
      (outbound) => outbound.tag === 'Hysteria2 · vpn.example.test',
    )!;
    expect(hysteria.type).toBe('hysteria2');
    expect(hysteria.server).toBe(HYSTERIA_PARAMS.host);
    expect(hysteria.server_port).toBe(HYSTERIA_PARAMS.port);
    expect(hysteria.password).toBe('Тест:peer-password');
    expect(hysteria.obfs).toEqual({
      type: 'salamander',
      password: HYSTERIA_PARAMS.obfsPassword,
    });
    expect(hysteria.tls).toEqual({
      enabled: true,
      server_name: HYSTERIA_PARAMS.sni,
    });

    const selector = outbounds.find(
      (outbound) => outbound.tag === 'select',
    )! as { outbounds: string[] };
    expect(selector.outbounds).toContain('Hysteria2 · vpn.example.test');
  });

  it('omits the hysteria2 outbound when the channel is disabled', () => {
    const config = makeService().buildSingBoxConfig(PEER);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;

    expect(outbounds.some((outbound) => outbound.type === 'hysteria2')).toBe(
      false,
    );
  });

  it('omits the hysteria2 outbound when share links are hidden', () => {
    const config = makeService(
      makeHysteria({ shareLinks: false }),
    ).buildSingBoxConfig(PEER);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;

    expect(outbounds.some((outbound) => outbound.type === 'hysteria2')).toBe(
      false,
    );
  });

  it('dials resolved IPs in the sing-box config while keeping TLS on the domain', async () => {
    resolve4Mock.mockResolvedValue(['203.0.113.10'] as never);
    const service = makeService(makeHysteria());
    await service.onModuleInit();

    const config = service.buildSingBoxConfig(PEER);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;

    const vless = outbounds.find((outbound) => outbound.type === 'vless')!;
    expect(vless.server).toBe('203.0.113.10');
    expect((vless.tls as { server_name: string }).server_name).toBe(
      XRAY_PARAMS.realitySni,
    );

    const hysteria = outbounds.find(
      (outbound) => outbound.type === 'hysteria2',
    )!;
    expect(hysteria.server).toBe('203.0.113.10');
    expect((hysteria.tls as { server_name: string }).server_name).toBe(
      HYSTERIA_PARAMS.sni,
    );
  });

  it('keeps the hostname when resolution fails', async () => {
    resolve4Mock.mockRejectedValue(new Error('NXDOMAIN') as never);
    const service = makeService(makeHysteria());
    await service.onModuleInit();

    const config = service.buildSingBoxConfig(PEER);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;

    const hysteria = outbounds.find(
      (outbound) => outbound.type === 'hysteria2',
    )!;
    expect(hysteria.server).toBe(HYSTERIA_PARAMS.host);
  });
});
