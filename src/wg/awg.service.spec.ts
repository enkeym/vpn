import { exec, execFile, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HostNetworkService } from '../network/host-network.service';
import { NotificationService } from '../notification/notification.service';
import { AwgService } from './awg.service';
import { parseAwgConfig, serializeAwgConfig } from './awg.utils';

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
      [promisify.custom]: jest
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '' }),
    }),
    execFile: Object.assign(jest.fn(), {
      [promisify.custom]: jest
        .fn()
        .mockResolvedValue({ stdout: '', stderr: '' }),
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
    process.env.AWG_HEADER_PROTECTION = 'false';
    process.env.AWG_WAN_IFACE = 'test0';
    jest.mocked(existsSync).mockReturnValue(false);
    jest.mocked(readFile).mockResolvedValue('0');
    jest.mocked(writeFile).mockResolvedValue(undefined);
    jest.mocked(promisify(exec)).mockResolvedValue({ stdout: '', stderr: '' });
    jest
      .mocked(promisify(execFile))
      .mockResolvedValue({ stdout: '', stderr: '' });
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

  it('exports IPv4-only routes with the configured port and DNS', async () => {
    process.env.AWG_ADDRESS6 = '';
    process.env.AWG_ALLOWED_IPS = '0.0.0.0/0';
    process.env.AWG_PORT = '5667';
    process.env.AWG_DNS = '149.112.112.112, 8.8.4.4';
    const service = await createService();

    const config = await service.buildClientConfig({
      privateKey: Buffer.alloc(32, 8).toString('base64'),
      presharedKey: Buffer.alloc(32, 9).toString('base64'),
      ip: '10.9.0.3',
    });
    const server = parseAwgConfig(serverConfigText());

    expect(config).toContain('Address = 10.9.0.3/32\n');
    expect(config).toContain('DNS = 149.112.112.112, 8.8.4.4\n');
    expect(config).toContain('Endpoint = vpn.example.test:5667\n');
    expect(config).toContain('AllowedIPs = 0.0.0.0/0\n');
    expect(config).not.toContain('::/0');
    expect(server.listenPort).toBe(5667);
    expect(server.postUp.join('\n')).toContain('iptables');
    expect(server.postUp.join('\n')).not.toContain('ip6tables');
  });

  it('applies timing and padding ranges to an existing server configuration', async () => {
    await createService();
    let stored = serverConfigText();
    await module?.close();
    jest.clearAllMocks();
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
    process.env.AWG_CONTENT_PADDING = '10-100';
    process.env.AWG_REKEY_AFTER_TIME = '100-120';
    process.env.AWG_REKEY_TIMEOUT = '3-8';
    process.env.AWG_REJECT_AFTER_TIME = '150-180';
    process.env.AWG_KEEPALIVE_TIMEOUT = '7-13';
    process.env.AWG_MAX_HANDSHAKE_ATTEMPTS = '15-20';
    process.env.AWG_PERSISTENT_KEEPALIVE = '25-35';

    const service = await createService();
    const client = await service.buildClientConfig({
      privateKey: Buffer.alloc(32, 8).toString('base64'),
      presharedKey: Buffer.alloc(32, 9).toString('base64'),
      ip: '10.9.0.3',
    });

    for (const line of [
      'ContentPaddingAddition = 10-100',
      'RekeyAfterTime = 100-120',
      'RekeyTimeout = 3-8',
      'RejectAfterTime = 150-180',
      'KeepaliveTimeout = 7-13',
      'MaxHandshakeAttempts = 15-20',
    ]) {
      expect(stored).toContain(line);
      expect(client).toContain(line);
    }
    expect(client).toContain('PersistentKeepalive = 25-35');
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
      expect(config).toContain('Endpoint = vpn.example.test:51821');
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
      expect(server.listenPort).toBe(51821);
      expect(server.postUp.join('\n')).not.toContain('PREROUTING');
      expect(server.postUp.join('\n')).not.toContain('--set-mss');
    },
  );

  it.each([true, false])(
    'removes obsolete port rules with interface present=%s and preserves the next startup',
    async (interfacePresent) => {
      process.env.AWG_HEADER_PROTECTION = String(interfacePresent);
      expect((await createService()).isEnabled()).toBe(true);
      const first = parseAwgConfig(serverConfigText());
      expect(first.obfuscation.s3).toBeGreaterThan(0);
      expect(first.obfuscation.s4).toBeGreaterThan(0);
      for (const key of ['h1', 'h2', 'h3', 'h4'] as const) {
        expect(first.obfuscation[key]).toMatch(/^\d+-\d+$/);
      }
      if (interfacePresent) {
        expect(
          Buffer.from(first.awg3.headerProtectionKey ?? '', 'base64'),
        ).toHaveLength(32);
      } else {
        expect(first.awg3.headerProtectionKey).toBeUndefined();
      }
      const obsolete = [
        'iptables -t nat -D PREROUTING -i test0 -p udp --dport 443 -j DNAT --to-destination :51821',
        'iptables -t nat -D PREROUTING -p udp --dport 4500 -j REDIRECT --to-ports 51821',
      ];
      let stored = serializeAwgConfig({
        ...first,
        postUp: [
          ...first.postUp,
          ...obsolete.map((rule) => rule.replace(' -D ', ' -A ')),
        ],
        postDown: [
          ...obsolete.map((rule) => `${rule} || true`),
          ...first.postDown,
        ],
      });
      await module?.close();
      jest.clearAllMocks();
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
      let interfaceUp = interfacePresent;
      const run = jest.mocked(promisify(exec));
      run.mockImplementation((command) => {
        const result =
          command === 'ip link show awg0' && !interfaceUp
            ? Promise.reject(new Error('Interface absent'))
            : Promise.resolve({ stdout: '', stderr: '' });
        if (command.includes('awg-quick down')) {
          expect(stored).toContain('PREROUTING');
          interfaceUp = false;
        }
        return Object.assign(result, { child: new ChildProcess() });
      });

      expect((await createService()).isEnabled()).toBe(true);

      expect(stored).not.toContain('PREROUTING');
      const migrated = parseAwgConfig(stored);
      expect(migrated.privateKey).toBe(first.privateKey);
      expect(migrated.obfuscation).toEqual(first.obfuscation);
      expect(migrated.awg3).toEqual(first.awg3);
      expect(migrated.listenPort).toBe(51821);
      if (interfacePresent) {
        expect(run).toHaveBeenCalledWith(
          expect.stringContaining('awg-quick down'),
        );
      } else {
        for (const rule of obsolete) {
          expect(promisify(execFile)).toHaveBeenCalledWith(
            'sudo',
            rule.split(' '),
          );
        }
      }
      const reloaded = stored;
      await module?.close();
      expect((await createService()).isEnabled()).toBe(true);
      expect(stored).toBe(reloaded);
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

  it('restores a missing interface after two failures without rewriting keys', async () => {
    const service = await createService();
    jest.mocked(existsSync).mockReturnValue(true);
    jest.mocked(writeFile).mockClear();
    const command = jest.mocked(promisify(exec));
    command.mockClear();
    command.mockImplementation((text) => {
      const result = text.startsWith('ip link show')
        ? Promise.reject(new Error('missing interface'))
        : Promise.resolve({ stdout: '', stderr: '' });
      return Object.assign(result, { child: new ChildProcess() });
    });
    jest
      .mocked(promisify(execFile))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValue({ stdout: '51821\n', stderr: '' });

    await service.restoreInterface();
    expect(command).not.toHaveBeenCalled();
    await service.restoreInterface();

    expect(
      command.mock.calls.some(([text]) =>
        String(text).includes('awg-quick up'),
      ),
    ).toBe(true);
    expect(service.isEnabled()).toBe(true);
    expect(await service.isHealthy()).toBe(true);
    expect(
      jest
        .mocked(writeFile)
        .mock.calls.some(
          ([file]) =>
            typeof file === 'string' && file.endsWith('/configs/awg0.conf'),
        ),
    ).toBe(false);
  });

  it('does not recreate a missing saved configuration during recovery', async () => {
    const service = await createService();
    jest.mocked(writeFile).mockClear();
    jest.mocked(promisify(exec)).mockClear();

    await service.restoreInterface();
    await service.restoreInterface();

    expect(service.isEnabled()).toBe(false);
    expect(await service.isHealthy()).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(promisify(exec)).not.toHaveBeenCalled();
  });

  it('keeps a healthy interface running without restarting it', async () => {
    const service = await createService();
    jest
      .mocked(promisify(execFile))
      .mockResolvedValue({ stdout: '51821\n', stderr: '' });
    jest.mocked(promisify(exec)).mockClear();

    await service.restoreInterface();
    await service.restoreInterface();

    expect(await service.isHealthy()).toBe(true);
    expect(promisify(exec)).not.toHaveBeenCalled();
  });

  it('reports a runtime command failure as unhealthy', async () => {
    const service = await createService();
    jest.mocked(promisify(execFile)).mockRejectedValue(new Error('timeout'));

    expect(await service.isHealthy()).toBe(false);
  });
});
