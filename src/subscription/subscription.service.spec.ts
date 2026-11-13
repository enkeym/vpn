import {
  XRAY_REALITY_FLOW,
  type IXrayPublicParams,
  type XrayService,
} from 'src/xray/xray.service';
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
    security?: string;
    realitySettings?: Record<string, string>;
    sockopt?: { domainStrategy?: string };
  };
}

function makeService(): SubscriptionService {
  const xray = { getPublicParams: () => XRAY_PARAMS };
  return new SubscriptionService(xray as unknown as XrayService);
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

  it('returns null when no public URL is configured', () => {
    delete process.env.SUB_PUBLIC_URL;

    expect(makeService().buildSubscriptionUrl(PEER, 'xray')).toBeNull();
  });
});
