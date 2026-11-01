import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { AwgService } from './awg.service';
import { parseAwgConfig } from './awg.utils';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(() => false),
}));

jest.mock('fs/promises', () => ({
  ...jest.requireActual<typeof import('fs/promises')>('fs/promises'),
  readFile: jest.fn(),
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
      [promisify.custom]: () => Promise.resolve({ stdout: '', stderr: '' }),
    }),
    execFile: Object.assign(jest.fn(), {
      [promisify.custom]: () => Promise.resolve({ stdout: '', stderr: '' }),
    }),
    spawn: jest.fn(() => {
      const child: ChildProcess = new actual.ChildProcess();
      const { PassThrough: Stream } =
        jest.requireActual<typeof import('stream')>('stream');
      child.stdout = new Stream();
      queueMicrotask(() => {
        child.stdout?.emit('data', Buffer.alloc(32, 7).toString('base64'));
        child.emit('close', 0);
      });
      return child;
    }),
  };
});

describe('AwgService client configuration', () => {
  const originalEnv = { ...process.env };
  let module: TestingModule | undefined;

  beforeEach(() => {
    process.env.PUBLIC_IPV4 = '';
    process.env.WG_HOST = 'vpn.example.test';
    process.env.AWG_ENABLED = 'true';
    process.env.AWG_ADDRESS = '10.9.0.1/16';
    process.env.AWG_ADDRESS6 = 'fd42:9::1/64';
    process.env.AWG_MTU = '1200';
    process.env.AWG_TCP_MSS = '0';
    process.env.AWG_PORT = '51821';
    process.env.AWG_PUBLIC_PORT = '443';
    process.env.AWG_WAN_IFACE = 'test0';
    jest.mocked(existsSync).mockReturnValue(false);
    jest.mocked(readFile).mockResolvedValue('0');
    jest.mocked(writeFile).mockResolvedValue(undefined);
  });

  async function createService(): Promise<AwgService> {
    module = await Test.createTestingModule({
      providers: [
        ConfigService,
        NotificationService,
        HostNetworkService,
        AwgService,
      ],
    })
      .setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn() })
      .compile();
    const service = module.get(AwgService);
    await service.onModuleInit();
    return service;
  }

  function serverConfigText(): string {
    const write = jest
      .mocked(writeFile)
      .mock.calls.filter(
        ([file]) =>
          typeof file === 'string' && file.endsWith('/configs/awg0.conf'),
      )
      .at(-1);
    if (typeof write?.[1] !== 'string') {
      throw new Error('Server configuration was not written as text');
    }
    return write[1];
  }

  afterEach(async () => {
    await module?.close();
    module = undefined;
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it.each([
    {
      mtu: 1200,
      address6: 'fd42:9::1/64',
      kernelIpv6: true,
      expectedMtu: 1280,
      dualStack: true,
    },
    {
      mtu: 1400,
      address6: 'fd42:9::1/64',
      kernelIpv6: true,
      expectedMtu: 1400,
      dualStack: true,
    },
    {
      mtu: 1200,
      address6: '',
      kernelIpv6: true,
      expectedMtu: 1200,
      dualStack: false,
    },
    {
      mtu: 1200,
      address6: 'fd42:9::1/64',
      kernelIpv6: false,
      expectedMtu: 1200,
      dualStack: false,
    },
  ])(
    'exports a usable tunnel for $mtu/$address6/kernelIpv6=$kernelIpv6',
    async ({ mtu, address6, kernelIpv6, expectedMtu, dualStack }) => {
      process.env.AWG_ADDRESS6 = address6;
      process.env.AWG_MTU = String(mtu);
      jest.mocked(readFile).mockResolvedValue(kernelIpv6 ? '0' : '1');
      const service = await createService();

      const config = await service.buildClientConfig({
        privateKey: Buffer.alloc(32, 8).toString('base64'),
        presharedKey: Buffer.alloc(32, 9).toString('base64'),
        ip: '10.9.0.3',
      });

      expect(service.isEnabled()).toBe(true);
      expect(config).toContain(`MTU = ${expectedMtu}\n`);
      expect(config).toContain(
        `Address = 10.9.0.3/32${dualStack ? ', fd42:9::3/128' : ''}\n`,
      );
      expect(config).toContain('Endpoint = vpn.example.test:443');
      expect(config).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
      const serverWrite = jest
        .mocked(writeFile)
        .mock.calls.find(
          ([file]) =>
            typeof file === 'string' && file.endsWith('/configs/awg0.conf'),
        );
      expect(serverWrite).toBeDefined();
      const serverContent = serverWrite?.[1];
      if (typeof serverContent !== 'string') {
        throw new Error('Server configuration was not written as text');
      }
      const server = parseAwgConfig(serverContent);
      expect(server.mtu).toBe(expectedMtu);
      expect(server.postUp.join('\n')).not.toContain('--set-mss');
    },
  );

  it('persists scoped MSS rules and removes them when the setting is cleared', async () => {
    process.env.AWG_TCP_MSS = '960';
    const service = await createService();
    expect(service.isEnabled()).toBe(true);
    let stored = serverConfigText();
    const first = parseAwgConfig(stored);
    const rules = first.postUp.filter((rule) => rule.includes('--set-mss 960'));
    expect(rules).toHaveLength(4);
    for (const bin of ['iptables', 'ip6tables']) {
      for (const direction of ['-i', '-o']) {
        expect(rules).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              `${bin} -t mangle -A FORWARD ${direction} awg0`,
            ),
          ]),
        );
        expect(first.postDown).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              `${bin} -t mangle -D FORWARD ${direction} awg0`,
            ),
          ]),
        );
      }
    }
    await module?.close();
    process.env.AWG_TCP_MSS = '';
    jest.mocked(existsSync).mockReturnValue(true);
    jest
      .mocked(readFile)
      .mockImplementation((file) =>
        Promise.resolve(
          typeof file === 'string' && file.includes('/proc/') ? '0' : stored,
        ),
      );
    jest.mocked(writeFile).mockImplementation((file, data) => {
      if (
        typeof file === 'string' &&
        file.endsWith('/configs/awg0.conf') &&
        typeof data === 'string'
      )
        stored = data;
      return Promise.resolve();
    });

    expect((await createService()).isEnabled()).toBe(true);
    expect(stored).not.toContain('--set-mss');
    expect(parseAwgConfig(stored).privateKey).toBe(first.privateKey);
    const reloaded = stored;
    await module?.close();
    expect((await createService()).isEnabled()).toBe(true);
    expect(stored).toBe(reloaded);
  });

  it.each(['invalid', '-1', '5000'])(
    'rejects invalid MSS %s before starting the interface',
    async (value) => {
      process.env.AWG_TCP_MSS = value;
      expect((await createService()).isEnabled()).toBe(false);
      expect(writeFile).not.toHaveBeenCalled();
    },
  );
});
