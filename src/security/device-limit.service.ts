import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, gte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import ipRangeCheck from 'ip-range-check';
import * as schema from 'src/database/schema';
import { DRIZZLE } from 'src/database/database.module';
import { NotificationService } from 'src/notification/notification.service';
import { XrayService } from 'src/xray/xray.service';

/**
 * Сколько проверок подряд должны показать превышение, прежде чем уведомлять.
 * Одиночный всплеск — это обычно переключение сети (Wi-Fi ↔ мобильный), когда
 * старое соединение ещё числится живым, а новое уже открылось.
 */
const CONFIRMATIONS_REQUIRED = 3;
/** Не беспокоить владельца одного конфига чаще, чем раз в сутки. */
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * Следит за числом одновременных устройств на конфиг.
 *
 * Встроенного лимита в Xray-core нет (limitIp — фича панели 3x-ui, не ядра),
 * поэтому считаем сами по списку активных IP из StatsService. Это надёжнее
 * прежнего разбора access.log: тот видел только канал reality-direct, а весь
 * CDN-трафик проходил мимо учёта.
 *
 * Режим намеренно мягкий: превышение только логируется и приводит к
 * уведомлению, доступ НЕ ограничивается. Сначала нужно понять, сколько
 * ложных срабатываний даёт эвристика на реальных пользователях.
 */
@Injectable()
export class DeviceLimitService {
  private readonly logger = new Logger(DeviceLimitService.name);
  /** peerName → сколько проверок подряд лимит был превышен. */
  private readonly strikes = new Map<string, number>();

  private readonly enabled: boolean;
  private readonly maxDevices: number;
  private readonly whitelistCidrs: string[];

  constructor(
    @Inject(DRIZZLE) private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly configService: ConfigService,
    private readonly xrayService: XrayService,
    private readonly notificationService: NotificationService,
  ) {
    this.enabled =
      this.configService.get<string>('DEVICE_LIMIT_ENABLED', 'false') ===
      'true';

    const configured = Number(
      this.configService.get<string>('DEVICE_LIMIT_MAX_DEVICES', '2'),
    );
    this.maxDevices =
      Number.isFinite(configured) && configured > 0 ? configured : 2;

    this.whitelistCidrs = (
      this.configService.get<string>('DEVICE_LIMIT_WHITELIST_CIDRS', '') ?? ''
    )
      .split(',')
      .map((cidr) => cidr.trim())
      .filter((cidr) => cidr.length > 0);
  }

  /**
   * Раз в минуту снимаем список онлайн-IP по всем пирам. Превышение должно
   * подтвердиться CONFIRMATIONS_REQUIRED раз подряд — иначе кратковременная
   * смена сети выглядела бы как лишнее устройство.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkOnlineDevices(): Promise<void> {
    if (!this.enabled) return;

    const onlineByPeer = await this.xrayService.getOnlineIps();

    for (const [peerName, ips] of onlineByPeer) {
      const counted = ips.filter((ip) => !this.isWhitelisted(ip));

      if (counted.length <= this.maxDevices) {
        this.strikes.delete(peerName);
        continue;
      }

      const strikes = (this.strikes.get(peerName) ?? 0) + 1;
      this.strikes.set(peerName, strikes);

      if (strikes < CONFIRMATIONS_REQUIRED) continue;

      this.strikes.delete(peerName);
      await this.reportExcess(peerName, counted);
    }

    // Пиры, пропавшие из выдачи, не должны копить состояние.
    for (const peerName of [...this.strikes.keys()]) {
      if (!onlineByPeer.has(peerName)) this.strikes.delete(peerName);
    }
  }

  /** Фиксирует факт и уведомляет владельца. Блокировка НЕ применяется. */
  private async reportExcess(peerName: string, ips: string[]): Promise<void> {
    if (await this.wasNotifiedRecently(peerName)) return;

    await this.db.insert(schema.peerDeviceAlerts).values({
      peerName,
      deviceCount: ips.length,
      ips: ips.join(','),
    });

    this.logger.warn(
      `Конфиг "${peerName}": ${ips.length} устройств одновременно ` +
        `(лимит ${this.maxDevices}) — владелец уведомлён, блокировка не применялась`,
    );

    await this.notifyOwner(peerName, ips.length);
  }

  private async wasNotifiedRecently(peerName: string): Promise<boolean> {
    const since = new Date(Date.now() - NOTIFY_COOLDOWN_MS);
    const recent = await this.db.query.peerDeviceAlerts.findFirst({
      where: and(
        eq(schema.peerDeviceAlerts.peerName, peerName),
        gte(schema.peerDeviceAlerts.notifiedAt, since),
      ),
      columns: { id: true },
    });

    return !!recent;
  }

  private async notifyOwner(peerName: string, count: number): Promise<void> {
    try {
      const peer = await this.db.query.peers.findFirst({
        where: eq(schema.peers.name, peerName),
        columns: { telegramId: true },
      });
      if (!peer?.telegramId) return;

      await this.notificationService.notifyUser(
        peer.telegramId,
        'Подключено больше устройств, чем предусмотрено',
        `На вашем конфиге сейчас активно ${count} устройств, ` +
          `а одна ссылка рассчитана на ${this.maxDevices}.\n\n` +
          'Пока ничего не отключено — это предупреждение. Чтобы скорость и ' +
          'стабильность не падали, оформите вторую ссылку в боте.',
      );
    } catch (error) {
      this.logger.error(
        `Не удалось уведомить владельца конфига "${peerName}": ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private isWhitelisted(ip: string): boolean {
    if (this.whitelistCidrs.length === 0) return false;

    try {
      return ipRangeCheck(ip, this.whitelistCidrs);
    } catch {
      return false;
    }
  }
}
