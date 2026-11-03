import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheService } from './common/cache/cache.service';
import { HostNetworkService } from './network/host-network.service';
import { NotificationService } from './notification/notification.service';
import { AwgService } from './wg/awg.service';
import { XrayService } from './xray/xray.service';

describe('AppController health', () => {
  const originalEnv = { ...process.env };
  let module: TestingModule;

  afterEach(async () => {
    await module.close();
    process.env = { ...originalEnv };
  });

  it.each([
    ['false', 'false', true],
    ['true', 'false', false],
    ['false', 'true', false],
  ] as const)(
    'reports AWG=%s and Xray=%s startup status',
    async (awg, xray, healthy) => {
      process.env.AWG_ENABLED = awg;
      process.env.XRAY_ENABLED = xray;
      module = await Test.createTestingModule({
        controllers: [AppController],
        providers: [
          ConfigService,
          AppService,
          CacheService,
          NotificationService,
          HostNetworkService,
          AwgService,
          XrayService,
        ],
      }).compile();
      const result = module.get(AppController).getHealth();

      if (healthy) {
        await expect(result).resolves.toMatchObject({
          status: 'ok',
          vpn: { awg: true, xray: true },
        });
      } else {
        await expect(result).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      }
    },
  );
});
