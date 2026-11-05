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

  it('reports repeated regional and widespread TCP failures separately', async () => {
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
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        'node=de1.node.check-host.net&node=ch1.node.check-host.net',
      ),
      expect.any(Object),
    );
    results = {
      'ru1.node.check-host.net': [{ error: 'Connection timed out' }],
      'ru2.node.check-host.net': [{ error: 'Connection timed out' }],
    };
    await service.check();
    expect(send).not.toHaveBeenCalled();
    results = {
      ...results,
      'de1.node.check-host.net': [{ error: 'Connection timed out' }],
      'ch1.node.check-host.net': [{ error: 'Connection timed out' }],
    };
    await service.check();
    expect(send).not.toHaveBeenCalled();
    results = {
      ...results,
      'de1.node.check-host.net': [{ time: 0.01 }],
    };
    results['ru2.node.check-host.net'] = [];
    await service.check();
    expect(send).not.toHaveBeenCalled();
    results['ru2.node.check-host.net'] = [{ error: 'Connection timed out' }];
    await service.check();
    expect(send).not.toHaveBeenCalled();
    await service.check();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      '123',
      expect.stringContaining('блокировка IP не доказана'),
      { parse_mode: 'Markdown' },
    );
    expect(send.mock.calls[0][1]).toContain(
      'контрольный узел за пределами РФ подключился',
    );
    expect(send.mock.calls[0][1]).toContain(
      'check-host.net/check-report/probe',
    );

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

    results = {
      'ru1.node.check-host.net': [{ error: 'Connection timed out' }],
      'ru2.node.check-host.net': [{ error: 'Connection timed out' }],
      'de1.node.check-host.net': [{ error: 'Connection timed out' }],
      'ch1.node.check-host.net': [{ error: 'Connection timed out' }],
    };
    await service.check();
    expect(send).toHaveBeenCalledTimes(2);
    await service.check();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][1]).toContain('все четыре узла');
    expect(send.mock.calls[2][1]).toContain('причина неизвестна');

    results['de1.node.check-host.net'] = [{ time: 0.01 }];
    await service.check();
    expect(send).toHaveBeenCalledTimes(3);
    await service.check();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3][1]).toContain('региональная недоступность');
  });
});
