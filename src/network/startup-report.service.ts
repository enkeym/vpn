import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { NotificationService } from '../notification/notification.service';
import { AwgService } from '../wg/awg.service';
import { XrayService } from '../xray/xray.service';
import { DnsSyncService } from './dns-sync.service';
import { HostNetworkService } from './host-network.service';

/**
 * Одно сообщение админу после старта: адрес на интерфейсе, SNAT, ip_forward,
 * DNS, AWG и Xray. После смены PUBLIC_IPV4 или переезда на новый сервер видно
 * сразу, что поднялось, а что нет, и не надо идти в логи.
 *
 * AWG и Xray берутся через ModuleRef: их модули сами зависят от NetworkModule
 * (HostNetworkService), прямой импорт дал бы цикл. К OnApplicationBootstrap все
 * onModuleInit уже отработали, поэтому isEnabled() окончательный.
 */
@Injectable()
export class StartupReportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupReportService.name);

  constructor(
    private readonly hostNetwork: HostNetworkService,
    private readonly dnsSync: DnsSyncService,
    private readonly notification: NotificationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.notification.notifyAdmins(await this.buildReport());
    } catch (error) {
      // Отчёт — удобство, а не часть работы сервиса: сбой не должен ронять старт
      this.logger.error(
        `Стартовый отчёт не отправлен: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async buildReport(): Promise<string> {
    const host = await this.hostNetwork.collectChecks();
    const dns = await this.dnsSync.ensureSynced();
    const awg = this.moduleRef.get(AwgService, { strict: false });
    const xray = this.moduleRef.get(XrayService, { strict: false });

    const mark = (ok: boolean) => (ok ? '✅' : '❌');
    const lines = ['🚀 *Сервис запущен*'];

    if (host.ip && host.wan) {
      lines.push(
        `${mark(host.addressOnWan)} Адрес \`${host.ip}\` на \`${host.wan}\``,
        `${mark(host.snatFirst)} SNAT на \`${host.ip}\` первым в POSTROUTING`,
      );
    } else {
      lines.push('➖ PUBLIC\\_IPV4 не задан или не применён');
    }

    if (host.ipForward === null) {
      lines.push('➖ ip\\_forward: не удалось прочитать');
    } else {
      lines.push(
        `${mark(host.ipForward)} ip\\_forward=${host.ipForward ? 1 : 0}`,
      );
    }

    if (!dns.enabled) {
      lines.push('➖ DNS Cloudflare: выключен');
    } else if (!dns.ip) {
      lines.push('❌ DNS Cloudflare: адрес не применён, записи не тронуты');
    } else {
      lines.push(
        `${mark(dns.failed.length === 0)} DNS Cloudflare: ${dns.ok.length} ок` +
          (dns.failed.length > 0
            ? `, ошибки:\n\`${dns.failed.join('\n')}\``
            : ''),
      );
    }

    lines.push(
      `${mark(awg.isEnabled())} AmneziaWG`,
      `${mark(xray.isEnabled())} Xray (CDN: ${xray.isCdnEnabled() ? 'да' : 'нет'})`,
    );

    return lines.join('\n');
  }
}
