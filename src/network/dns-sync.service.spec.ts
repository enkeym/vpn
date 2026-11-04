import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from '../notification/notification.service';
import { DnsSyncService } from './dns-sync.service';
import { HostNetworkService } from './host-network.service';

jest.mock('child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  const { promisify } = jest.requireActual<typeof import('util')>('util');
  return {
    ...actual,
    execFile: Object.assign(jest.fn(), {
      [promisify.custom]: jest
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '' }),
    }),
  };
});

describe('DnsSyncService', () => {
  const originalEnv = { ...process.env };
  const ip = '192.0.2.10';
  const fetchMock = jest.fn<
    ReturnType<typeof fetch>,
    Parameters<typeof fetch>
  >();
  let module: TestingModule;
  let service: DnsSyncService;
  let records: Record<
    string,
    { id: string; type?: string; content: string; proxied: boolean }[]
  >;

  async function createService(settings: Record<string, string> = {}) {
    Object.assign(process.env, settings);
    module = await Test.createTestingModule({
      providers: [
        ConfigService,
        NotificationService,
        HostNetworkService,
        DnsSyncService,
      ],
    })
      .setLogger({ log: jest.fn(), warn: jest.fn(), error: jest.fn() })
      .compile();
    service = module.get(DnsSyncService);
  }

  function writes() {
    return fetchMock.mock.calls
      .filter(([, options]) => options?.method !== 'GET')
      .map(
        ([, options]) =>
          JSON.parse(typeof options?.body === 'string' ? options.body : '') as {
            type: string;
            name: string;
            content: string;
            proxied: boolean;
          },
      );
  }

  beforeEach(() => {
    Object.assign(process.env, {
      PUBLIC_IPV4: ip,
      AWG_WAN_IFACE: 'eth0',
      CF_API_TOKEN: 'test-token',
      CF_ZONE_ID: 'test-zone',
      CF_DNS_RECORDS: 'cdn.example.test,r.example.test',
      XRAY_DOMAIN: 'cdn.example.test',
      WG_HOST: 'r.example.test',
      XRAY_REALITY_SNI: 'cover.example.test',
    });
    jest
      .mocked(promisify(execFile))
      .mockResolvedValue({ stdout: '', stderr: '' });
    records = {};
    fetchMock.mockReset().mockImplementation((url, options) => {
      const name =
        new URL(url instanceof Request ? url.url : url).searchParams.get(
          'name',
        ) ?? '';
      const type =
        new URL(url instanceof Request ? url.url : url).searchParams.get(
          'type',
        ) ?? '';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            result:
              options?.method === 'GET'
                ? (
                    records[`${type}:${name}`] ??
                    (type
                      ? type === 'A'
                        ? records[name]
                        : undefined
                      : (records[name] ??
                        ['A', 'AAAA', 'CNAME'].flatMap(
                          (recordType) =>
                            records[`${recordType}:${name}`] ?? [],
                        ))) ??
                    []
                  ).map((record) => ({
                    ...record,
                    type: record.type ?? (type || 'A'),
                  }))
                : {},
          }),
        ),
      );
    });
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock);
  });

  afterEach(async () => {
    await module?.close();
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('preserves the CDN IP while enabling proxy and migrating direct VPN records', async () => {
    records['cdn.example.test'] = [
      { id: 'cdn', content: '192.0.2.1', proxied: false },
    ];
    records['r.example.test'] = [
      { id: 'direct', content: '192.0.2.1', proxied: true },
    ];
    await createService();

    const result = await service.ensureSynced();

    expect(result.failed).toEqual([]);
    expect(writes()).toEqual([
      {
        type: 'A',
        name: 'cdn.example.test',
        content: '192.0.2.1',
        ttl: 1,
        proxied: true,
      },
      {
        type: 'A',
        name: 'r.example.test',
        content: ip,
        ttl: 1,
        proxied: false,
      },
    ]);
  });

  it('does not rewrite an already proxied CDN record on a separate IP', async () => {
    records['cdn.example.test'] = [
      { id: 'cdn', content: '192.0.2.20', proxied: true },
    ];
    await createService({ CF_DNS_RECORDS: 'cdn.example.test' });

    await service.onApplicationBootstrap();
    const result = await service.ensureSynced();

    expect(result.ok).toEqual(['cdn.example.test']);
    expect(result.failed).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('proxies every CDN A and AAAA record while preserving their addresses', async () => {
    records['A:cdn.example.test'] = [
      { id: 'cdn-a-1', content: '192.0.2.20', proxied: false },
      { id: 'cdn-a-2', content: '192.0.2.21', proxied: false },
    ];
    records['AAAA:cdn.example.test'] = [
      {
        id: 'cdn-aaaa',
        type: 'AAAA',
        content: '2001:db8::20',
        proxied: false,
      },
    ];
    await createService({ CF_DNS_RECORDS: 'cdn.example.test' });

    const result = await service.ensureSynced();

    expect(result.failed).toEqual([]);
    expect(writes()).toEqual([
      {
        type: 'A',
        name: 'cdn.example.test',
        content: '192.0.2.20',
        ttl: 1,
        proxied: true,
      },
      {
        type: 'A',
        name: 'cdn.example.test',
        content: '192.0.2.21',
        ttl: 1,
        proxied: true,
      },
      {
        type: 'AAAA',
        name: 'cdn.example.test',
        content: '2001:db8::20',
        ttl: 1,
        proxied: true,
      },
    ]);
  });

  it('proxies a CDN CNAME target without replacing it with the server IP', async () => {
    records['CNAME:cdn.example.test'] = [
      {
        id: 'cdn-cname',
        type: 'CNAME',
        content: 'origin.example.test',
        proxied: false,
      },
    ];
    await createService({ CF_DNS_RECORDS: 'cdn.example.test' });

    const result = await service.ensureSynced();

    expect(result.failed).toEqual([]);
    expect(writes()).toEqual([
      {
        type: 'CNAME',
        name: 'cdn.example.test',
        content: 'origin.example.test',
        ttl: 1,
        proxied: true,
      },
    ]);
  });

  it('creates a missing CDN record on the current server with proxy enabled', async () => {
    await createService({ CF_DNS_RECORDS: 'cdn.example.test' });

    const result = await service.ensureSynced();

    expect(result.ok).toEqual(['cdn.example.test']);
    expect(result.failed).toEqual([]);
    expect(writes()).toEqual([
      {
        type: 'A',
        name: 'cdn.example.test',
        content: ip,
        ttl: 1,
        proxied: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/dns_records$/),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('preserves existing unrelated proxy modes and uses the default only for new records', async () => {
    records['old.example.test'] = [
      { id: 'old', content: '192.0.2.1', proxied: true },
    ];
    await createService({
      CF_DNS_RECORDS: 'old.example.test,new.example.test',
    });

    await service.ensureSynced();

    expect(writes().map(({ proxied }) => proxied)).toEqual([true, false]);
  });

  it('normalizes names and refuses conflicting CDN and direct roles before API writes', async () => {
    await createService({
      CF_DNS_RECORDS: 'CDN.example.test.',
      WG_HOST: ' cdn.example.test. ',
    });

    const result = await service.ensureSynced();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain('cdn.example.test');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not rewrite unchanged records and shares concurrent sync requests', async () => {
    records['cdn.example.test'] = [{ id: 'cdn', content: ip, proxied: true }];
    records['r.example.test'] = [{ id: 'direct', content: ip, proxied: false }];
    await createService();

    const results = await Promise.all([
      service.ensureSynced(),
      service.ensureSynced(),
    ]);

    expect(results[0]).toBe(results[1]);
    expect(results[0].ok).toHaveLength(2);
    expect(writes()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each<Record<string, string>>([{ CF_API_TOKEN: '' }, { PUBLIC_IPV4: '' }])(
    'does not write without token or applied IP: %o',
    async (settings) => {
      await createService(settings);

      await service.ensureSynced();

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('continues other records after a Cloudflare error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: 'access denied' }],
        }),
        { status: 403 },
      ),
    );
    await createService();

    const result = await service.ensureSynced();

    expect(result.failed).toEqual([
      'cdn.example.test: Cloudflare 403: access denied',
    ]);
    expect(result.ok).toEqual(['r.example.test']);
    expect(writes()).toEqual([
      expect.objectContaining({ name: 'r.example.test', proxied: false }),
    ]);
  });
});
