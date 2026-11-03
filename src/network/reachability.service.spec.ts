import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Api } from 'grammy';
import { NotificationService } from '../notification/notification.service';
import { HostNetworkService } from './host-network.service';
import { ReachabilityService } from './reachability.service';

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

jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

describe('ReachabilityService', () => {
  const originalEnv = { ...process.env };
  let module: TestingModule;

  afterEach(async () => {
    await module?.close();
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('reports failed probes without claiming an IP ban and announces recovery once', async () => {
    Object.assign(process.env, {
      PUBLIC_IPV4: '192.0.2.10',
      AWG_WAN_IFACE: 'eth0',
      XRAY_REALITY_PORT: '443',
      TELEGRAM_BOT_TOKEN: '123:test-token',
      TELEGRAM_ALLOWED_IDS: '123',
    });
    const send = jest.spyOn(Api.prototype, 'sendMessage').mockResolvedValue({
      message_id: 1,
      date: 0,
      chat: { id: 123, type: 'private', first_name: 'Test' },
      text: '',
    });
    let results: Record<string, unknown> = {
      'ru1.node.check-host.net': [{ time: 0.01 }],
      'ru2.node.check-host.net': null,
    };
    jest
      .spyOn(global, 'fetch')
      .mockImplementation((url) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              (url instanceof Request ? url.url : url.toString()).includes(
                '/check-tcp?',
              )
                ? { request_id: 'probe' }
                : results,
            ),
          ),
        ),
      );
    module = await Test.createTestingModule({
      providers: [
        ConfigService,
        NotificationService,
        HostNetworkService,
        ReachabilityService,
      ],
    })
      .setLogger({ log: jest.fn(), warn: jest.fn(), error: jest.fn() })
      .compile();
    module.get(NotificationService).onModuleInit();
    await module.get(HostNetworkService).ensureApplied();
    const service = module.get(ReachabilityService);

    await service.check();
    expect(send).not.toHaveBeenCalled();
    results = {
      'ru1.node.check-host.net': [{ error: 'Connection timed out' }],
      'ru2.node.check-host.net': [{ error: 'Connection timed out' }],
    };
    await service.check();
    await service.check();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      '123',
      expect.stringContaining('Это не доказывает блокировку IP'),
      { parse_mode: 'Markdown' },
    );
    expect(send.mock.calls[0][1]).toContain('forwarding, NAT и DNS');
    expect(send.mock.calls[0][1]).not.toContain('смените PUBLIC_IPV4');

    results = {
      'ru1.node.check-host.net': null,
      'ru2.node.check-host.net': null,
    };
    await service.check();
    expect(send).toHaveBeenCalledTimes(1);
    results = { 'ru1.node.check-host.net': [{ time: 0.01 }] };
    await service.check();
    await service.check();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      '123',
      expect.stringContaining('снова доступен'),
      { parse_mode: 'Markdown' },
    );
  });
});
