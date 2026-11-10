import type { IXrayPublicParams, XrayService } from 'src/xray/xray.service';
import type { HysteriaService } from 'src/hysteria/hysteria.service';
import { SubscriptionService } from './subscription.service';

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
    sockopt?: { dialerProxy?: string };
    grpcSettings?: { serviceName: string; multiMode: boolean };
    xhttpSettings?: { path: string; mode: string };
  };
}

interface IRouting {
  balancers: Array<{ tag: string; selector: string[] }>;
  rules: Array<Record<string, unknown>>;
}

const HYSTERIA_PARAMS = {
  host: 'vpn.example.test',
  port: 443,
  sni: 'r.example.test',
  obfsPassword: 'obfs-secret',
};

function makeService(
  obfsPassword: string | null = HYSTERIA_PARAMS.obfsPassword,
): SubscriptionService {
  const xray = {
    getPublicParams: () => XRAY_PARAMS,
    buildShareLinks: () => [
      'vless://tcp@vpn.example.test:8443',
      'vless://grpc@vpn.example.test:27443',
      'vless://xhttp@vpn.example.test:27444',
    ],
  };
  const hysteria = {
    getPublicParams: () => ({ ...HYSTERIA_PARAMS, obfsPassword }),
    getPassword: (name: string) => `pass-${name}`,
    buildShareLink: (name: string) =>
      `hysteria2://pass-${name}@vpn.example.test:443/?sni=r.example.test#${name}`,
  };
  return new SubscriptionService(
    xray as unknown as XrayService,
    hysteria as unknown as HysteriaService,
  );
}

function outboundsOf(config: Record<string, unknown>): IOutbound[] {
  return config.outbounds as IOutbound[];
}

describe('SubscriptionService Xray config array', () => {
  const profiles = makeService().buildXrayConfigArray(PEER);

  it('returns an auto profile and one profile per channel', () => {
    expect(profiles.map((profile) => profile.remarks)).toEqual([
      '⚡ Авто-обход',
      'Reality gRPC',
      'Reality XHTTP',
      'Reality TCP + fragment',
    ]);
  });

  it('selects every channel in the auto balancer', () => {
    const auto = profiles[0];
    const routing = auto.routing as IRouting;
    const tags = outboundsOf(auto).map((outbound) => outbound.tag);

    expect(routing.balancers[0]).toEqual(
      expect.objectContaining({ selector: ['proxy'] }),
    );
    expect(tags).toEqual(
      expect.arrayContaining(['proxy-tcp', 'proxy-grpc', 'proxy-xhttp']),
    );
    expect(auto.burstObservatory).toEqual(
      expect.objectContaining({ subjectSelector: ['proxy'] }),
    );
  });

  it('uses the configured transport and flow per channel', () => {
    const auto = profiles[0];
    const byTag = new Map(
      outboundsOf(auto).map((outbound) => [outbound.tag, outbound]),
    );

    const tcp = byTag.get('proxy-tcp')!;
    const grpc = byTag.get('proxy-grpc')!;
    const xhttp = byTag.get('proxy-xhttp')!;

    expect(tcp.streamSettings.network).toBe('tcp');
    expect(tcp.settings.vnext[0].users[0].flow).toBe('xtls-rprx-vision');
    expect(grpc.streamSettings.network).toBe('grpc');
    expect(grpc.settings.vnext[0].port).toBe(XRAY_PARAMS.grpcPort);
    expect(grpc.streamSettings.grpcSettings).toEqual({
      serviceName: XRAY_PARAMS.grpcService,
      multiMode: true,
    });
    expect(grpc.settings.vnext[0].users[0]).not.toHaveProperty('flow');
    expect(xhttp.streamSettings.network).toBe('xhttp');
    expect(xhttp.settings.vnext[0].port).toBe(XRAY_PARAMS.xhttpPort);
    expect(xhttp.streamSettings.xhttpSettings).toEqual({
      path: XRAY_PARAMS.xhttpPath,
      mode: XRAY_PARAMS.xhttpMode,
    });
    expect(xhttp.settings.vnext[0].users[0]).not.toHaveProperty('flow');
  });

  it('fragments only the bare TCP channel', () => {
    const autoByTag = new Map(
      outboundsOf(profiles[0]).map((outbound) => [outbound.tag, outbound]),
    );

    expect(autoByTag.get('proxy-tcp')!.streamSettings.sockopt).toEqual({
      dialerProxy: 'fragment',
    });
    expect(autoByTag.get('proxy-grpc')!.streamSettings).not.toHaveProperty(
      'sockopt',
    );
    expect(autoByTag.get('proxy-xhttp')!.streamSettings).not.toHaveProperty(
      'sockopt',
    );

    const grpcProfileTags = outboundsOf(profiles[1]).map(
      (outbound) => outbound.tag,
    );
    const xhttpProfileTags = outboundsOf(profiles[2]).map(
      (outbound) => outbound.tag,
    );
    const tcpProfileTags = outboundsOf(profiles[3]).map(
      (outbound) => outbound.tag,
    );

    expect(grpcProfileTags).not.toContain('fragment');
    expect(xhttpProfileTags).not.toContain('fragment');
    expect(tcpProfileTags).toContain('fragment');
  });

  it('carries no secrets besides the peer uuid', () => {
    const serialized = JSON.stringify(profiles);

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

  it('returns null when no public URL is configured', () => {
    delete process.env.SUB_PUBLIC_URL;

    expect(makeService().buildSubscriptionUrl(PEER, 'xray')).toBeNull();
  });
});

describe('SubscriptionService Hysteria2 channel', () => {
  it('adds a hysteria2 outbound to the sing-box subscription', () => {
    const outbounds = makeService().buildSingBoxConfig(PEER).outbounds as Array<
      Record<string, unknown>
    >;

    const hysteria = outbounds.find(
      (outbound) => outbound.type === 'hysteria2',
    );
    expect(hysteria).toMatchObject({
      server: HYSTERIA_PARAMS.host,
      server_port: HYSTERIA_PARAMS.port,
      password: `pass-${PEER.name}`,
      obfs: { type: 'salamander', password: HYSTERIA_PARAMS.obfsPassword },
      tls: { enabled: true, server_name: HYSTERIA_PARAMS.sni },
    });

    const auto = outbounds.find((outbound) => outbound.type === 'urltest');
    expect(auto?.outbounds).toContain(hysteria?.tag);
  });

  it('omits obfs when the server disables it', () => {
    const outbounds = makeService(null).buildSingBoxConfig(PEER)
      .outbounds as Array<Record<string, unknown>>;

    expect(
      outbounds.find((outbound) => outbound.type === 'hysteria2'),
    ).not.toHaveProperty('obfs');
  });

  it('adds the hysteria2 link to the base64 subscription', () => {
    const links = Buffer.from(
      makeService().buildBase64Subscription(PEER),
      'base64',
    )
      .toString('utf-8')
      .split('\n');

    expect(links).toContain(
      `hysteria2://pass-${PEER.name}@vpn.example.test:443/?sni=r.example.test#${PEER.name}`,
    );
    expect(links.filter((link) => link.startsWith('vless://'))).toHaveLength(3);
  });
});
