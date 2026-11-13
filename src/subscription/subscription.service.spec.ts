import type { IXrayPublicParams, XrayService } from 'src/xray/xray.service';
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
  wsHost: 'cdn.example.test',
  wsPath: '/ws-test',
  cdnXhttp: null,
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
    tlsSettings?: { serverName: string; fingerprint: string };
    wsSettings?: { path: string; headers: { Host: string } };
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
  it('returns the single CDN WS profile', () => {
    const profiles = makeService().buildXrayConfigArray(PEER);

    expect(profiles.map((profile) => profile.remarks)).toEqual(['CDN WS']);
  });

  it('uses the CDN WS transport with IPv4 dialing', () => {
    const [profile] = makeService().buildXrayConfigArray(PEER);
    const ws = outboundsOf(profile).find(
      (outbound) => outbound.tag === 'proxy-ws',
    )!;

    expect(ws.protocol).toBe('vless');
    expect(ws.settings.vnext[0].address).toBe(XRAY_PARAMS.wsHost);
    expect(ws.settings.vnext[0].port).toBe(443);
    expect(ws.settings.vnext[0].users[0]).toEqual({
      id: PEER.vlessUuid,
      encryption: 'none',
    });
    expect(ws.streamSettings.network).toBe('ws');
    expect(ws.streamSettings.tlsSettings).toEqual({
      serverName: XRAY_PARAMS.wsHost,
      fingerprint: 'chrome',
    });
    expect(ws.streamSettings.wsSettings).toEqual({
      path: XRAY_PARAMS.wsPath,
      headers: { Host: XRAY_PARAMS.wsHost },
    });
    expect(ws.streamSettings.sockopt).toEqual({ domainStrategy: 'UseIPv4' });
  });

  it('routes all traffic through ws without other channels', () => {
    const [profile] = makeService().buildXrayConfigArray(PEER);

    expect(outboundsOf(profile).map((outbound) => outbound.tag)).toEqual([
      'proxy-ws',
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
