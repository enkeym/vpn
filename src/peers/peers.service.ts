import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import * as schema from '../database/schema';
import { DRIZZLE } from 'src/database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from 'drizzle-orm';
import { AwgService } from 'src/wg/awg.service';
import { XrayService } from 'src/xray/xray.service';
import type { IXrayClient } from 'src/xray/xray.service';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ICreatePeer, SubscriptionDuration } from './dto/create-peer.dto';
import type { DiscountEligibleDuration } from 'src/payment/pricing';
import { Mutex } from 'async-mutex';
import { NotificationService } from 'src/notification/notification.service';
import {
  CacheService,
  CacheStats,
  CACHE_NAMESPACES,
  CACHE_TTL,
} from 'src/common/cache/cache.service';
import * as QRCode from 'qrcode';

export type TPeer = typeof schema.peers.$inferInsert;
export type TPeerSelect = typeof schema.peers.$inferSelect;
type PeerPausedReason = NonNullable<TPeerSelect['pausedReason']>;

const SYNC_MAX_RETRIES = 5;
const SYNC_RETRY_DELAY_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_EXPIRED_DELETE_AFTER_DAYS = 7;
const PAID_EXPIRED_DELETE_AFTER_DAYS = 30;
const MANUAL_PAUSED_DELETE_AFTER_DAYS = 90;
const ACTIVE_PAID_INACTIVITY_NOTIFY_AFTER_DAYS = 30;
const VPN_UNAVAILABLE_MESSAGE = 'VPN сейчас недоступен. Попробуйте позже.';

function calculateExpiresAt(durationDays: SubscriptionDuration): Date {
  const now = new Date();
  return new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class PeersService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(PeersService.name);
  private readonly createPeerMutex = new Mutex();

  // Локальный кеш использованных IP для быстрого доступа (критичная оптимизация)
  private usedIpsCache: Set<string> | null = null;
  private usedIpsCacheTime = 0;
  private readonly USED_IPS_CACHE_TTL = 60 * 1000; // 1 минута

  constructor(
    @Inject(DRIZZLE) private db: BetterSQLite3Database<typeof schema>,
    private readonly tunnel: AwgService,
    private readonly xrayService: XrayService,
    private readonly notificationService: NotificationService,
    private readonly cacheService: CacheService,
  ) {}

  async onModuleInit() {
    // Прогреваем кеш IP адресов при старте
    await this.warmUpIpsCache();
    await this.backfillPausedAt();
    await this.backfillPausedReason();
  }

  /**
   * Синхронизация с туннелем — только после того, как отработали onModuleInit
   * всех модулей: awg0 до конца своего хука считается выключенным. Порядок
   * хуков между модулями Nest выбирает по топологии импортов, и forwardRef
   * между BotModule и PaymentModule утягивает PeersModule глубже WgModule —
   * PeersService инициализируется первым. onApplicationBootstrap идёт после
   * всех onModuleInit, поэтому такой гонки не знает.
   */
  async onApplicationBootstrap() {
    await this.syncWgWithDb();
    // Порядок важен: сначала выдаём vlessUuid тем пирам, что появились до
    // Xray, иначе они не попадут в список клиентов и VLESS у них не заработает.
    await this.backfillVlessUuid();
    await this.syncXrayWithDb();
  }

  /**
   * Для уже приостановленных конфигов без pausedAt проставляем pausedAt = updatedAt,
   * чтобы ежемесячная очистка могла их учитывать.
   */
  private async backfillPausedAt(): Promise<void> {
    const result = await this.db
      .update(schema.peers)
      .set({ pausedAt: sql`${schema.peers.updatedAt}` })
      .where(and(eq(schema.peers.paused, true), isNull(schema.peers.pausedAt)))
      .returning({ name: schema.peers.name });

    if (result.length > 0) {
      this.logger.log(
        `Проставлен pausedAt для ${result.length} конфигов на паузе`,
      );
    }
  }

  private async backfillPausedReason(): Promise<void> {
    const pausedPeers = await this.db.query.peers.findMany({
      columns: { id: true, expiresAt: true },
      where: and(
        eq(schema.peers.paused, true),
        isNull(schema.peers.pausedReason),
      ),
    });

    if (pausedPeers.length === 0) {
      return;
    }

    const now = new Date();
    const expiredIds = pausedPeers
      .filter((peer) => peer.expiresAt && peer.expiresAt <= now)
      .map((peer) => peer.id);
    const manualIds = pausedPeers
      .filter((peer) => !peer.expiresAt || peer.expiresAt > now)
      .map((peer) => peer.id);

    if (expiredIds.length > 0) {
      await this.db
        .update(schema.peers)
        .set({ pausedReason: 'expired' })
        .where(inArray(schema.peers.id, expiredIds));
    }

    if (manualIds.length > 0) {
      await this.db
        .update(schema.peers)
        .set({ pausedReason: 'manual' })
        .where(inArray(schema.peers.id, manualIds));
    }

    this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);
    this.logger.log(
      `Проставлена причина паузы для ${pausedPeers.length} конфигов`,
    );
  }

  /**
   * Прогрев кеша IP адресов при старте
   */
  private async warmUpIpsCache(): Promise<void> {
    const usedPeers = await this.db.query.peers.findMany({
      columns: { ip: true },
    });
    this.usedIpsCache = new Set(usedPeers.map((peer) => peer.ip));
    this.usedIpsCacheTime = Date.now();
    this.logger.log(`Кеш IP прогрет: ${this.usedIpsCache.size} адресов`);
  }

  /**
   * Получить использованные IP адреса (с кешированием)
   */
  private async getUsedIps(): Promise<Set<string>> {
    const now = Date.now();

    // Проверяем актуальность локального кеша
    if (
      this.usedIpsCache &&
      now - this.usedIpsCacheTime < this.USED_IPS_CACHE_TTL
    ) {
      return new Set(this.usedIpsCache);
    }

    // Обновляем кеш
    const usedPeers = await this.db.query.peers.findMany({
      columns: { ip: true },
    });
    this.usedIpsCache = new Set(usedPeers.map((peer) => peer.ip));
    this.usedIpsCacheTime = now;

    return new Set(this.usedIpsCache);
  }

  /**
   * Добавить IP в локальный кеш
   */
  private addIpToCache(ip: string): void {
    if (this.usedIpsCache) {
      this.usedIpsCache.add(ip);
    }
  }

  /**
   * Удалить IP из локального кеша
   */
  private removeIpFromCache(ip: string): void {
    if (this.usedIpsCache) {
      this.usedIpsCache.delete(ip);
    }
  }

  /**
   * Инвалидировать кеш пиров пользователя
   */
  private invalidateUserPeersCache(telegramId: string): void {
    this.cacheService.delete(CACHE_NAMESPACES.PEERS_BY_USER, telegramId);
    this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);
  }

  /**
   * Инвалидировать кеш конкретного пира
   */
  private invalidatePeerCache(peerName: string): void {
    this.cacheService.delete(CACHE_NAMESPACES.PEER_BY_NAME, peerName);
  }

  /**
   * Можно ли выдавать новые конфиги: awg0 поднимается только если в образе
   * есть amneziawg-go, иначе бот не должен предлагать выдачу конфига.
   */
  isTunnelAvailable(): boolean {
    return this.tunnel.isEnabled();
  }

  /**
   * Поднят ли второй канал (VLESS через Xray). Бот скрывает кнопки VLESS,
   * если процесс не запустился: ссылку собрать будет не из чего.
   */
  isXrayAvailable(): boolean {
    return this.xrayService.isEnabled();
  }

  private assertVpnAvailable(): void {
    if (!this.tunnel.isEnabled() && !this.isXrayAvailable()) {
      throw new BadRequestException(VPN_UNAVAILABLE_MESSAGE);
    }
  }

  /**
   * Есть ли URL подписки. Требует домена (XRAY_DOMAIN): без него /sub негде
   * опубликовать, и клиентам остаются только прямые vless://-ссылки — кнопки
   * «QR для sing-box» в таком режиме бессмысленны.
   */
  isSubscriptionAvailable(): boolean {
    return this.xrayService.isCdnEnabled();
  }

  private async syncWgWithDb() {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
      try {
        const activePeers = await this.db.query.peers.findMany({
          where: eq(schema.peers.paused, false),
        });

        if (!activePeers) return;

        await this.tunnel.restoreConfigs(
          activePeers.map((peer) => ({
            name: peer.name,
            publicKey: peer.publicKey,
            presharedKey: peer.presharedKey!,
            ip: peer.ip,
          })),
        );

        // Успешная синхронизация
        if (attempt > 1) {
          this.logger.log(
            `Синхронизация WG с БД успешна с ${attempt}-й попытки`,
          );
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `Ошибка синхронизации WG с БД (попытка ${attempt}/${SYNC_MAX_RETRIES}): ${lastError.message}`,
        );

        if (attempt < SYNC_MAX_RETRIES) {
          const delay = SYNC_RETRY_DELAY_MS * attempt; // Экспоненциальная задержка
          this.logger.warn(`Повторная попытка через ${delay}мс...`);
          await sleep(delay);
        }
      }
    }

    // Все попытки исчерпаны - отправляем уведомление админам
    const errorDetails = [
      `Не удалось синхронизировать конфигурацию AmneziaWG с базой данных после ${SYNC_MAX_RETRIES} попыток.`,
      ``,
      `*Ошибка:* \`${lastError?.message || 'Неизвестная ошибка'}\``,
      ``,
      `Требуется ручное вмешательство для восстановления работы VPN.`,
    ].join('\n');

    await this.notificationService.notifyCriticalError(
      'Сбой синхронизации AmneziaWG',
      errorDetails,
      SYNC_MAX_RETRIES,
    );

    this.logger.error(
      `КРИТИЧЕСКАЯ ОШИБКА: Синхронизация WG с БД провалена после ${SYNC_MAX_RETRIES} попыток. Уведомление отправлено админам.`,
    );
  }

  /**
   * Синхронизация клиентов Xray (VLESS: CDN + Reality) с БД: собирает активных
   * (не на паузе) пиров и отдаёт их XrayService. Зеркало syncWgWithDb, но
   * ошибки наружу не пробрасываем — сбой второго канала не должен ронять ни
   * старт бота, ни создание/удаление пира: AmneziaWG при этом остаётся живым.
   */
  private async syncXrayWithDb(required = false): Promise<void> {
    if (!this.xrayService.isEnabled()) {
      if (required) {
        throw new BadRequestException(VPN_UNAVAILABLE_MESSAGE);
      }
      return;
    }

    try {
      const activePeers = await this.db.query.peers.findMany({
        where: eq(schema.peers.paused, false),
        columns: { name: true, vlessUuid: true },
      });

      const clients: IXrayClient[] = activePeers
        .filter(
          (peer): peer is { name: string; vlessUuid: string } =>
            peer.vlessUuid !== null,
        )
        .map((peer) => ({ name: peer.name, uuid: peer.vlessUuid }));

      await this.xrayService.syncClients(clients);
    } catch (error) {
      if (required) throw error;
      this.logger.error(
        `Ошибка синхронизации Xray с БД: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  /**
   * Пирам, созданным до появления Xray, выдаём vlessUuid — по одному UPDATE на
   * пир, потому что значение у каждого своё. Разовая операция: после неё
   * выборка пустая и цикл не выполняется.
   */
  private async backfillVlessUuid(): Promise<void> {
    const peersWithoutUuid = await this.db.query.peers.findMany({
      columns: { name: true },
      where: isNull(schema.peers.vlessUuid),
    });

    if (peersWithoutUuid.length === 0) return;

    for (const peer of peersWithoutUuid) {
      await this.db
        .update(schema.peers)
        .set({ vlessUuid: randomUUID() })
        .where(eq(schema.peers.name, peer.name));
      this.invalidatePeerCache(peer.name);
    }

    this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);
    this.cacheService.clear(CACHE_NAMESPACES.PEERS_BY_USER);
    this.logger.log(
      `Выдан vlessUuid для ${peersWithoutUuid.length} конфигов без VLESS`,
    );
  }

  /**
   * Проверить, использовал ли пользователь пробный период (один раз на пользователя).
   * С кешированием — снижает задержки при навигации по меню.
   */
  async hasUsedTrial(telegramId: string): Promise<boolean> {
    const key = String(telegramId);
    const cached = this.cacheService.get<boolean>(
      CACHE_NAMESPACES.HAS_USED_TRIAL,
      key,
    );
    if (cached !== null) return cached;

    const existing = await this.db.query.userTrialUsage.findFirst({
      where: eq(schema.userTrialUsage.telegramId, key),
      columns: { id: true },
    });
    const result = !!existing;
    this.cacheService.set(
      CACHE_NAMESPACES.HAS_USED_TRIAL,
      key,
      result,
      CACHE_TTL.LONG,
    );
    return result;
  }

  /**
   * Проверить, использовал ли пользователь разовую скидку на 60 или 90 дней.
   * После использования одного тарифа со скидкой — второй тариф по полной цене.
   * С кешированием — снижает задержки при показе тарифов.
   */
  async hasUsedFirstPurchaseDiscount(telegramId: string): Promise<boolean> {
    const key = String(telegramId);
    const cached = this.cacheService.get<boolean>(
      CACHE_NAMESPACES.HAS_USED_DISCOUNT,
      key,
    );
    if (cached !== null) return cached;

    const existing = await this.db.query.userPromoUsage.findFirst({
      where: eq(schema.userPromoUsage.telegramId, key),
      columns: { id: true },
    });
    const result = !!existing;
    this.cacheService.set(
      CACHE_NAMESPACES.HAS_USED_DISCOUNT,
      key,
      result,
      CACHE_TTL.LONG,
    );
    return result;
  }

  /**
   * Записать использование скидки на тарифе 60 или 90 дней.
   */
  async recordPromoUsage(
    telegramId: string,
    tier: DiscountEligibleDuration,
  ): Promise<void> {
    await this.db.insert(schema.userPromoUsage).values({
      telegramId: String(telegramId),
      usedDiscountTier: tier,
    });
    this.cacheService.delete(
      CACHE_NAMESPACES.HAS_USED_DISCOUNT,
      String(telegramId),
    );
  }

  /**
   * Сбросить использование скидки на первую покупку — админ вручную
   * возвращает клиенту право на скидку при следующей покупке 60/90 дней.
   */
  async resetPromoUsage(telegramId: string): Promise<void> {
    await this.db
      .delete(schema.userPromoUsage)
      .where(eq(schema.userPromoUsage.telegramId, String(telegramId)));
    this.cacheService.delete(
      CACHE_NAMESPACES.HAS_USED_DISCOUNT,
      String(telegramId),
    );
  }

  async createPeer(dto: ICreatePeer) {
    return await this.createPeerMutex.runExclusive(async () => {
      if (!dto.telegramId || String(dto.telegramId).trim() === '') {
        throw new BadRequestException('telegramId обязателен');
      }

      const telegramIdStr = String(dto.telegramId);
      const isTrial = dto.isTrial === true;

      if (isTrial) {
        const usedTrial = await this.hasUsedTrial(telegramIdStr);
        if (usedTrial) {
          throw new BadRequestException(
            'Пробный период уже был использован. Вы можете продлить конфиг в разделе «Мои конфиги».',
          );
        }
      }

      const peerName = `${telegramIdStr.slice(0, 3)}${randomBytes(3).toString('hex')}`;

      // Быстрая проверка через кеш
      const cachedPeer = this.cacheService.get<TPeerSelect>(
        CACHE_NAMESPACES.PEER_BY_NAME,
        peerName,
      );
      if (cachedPeer) {
        throw new BadRequestException(
          `Конфиг с именем ${peerName} уже существует`,
        );
      }

      const existing = await this.db.query.peers.findFirst({
        where: eq(schema.peers.name, peerName),
      });

      if (existing) {
        throw new BadRequestException(
          `Конфиг с именем ${peerName} уже существует`,
        );
      }

      const durationDays = isTrial
        ? (3 as SubscriptionDuration)
        : dto.durationDays;

      const tunnel = this.tunnel;

      this.assertVpnAvailable();
      const awgEnabled = tunnel.isEnabled();

      const usedIps = await this.getUsedIps();
      const credentials = await tunnel.generateClientCredentials(usedIps);

      const expiresAt = durationDays ? calculateExpiresAt(durationDays) : null;

      const peerData: TPeer = {
        telegramId: dto.telegramId,
        username: dto.username || null,
        name: peerName,
        publicKey: credentials.publicKey,
        privateKey: credentials.privateKey,
        presharedKey: credentials.presharedKey,
        // Второй канал выдаётся сразу всем: один и тот же конфиг даёт и .conf
        // для AmneziaVPN, и VLESS-ссылки — пользователь выбирает то, что живо
        // на его сети. UUID генерится даже при выключенном Xray: включённый
        // позже Xray подхватит пира без бэкфилла.
        vlessUuid: randomUUID(),
        ip: credentials.ip,
        endpoint: `${tunnel.host}:${tunnel.port}`,
        paused: false,
        pausedReason: null,
        expiresAt,
        isTrial,
        rxBytes: 0,
        txBytes: 0,
      };

      const [newPeer] = await this.db
        .insert(schema.peers)
        .values(peerData)
        .returning();

      // Обновляем кеш IP
      this.addIpToCache(credentials.ip);

      try {
        const config = awgEnabled
          ? await tunnel.createClientConfig(newPeer.name, credentials)
          : '';

        await this.syncXrayWithDb(!awgEnabled);

        // Инвалидируем кеши
        this.invalidateUserPeersCache(dto.telegramId);
        if (isTrial) {
          // Фиксируем факт выдачи триала отдельно от peers: запись переживёт
          // удаление конфига по retention policy, и триал не выдастся повторно.
          await this.db
            .insert(schema.userTrialUsage)
            .values({ telegramId: telegramIdStr })
            .onConflictDoNothing();
          this.cacheService.delete(
            CACHE_NAMESPACES.HAS_USED_TRIAL,
            String(dto.telegramId),
          );
        }

        return { peer: newPeer, config };
      } catch (error) {
        this.logger.error(
          `Ошибка создания конфига: ${error instanceof Error ? error.message : error}`,
        );

        // Откатываем изменения
        await this.db
          .delete(schema.peers)
          .where(eq(schema.peers.id, newPeer.id));
        this.removeIpFromCache(credentials.ip);

        throw error;
      }
    });
  }

  async findPeer(peerName: string): Promise<TPeerSelect> {
    // Проверяем кеш
    const cached = this.cacheService.get<TPeerSelect>(
      CACHE_NAMESPACES.PEER_BY_NAME,
      peerName,
    );
    if (cached) {
      return cached;
    }

    const peer = await this.db.query.peers.findFirst({
      where: eq(schema.peers.name, peerName),
    });

    if (!peer) {
      throw new NotFoundException(`Конфиг с именем ${peerName} не найден`);
    }

    // Сохраняем в кеш
    this.cacheService.set(
      CACHE_NAMESPACES.PEER_BY_NAME,
      peerName,
      peer,
      CACHE_TTL.MEDIUM,
    );

    return peer;
  }

  /**
   * Используется публичным эндпоинтом подписки (src/subscription) — токен в URL
   * это сам vlessUuid. Пир на паузе подписку не отдаёт: его всё равно нет
   * среди клиентов Xray, и выдавать ему рабочий на вид конфиг — вводить в заблуждение.
   */
  async findPeerByVlessUuid(vlessUuid: string): Promise<TPeerSelect> {
    const peer = await this.db.query.peers.findFirst({
      where: eq(schema.peers.vlessUuid, vlessUuid),
    });

    if (!peer || peer.paused) {
      throw new NotFoundException('Конфиг не найден');
    }

    return peer;
  }

  async updatedPeer(peerName: string) {
    const peer = await this.findPeer(peerName);
    const shouldPause = !peer.paused;

    await this.db
      .update(schema.peers)
      .set({
        paused: shouldPause,
        pausedAt: shouldPause ? new Date() : null,
        pausedReason: shouldPause ? 'manual' : null,
      })
      .where(eq(schema.peers.name, peerName));

    // Инвалидируем кеши
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

    try {
      if (shouldPause) {
        await this.tunnel.removePeer(peer.publicKey);
      } else {
        if (!peer.presharedKey)
          throw new InternalServerErrorException('Нет presharedKey');

        await this.tunnel.createClientConfig(peer.name, {
          publicKey: peer.publicKey,
          privateKey: peer.privateKey,
          presharedKey: peer.presharedKey,
          ip: peer.ip,
        });
      }

      // Пауза/возобновление меняет состав активных пиров — второй канал
      // отключается/включается вместе с туннелем, иначе пир на паузе продолжит
      // ходить через VLESS.
      await this.syncXrayWithDb();
    } catch (error) {
      this.logger.error(
        `Ошибка обновления WG Для ${peerName}, отмена изменений`,
      );
      await this.db
        .update(schema.peers)
        .set({
          paused: !shouldPause,
          pausedAt: shouldPause ? null : new Date(),
          pausedReason: shouldPause ? null : peer.pausedReason,
        })
        .where(eq(schema.peers.name, peerName));

      // Повторно инвалидируем после отката
      this.invalidatePeerCache(peerName);
      this.invalidateUserPeersCache(peer.telegramId);

      throw error;
    }
  }

  async deletePeer(peerName: string) {
    const peer = await this.findPeer(peerName);

    await this.db.delete(schema.peers).where(eq(schema.peers.name, peerName));

    // Обновляем кеши
    this.removeIpFromCache(peer.ip);
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

    if (!peer.paused) {
      try {
        await this.tunnel.removePeer(peer.publicKey);
      } catch (error) {
        this.logger.error(`Не удалось удалить пир из туннеля: ${error}`);
      }
    }

    // Убираем клиента из Xray — без этого VLESS-ссылка осталась бы рабочей
    // после удаления конфига.
    await this.syncXrayWithDb();

    return { message: `Конфиг ${peerName} успешно удален` };
  }

  /**
   * Батч-удаление нескольких конфигов: один DELETE в БД и один `wg syncconf`
   * (вместо N последовательных `deletePeer` с N-кратным `syncSystem`).
   */
  async deletePeersByNames(peerNames: string[]): Promise<void> {
    if (peerNames.length === 0) return;

    const peers = await this.db.query.peers.findMany({
      columns: {
        name: true,
        ip: true,
        telegramId: true,
        publicKey: true,
        paused: true,
      },
      where: inArray(schema.peers.name, peerNames),
    });
    if (peers.length === 0) return;

    await this.db.delete(schema.peers).where(
      inArray(
        schema.peers.name,
        peers.map((p) => p.name),
      ),
    );

    for (const p of peers) {
      this.removeIpFromCache(p.ip);
      this.invalidatePeerCache(p.name);
      this.invalidateUserPeersCache(p.telegramId);
    }

    const activePeers = peers.filter((p) => !p.paused);
    if (activePeers.length > 0) {
      try {
        await this.tunnel.removePeers(activePeers.map((p) => p.publicKey));
      } catch (error) {
        this.logger.error(`Не удалось удалить пиры из туннеля: ${error}`);
      }
    }

    // Один вызов на весь батч: XrayService сам считает разницу наборов.
    await this.syncXrayWithDb();
  }

  /** Расширенная статистика для админ-панели. */
  /** Уникальные Telegram ID пользователей с конфигами (кроме заблокированных) — для Рупора. */
  async getBroadcastUserIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ telegramId: schema.peers.telegramId })
      .from(schema.peers)
      .where(
        sql`${schema.peers.telegramId} not in (select ${schema.blockedUsers.telegramId} from ${schema.blockedUsers})`,
      );
    return rows.map((row) => row.telegramId);
  }
  async getStats(): Promise<{
    totalConfigs: number;
    uniqueUsers: number;
    activeConfigs: number;
    pausedConfigs: number;
    expiredConfigs: number;
    expiringSoonConfigs: number;
    unlimitedConfigs: number;
    familyMembersCount: number;
    blockedUsersCount: number;
  }> {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [peersRow] = await this.db
      .select({
        totalConfigs: sql<number>`count(*)`,
        uniqueUsers: sql<number>`count(distinct ${schema.peers.telegramId})`,
        activeConfigs: sql<number>`sum(case when ${schema.peers.paused} = 0 then 1 else 0 end)`,
        pausedConfigs: sql<number>`sum(case when ${schema.peers.paused} = 1 then 1 else 0 end)`,
        expiredConfigs: sql<number>`sum(case when ${schema.peers.expiresAt} is not null and ${schema.peers.expiresAt} <= ${now.getTime()} then 1 else 0 end)`,
        expiringSoonConfigs: sql<number>`sum(case when ${schema.peers.paused} = 0 and ${schema.peers.expiresAt} is not null and ${schema.peers.expiresAt} > ${now.getTime()} and ${schema.peers.expiresAt} <= ${in7Days.getTime()} then 1 else 0 end)`,
        unlimitedConfigs: sql<number>`sum(case when ${schema.peers.expiresAt} is null then 1 else 0 end)`,
      })
      .from(schema.peers);

    const [familyRow] = await this.db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(schema.familyMembers);

    const [blockedRow] = await this.db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(schema.blockedUsers);

    const toNum = (v: unknown) => (v != null ? Number(v) : 0);
    return {
      totalConfigs: toNum(peersRow?.totalConfigs),
      uniqueUsers: toNum(peersRow?.uniqueUsers),
      activeConfigs: toNum(peersRow?.activeConfigs),
      pausedConfigs: toNum(peersRow?.pausedConfigs),
      expiredConfigs: toNum(peersRow?.expiredConfigs),
      expiringSoonConfigs: toNum(peersRow?.expiringSoonConfigs),
      unlimitedConfigs: toNum(peersRow?.unlimitedConfigs),
      familyMembersCount: toNum(familyRow?.count),
      blockedUsersCount: toNum(blockedRow?.count),
    };
  }

  /**
   * Расширенная аналитика по конфигам для админ-панели.
   */
  async getAnalytics(): Promise<{
    stats: {
      totalConfigs: number;
      uniqueUsers: number;
      activeConfigs: number;
      pausedConfigs: number;
      expiredConfigs: number;
      expiringSoonConfigs: number;
      unlimitedConfigs: number;
      trialConfigs: number;
      configsWithDescription: number;
      configsCreatedToday: number;
      configsCreatedThisWeek: number;
    };
    byDuration: { days: number | null; count: number }[];
    recentConfigs: Array<{
      name: string;
      telegramId: string;
      username: string | null;
      ip: string;
      createdAt: Date | null;
      expiresAt: Date | null;
      paused: boolean;
      isTrial: boolean;
    }>;
    expiringSoon: Array<{
      name: string;
      telegramId: string;
      ip: string;
      expiresAt: Date | null;
    }>;
  }> {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [peersRow] = await this.db
      .select({
        totalConfigs: sql<number>`count(*)`,
        uniqueUsers: sql<number>`count(distinct ${schema.peers.telegramId})`,
        activeConfigs: sql<number>`sum(case when ${schema.peers.paused} = 0 then 1 else 0 end)`,
        pausedConfigs: sql<number>`sum(case when ${schema.peers.paused} = 1 then 1 else 0 end)`,
        expiredConfigs: sql<number>`sum(case when ${schema.peers.expiresAt} is not null and ${schema.peers.expiresAt} <= ${now.getTime()} then 1 else 0 end)`,
        expiringSoonConfigs: sql<number>`sum(case when ${schema.peers.paused} = 0 and ${schema.peers.expiresAt} is not null and ${schema.peers.expiresAt} > ${now.getTime()} and ${schema.peers.expiresAt} <= ${in7Days.getTime()} then 1 else 0 end)`,
        unlimitedConfigs: sql<number>`sum(case when ${schema.peers.expiresAt} is null then 1 else 0 end)`,
        trialConfigs: sql<number>`sum(case when ${schema.peers.isTrial} = 1 then 1 else 0 end)`,
        configsWithDescription: sql<number>`sum(case when ${schema.peers.description} is not null and ${schema.peers.description} != '' then 1 else 0 end)`,
        configsCreatedToday: sql<number>`sum(case when ${schema.peers.createdAt} >= ${dayStart.getTime()} then 1 else 0 end)`,
        configsCreatedThisWeek: sql<number>`sum(case when ${schema.peers.createdAt} >= ${weekStart.getTime()} then 1 else 0 end)`,
      })
      .from(schema.peers);

    const toNum = (v: unknown) => (v != null ? Number(v) : 0);
    const stats = {
      totalConfigs: toNum(peersRow?.totalConfigs),
      uniqueUsers: toNum(peersRow?.uniqueUsers),
      activeConfigs: toNum(peersRow?.activeConfigs),
      pausedConfigs: toNum(peersRow?.pausedConfigs),
      expiredConfigs: toNum(peersRow?.expiredConfigs),
      expiringSoonConfigs: toNum(peersRow?.expiringSoonConfigs),
      unlimitedConfigs: toNum(peersRow?.unlimitedConfigs),
      trialConfigs: toNum(peersRow?.trialConfigs),
      configsWithDescription: toNum(peersRow?.configsWithDescription),
      configsCreatedToday: toNum(peersRow?.configsCreatedToday),
      configsCreatedThisWeek: toNum(peersRow?.configsCreatedThisWeek),
    };

    const DAY_MS = 24 * 60 * 60 * 1000;
    const byDurationRows = await this.db
      .select({
        days: sql<number | null>`case
          when ${schema.peers.expiresAt} is null then null
          else round((${schema.peers.expiresAt} - ${schema.peers.createdAt}) / ${DAY_MS})
        end`,
        count: sql<number>`count(*)`,
      })
      .from(schema.peers).groupBy(sql`case
        when ${schema.peers.expiresAt} is null then null
        else round((${schema.peers.expiresAt} - ${schema.peers.createdAt}) / ${DAY_MS})
      end`);

    const byDuration = byDurationRows.map((r) => ({
      days: r.days != null ? Number(r.days) : null,
      count: Number(r.count),
    }));

    const recentPeers = await this.db
      .select({
        name: schema.peers.name,
        telegramId: schema.peers.telegramId,
        username: schema.peers.username,
        ip: schema.peers.ip,
        createdAt: schema.peers.createdAt,
        expiresAt: schema.peers.expiresAt,
        paused: schema.peers.paused,
        isTrial: schema.peers.isTrial,
      })
      .from(schema.peers)
      .where(sql`${schema.peers.createdAt} >= ${weekStart.getTime()}`)
      .orderBy(desc(schema.peers.createdAt))
      .limit(15);

    const expiringSoonPeers = await this.db
      .select({
        name: schema.peers.name,
        telegramId: schema.peers.telegramId,
        ip: schema.peers.ip,
        expiresAt: schema.peers.expiresAt,
      })
      .from(schema.peers)
      .where(
        and(
          eq(schema.peers.paused, false),
          isNotNull(schema.peers.expiresAt),
          sql`${schema.peers.expiresAt} > ${now.getTime()}`,
          sql`${schema.peers.expiresAt} <= ${in7Days.getTime()}`,
        ),
      )
      .orderBy(schema.peers.expiresAt)
      .limit(15);

    return {
      stats,
      byDuration,
      recentConfigs: recentPeers.map((p) => ({
        name: p.name,
        telegramId: p.telegramId,
        username: p.username ?? null,
        ip: p.ip,
        createdAt: p.createdAt ?? null,
        expiresAt: p.expiresAt ?? null,
        paused: p.paused,
        isTrial: p.isTrial,
      })),
      expiringSoon: expiringSoonPeers.map((p) => ({
        name: p.name,
        telegramId: p.telegramId,
        ip: p.ip,
        expiresAt: p.expiresAt,
      })),
    };
  }

  async getPeersByTelegramId(telegramId: string): Promise<TPeerSelect[]> {
    // Проверяем кеш
    const cached = this.cacheService.get<TPeerSelect[]>(
      CACHE_NAMESPACES.PEERS_BY_USER,
      telegramId,
    );
    if (cached) {
      return cached;
    }

    const peers = await this.db.query.peers.findMany({
      where: eq(schema.peers.telegramId, telegramId),
      orderBy: [desc(schema.peers.createdAt)],
    });

    // Сохраняем в кеш
    this.cacheService.set(
      CACHE_NAMESPACES.PEERS_BY_USER,
      telegramId,
      peers,
      CACHE_TTL.MEDIUM,
    );

    return peers;
  }

  async setConfigMessageId(peerName: string, messageId: number) {
    await this.db
      .update(schema.peers)
      .set({ configMessageId: messageId })
      .where(eq(schema.peers.name, peerName));

    // Инвалидируем кеш пира
    this.invalidatePeerCache(peerName);
  }

  async setQrMessageId(peerName: string, messageId: number) {
    await this.db
      .update(schema.peers)
      .set({ qrMessageId: messageId })
      .where(eq(schema.peers.name, peerName));

    this.invalidatePeerCache(peerName);
  }

  async setFileMessageId(peerName: string, messageId: number) {
    await this.db
      .update(schema.peers)
      .set({ fileMessageId: messageId })
      .where(eq(schema.peers.name, peerName));

    this.invalidatePeerCache(peerName);
  }

  async allPeers(): Promise<TPeerSelect[]> {
    // Проверяем кеш
    const cached = this.cacheService.get<TPeerSelect[]>(
      CACHE_NAMESPACES.ALL_PEERS,
      'all',
    );
    if (cached) {
      return cached;
    }

    const peers = await this.db.query.peers.findMany({
      orderBy: [desc(schema.peers.createdAt)],
    });

    // Сохраняем в кеш с коротким TTL (данные часто меняются)
    this.cacheService.set(
      CACHE_NAMESPACES.ALL_PEERS,
      'all',
      peers,
      CACHE_TTL.SHORT,
    );

    return peers;
  }

  async deactivateExpiredPeers(): Promise<number> {
    const now = new Date();

    const expiredPeers = await this.db.query.peers.findMany({
      columns: {
        id: true,
        name: true,
        publicKey: true,
        telegramId: true,
      },
      where: and(
        eq(schema.peers.paused, false),
        isNotNull(schema.peers.expiresAt),
        lte(schema.peers.expiresAt, now),
      ),
    });

    if (expiredPeers.length === 0) {
      return 0;
    }

    const ids = expiredPeers.map((p) => p.id);
    const affectedTelegramIds = new Set(expiredPeers.map((p) => p.telegramId));

    try {
      await this.db
        .update(schema.peers)
        .set({ paused: true, pausedAt: new Date(), pausedReason: 'expired' })
        .where(inArray(schema.peers.id, ids));

      await this.tunnel.removePeers(expiredPeers.map((p) => p.publicKey));

      for (const peer of expiredPeers) {
        this.invalidatePeerCache(peer.name);
      }
      for (const telegramId of affectedTelegramIds) {
        this.cacheService.delete(CACHE_NAMESPACES.PEERS_BY_USER, telegramId);
      }
      this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);

      await this.syncXrayWithDb();

      this.logger.log(
        `Деактивировано по истечению срока: ${expiredPeers.length} конфигов`,
      );
      return expiredPeers.length;
    } catch (error) {
      this.logger.error(
        `Ошибка batch-деактивации истёкших конфигов: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  /**
   * Отправляет уведомления пользователям о том, что срок действия их конфига
   * истекает через указанное количество дней (по умолчанию — через 1 день).
   * Вызывается по расписанию.
   */
  async notifyExpiringPeers(daysBefore: number = 1): Promise<number> {
    if (daysBefore <= 0) {
      return 0;
    }

    const now = new Date();

    // Дата "через N дней" (начало дня по локальному времени)
    const targetDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + daysBefore,
      0,
      0,
      0,
      0,
    );

    // Конец целевого дня
    const targetDateEnd = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      targetDate.getDate(),
      23,
      59,
      59,
      999,
    );

    const peers = await this.db.query.peers.findMany({
      where: and(
        eq(schema.peers.paused, false),
        isNotNull(schema.peers.expiresAt),
        lte(schema.peers.expiresAt, targetDateEnd),
        sql`${schema.peers.expiresAt} >= ${targetDate.getTime()}`,
      ),
    });

    if (peers.length === 0) {
      return 0;
    }

    const title = 'Срок действия VPN-конфига скоро истечёт';
    const results = await Promise.all(
      peers.map(async (peer) => {
        try {
          const expiresAt = peer.expiresAt
            ? new Date(peer.expiresAt).toLocaleDateString('ru-RU')
            : 'скоро';
          const details = [
            `Ваш конфиг \`${peer.name}\` истекает через *${daysBefore} день*.`,
            ``,
            `📅 Дата окончания: *${expiresAt}*`,
            ``,
            `После истечения срока конфиг будет автоматически отключён.`,
            ``,
            `для того что бы продлить конфиг перейдите: @tunelvpnbot`,
          ].join('\n');
          const ok = await this.notificationService.notifyUser(
            peer.telegramId,
            title,
            details,
          );
          return ok;
        } catch (error) {
          this.logger.error(
            `Не удалось отправить уведомление о скором истечении конфига ${peer.name} пользователю ${peer.telegramId}: ${error instanceof Error ? error.message : error}`,
          );
          return false;
        }
      }),
    );
    const notifiedCount = results.filter(Boolean).length;

    this.logger.log(
      `Отправлено уведомлений о скором истечении срока действия конфигов (за ${daysBefore} дн.): ${notifiedCount} из ${peers.length}`,
    );

    return notifiedCount;
  }

  async deletePeersByRetentionPolicy(): Promise<number> {
    const now = Date.now();

    const pausedPeers = await this.db.query.peers.findMany({
      columns: {
        name: true,
        ip: true,
        telegramId: true,
        pausedAt: true,
        pausedReason: true,
        isTrial: true,
        expiresAt: true,
      },
      where: and(
        eq(schema.peers.paused, true),
        isNotNull(schema.peers.pausedAt),
      ),
    });

    const toDelete = pausedPeers.filter((peer) => {
      if (!peer.pausedAt) return false;

      const reason = this.resolvePausedReason(
        peer.pausedReason,
        peer.expiresAt,
      );
      const pausedDays = (now - peer.pausedAt.getTime()) / DAY_MS;

      if (reason === 'expired') {
        const retentionDays = peer.isTrial
          ? TRIAL_EXPIRED_DELETE_AFTER_DAYS
          : PAID_EXPIRED_DELETE_AFTER_DAYS;
        return pausedDays >= retentionDays;
      }

      // // [ВРЕМЕННО ОТКЛЮЧЕНО] Удаление бессрочных конфигов по причине неактивности
      // if (reason === 'inactive') {
      //   return pausedDays >= INACTIVE_PAUSED_DELETE_AFTER_DAYS;
      // }

      return pausedDays >= MANUAL_PAUSED_DELETE_AFTER_DAYS;
    });

    if (toDelete.length === 0) {
      return 0;
    }

    const names = toDelete.map((p) => p.name);
    try {
      await this.db
        .delete(schema.peers)
        .where(inArray(schema.peers.name, names));

      for (const p of toDelete) {
        this.removeIpFromCache(p.ip);
        this.invalidatePeerCache(p.name);
        this.cacheService.delete(CACHE_NAMESPACES.PEERS_BY_USER, p.telegramId);
      }
      this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);

      await this.syncXrayWithDb();

      this.logger.log(
        `Удалено конфигов по retention policy: ${toDelete.length}`,
      );
      return toDelete.length;
    } catch (error) {
      this.logger.error(
        `Ошибка batch-удаления конфигов по retention policy: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async deletePeersPausedOverMonth(): Promise<number> {
    return this.deletePeersByRetentionPolicy();
  }

  async refreshPeerTrafficStats(): Promise<number> {
    const runtimeStats = await this.tunnel.getPeerRuntimeStats();
    // Трафик VLESS учитывается наравне с туннельным: иначе у клиента,
    // который пользуется только вторым каналом, счётчики стоят на нуле,
    // и он попадает в «давно не используется» (handleInactiveActivePeers) при
    // живом конфиге.
    const xrayStats = await this.xrayService.getTrafficStats();

    if (runtimeStats.size === 0 && xrayStats.size === 0) {
      return 0;
    }

    const activePeers = await this.db.query.peers.findMany({
      columns: {
        name: true,
        publicKey: true,
        telegramId: true,
        rxBytes: true,
        txBytes: true,
        lastHandshakeAt: true,
      },
      where: eq(schema.peers.paused, false),
    });

    let updated = 0;
    const affectedTelegramIds = new Set<string>();

    for (const peer of activePeers) {
      const tunnelStats = runtimeStats.get(peer.publicKey);
      const vlessStats = xrayStats.get(peer.name);
      if (!tunnelStats && !vlessStats) continue;

      // Оба счётчика кумулятивные с момента старта своего процесса, поэтому
      // складываются напрямую — это две части трафика одного пира.
      const rxBytes = (tunnelStats?.rxBytes ?? 0) + (vlessStats?.downlink ?? 0);
      const txBytes = (tunnelStats?.txBytes ?? 0) + (vlessStats?.uplink ?? 0);

      const previousTotal = peer.rxBytes + peer.txBytes;
      const currentTotal = rxBytes + txBytes;
      const hasNewTraffic = currentTotal > previousTotal;
      const latestHandshakeAt = tunnelStats?.latestHandshakeAt ?? null;
      const hasNewHandshake =
        latestHandshakeAt &&
        (!peer.lastHandshakeAt ||
          latestHandshakeAt.getTime() > peer.lastHandshakeAt.getTime());

      await this.db
        .update(schema.peers)
        .set({
          rxBytes,
          txBytes,
          // Хендшейк бывает только у WireGuard — у VLESS аналога нет. Если
          // туннель по этому пиру ничего не сказал, поле не трогаем.
          lastHandshakeAt: tunnelStats ? latestHandshakeAt : undefined,
          lastTrafficAt:
            hasNewTraffic || hasNewHandshake ? new Date() : undefined,
          inactivityNotifiedAt:
            hasNewTraffic || hasNewHandshake ? null : undefined,
        })
        .where(eq(schema.peers.name, peer.name));

      this.invalidatePeerCache(peer.name);
      affectedTelegramIds.add(peer.telegramId);
      updated++;
    }

    for (const telegramId of affectedTelegramIds) {
      this.cacheService.delete(CACHE_NAMESPACES.PEERS_BY_USER, telegramId);
    }
    if (updated > 0) {
      this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);
    }

    this.logger.log(`Обновлена статистика трафика для ${updated} конфигов`);
    return updated;
  }

  async handleInactiveActivePeers(): Promise<{
    paidNotified: number;
    unlimitedNotified: number;
    unlimitedPaused: number;
  }> {
    const now = new Date();
    const activePeers = await this.db.query.peers.findMany({
      columns: {
        name: true,
        telegramId: true,
        publicKey: true,
        paused: true,
        expiresAt: true,
        createdAt: true,
        lastTrafficAt: true,
        inactivityNotifiedAt: true,
      },
      where: eq(schema.peers.paused, false),
    });

    let paidNotified = 0;
    const unlimitedNotified = 0;

    // // [ВРЕМЕННО ОТКЛЮЧЕНО] Паузa бессрочных конфигов за неактивность
    // const unlimitedToPause = activePeers.filter((peer) => {
    //   if (peer.expiresAt) return false;
    //   const inactiveDays = this.getInactiveDays(peer, now);
    //   return inactiveDays >= UNLIMITED_INACTIVITY_PAUSE_AFTER_DAYS;
    // });
    // const unlimitedToPauseNames = new Set(
    //   unlimitedToPause.map((peer) => peer.name),
    // );

    for (const peer of activePeers) {
      const inactiveDays = this.getInactiveDays(peer, now);
      if (peer.inactivityNotifiedAt) continue;

      if (
        peer.expiresAt &&
        peer.expiresAt > now &&
        inactiveDays >= ACTIVE_PAID_INACTIVITY_NOTIFY_AFTER_DAYS
      ) {
        const ok = await this.notificationService.notifyUser(
          peer.telegramId,
          'VPN-конфиг давно не используется',
          [
            `Ваш активный конфиг \`${peer.name}\` не показывает трафик около ${Math.floor(inactiveDays)} дн.`,
            '',
            'Мы не отключаем оплаченные активные конфиги до окончания срока, но стоит проверить подключение, если VPN нужен.',
          ].join('\n'),
        );
        if (ok) {
          await this.markInactivityNotified(peer.name);
          paidNotified++;
        }
      }
      // // [ВРЕМЕННО ОТКЛЮЧЕНО] Уведомление бессрочных об неактивности
      // else if (
      //   !peer.expiresAt &&
      //   inactiveDays >= UNLIMITED_INACTIVITY_NOTIFY_AFTER_DAYS
      // ) {
      //   const ok = await this.notificationService.notifyUser(
      //     peer.telegramId,
      //     'Бессрочный VPN-конфиг давно не используется',
      //     [
      //       `Ваш бессрочный конфиг \`${peer.name}\` не показывает трафик около ${Math.floor(inactiveDays)} дн.`,
      //       '',
      //       `Если трафик не появится, конфиг будет поставлен на паузу после ${UNLIMITED_INACTIVITY_PAUSE_AFTER_DAYS} дней неактивности.`,
      //     ].join('\n'),
      //   );
      //   if (ok) {
      //     await this.markInactivityNotified(peer.name);
      //     unlimitedNotified++;
      //   }
      // }
    }

    // // [ВРЕМЕННО ОТКЛЮЧЕНО] Постановка бессрочных на паузу за неактивность
    // let unlimitedPaused = 0;
    // if (unlimitedToPause.length > 0) {
    //   const names = unlimitedToPause.map((peer) => peer.name);
    //   const publicKeys = unlimitedToPause.map((peer) => peer.publicKey);
    //
    //   await this.db
    //     .update(schema.peers)
    //     .set({
    //       paused: true,
    //       pausedAt: new Date(),
    //       pausedReason: 'inactive',
    //     })
    //     .where(inArray(schema.peers.name, names));
    //
    //   await this.wgService.removePeers(publicKeys);
    //
    //   for (const peer of unlimitedToPause) {
    //     this.invalidatePeerCache(peer.name);
    //     this.cacheService.delete(
    //       CACHE_NAMESPACES.PEERS_BY_USER,
    //       peer.telegramId,
    //     );
    //   }
    //   this.cacheService.clear(CACHE_NAMESPACES.ALL_PEERS);
    //   unlimitedPaused = unlimitedToPause.length;
    // }

    return { paidNotified, unlimitedNotified, unlimitedPaused: 0 };
  }

  private resolvePausedReason(
    pausedReason: TPeerSelect['pausedReason'],
    expiresAt: Date | null,
  ): PeerPausedReason {
    if (pausedReason) return pausedReason;
    return expiresAt && expiresAt <= new Date() ? 'expired' : 'manual';
  }

  private getInactiveDays(
    peer: Pick<TPeerSelect, 'createdAt' | 'lastTrafficAt'>,
    now: Date,
  ): number {
    const activityBase = peer.lastTrafficAt ?? peer.createdAt ?? now;
    return (now.getTime() - activityBase.getTime()) / DAY_MS;
  }

  private async markInactivityNotified(peerName: string): Promise<void> {
    await this.db
      .update(schema.peers)
      .set({ inactivityNotifiedAt: new Date() })
      .where(eq(schema.peers.name, peerName));

    this.invalidatePeerCache(peerName);
  }

  isExpired(peer: TPeerSelect): boolean {
    if (!peer.expiresAt) return false;
    return new Date() > peer.expiresAt;
  }

  async updatePeerExpiration(
    peerName: string,
    expiresAt: Date | null,
  ): Promise<void> {
    const peer = await this.findPeer(peerName);

    await this.db
      .update(schema.peers)
      .set({ expiresAt })
      .where(eq(schema.peers.name, peerName));

    // Инвалидируем кеши
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

    // Если конфиг был на паузе из-за истечения срока, и мы продлили - включаем его
    if (peer.paused && expiresAt && expiresAt > new Date()) {
      await this.updatedPeer(peerName); // Это переключит статус
    }

    this.logger.log(
      `Обновлен срок действия конфига ${peerName}: ${expiresAt ? expiresAt.toISOString() : 'бессрочно'}`,
    );
  }

  /**
   * Продлевает срок действия конфига на указанное количество дней.
   * Если конфиг уже истёк — отсчёт от текущей даты, иначе — от даты истечения.
   */
  async extendPeerExpiration(
    peerName: string,
    durationDays: number,
  ): Promise<TPeerSelect> {
    const peer = await this.findPeer(peerName);
    const now = new Date();
    const base = peer.expiresAt && peer.expiresAt > now ? peer.expiresAt : now;
    const newExpiresAt = new Date(
      base.getTime() + durationDays * 24 * 60 * 60 * 1000,
    );
    await this.updatePeerExpiration(peerName, newExpiresAt);
    return this.findPeer(peerName);
  }

  async updatePeerDescription(
    peerName: string,
    description: string | null,
  ): Promise<void> {
    const peer = await this.findPeer(peerName);

    await this.db
      .update(schema.peers)
      .set({ description })
      .where(eq(schema.peers.name, peerName));

    // Инвалидируем кеши
    this.invalidatePeerCache(peerName);
    this.invalidateUserPeersCache(peer.telegramId);

    this.logger.log(
      `Обновлено описание конфига ${peerName}: ${description || '(удалено)'}`,
    );
  }

  /**
   * Проверяет, можно ли заменить конфиг (прошло ли 24 часа с последней замены)
   */
  /**
   * Заменяет конфиг: удаляет старый и создаёт новый с теми же параметрами (тариф, срок)
   * Можно заменять только раз в 24 часа
   */
  async replacePeer(
    peerName: string,
  ): Promise<{ peer: TPeerSelect; config: string }> {
    return await this.createPeerMutex.runExclusive(async () => {
      const oldPeer = await this.findPeer(peerName);

      // Сохраняем текущий срок действия (expiresAt) - это важно!
      const currentExpiresAt = oldPeer.expiresAt;

      const tunnel = this.tunnel;

      this.assertVpnAvailable();
      const awgEnabled = tunnel.isEnabled();

      // Генерируем новые ключи. Старый IP освобождаем: замена старого пира на
      // нового идёт одной записью конфига, поэтому переиспользовать адрес
      // безопасно — состояния с двумя пирами на одном IP не возникает.
      const usedIps = await this.getUsedIps();
      usedIps.delete(oldPeer.ip);

      const credentials = await tunnel.generateClientCredentials(usedIps);
      // Замена конфига обязана обесценить старые выданные доступы целиком:
      // без ротации vlessUuid старая VLESS-ссылка и URL подписки продолжали бы
      // работать, хотя WireGuard-ключи уже сменены.
      const newVlessUuid = randomUUID();

      // Обновляем запись в БД с новыми ключами, но сохраняем срок
      const [updatedPeer] = await this.db
        .update(schema.peers)
        .set({
          publicKey: credentials.publicKey,
          privateKey: credentials.privateKey,
          presharedKey: credentials.presharedKey,
          vlessUuid: newVlessUuid,
          ip: credentials.ip,
          endpoint: `${tunnel.host}:${tunnel.port}`,
          paused: false, // Активируем конфиг при замене
          pausedAt: null,
          pausedReason: null,
          expiresAt: currentExpiresAt, // Сохраняем тот же срок!
          lastReplacedAt: new Date(),
          lastTrafficAt: null,
          lastHandshakeAt: null,
          rxBytes: 0,
          txBytes: 0,
          inactivityNotifiedAt: null,
        })
        .where(eq(schema.peers.name, peerName))
        .returning();

      // Обновляем кеш IP
      this.removeIpFromCache(oldPeer.ip);
      this.addIpToCache(credentials.ip);

      // Инвалидируем кеши
      this.invalidatePeerCache(peerName);
      this.invalidateUserPeersCache(oldPeer.telegramId);

      // Заменяем пира в туннеле одной операцией: старый остаётся на месте до
      // самой записи конфига, поэтому сбой оставляет рабочим прежний конфиг,
      // а не выключает клиента до следующего старта приложения
      try {
        const config = awgEnabled
          ? await tunnel.replaceClientConfig(
              peerName,
              oldPeer.publicKey,
              credentials,
            )
          : '';

        // Старый uuid выкидывается из Xray, новый добавляется — одним вызовом.
        await this.syncXrayWithDb(!awgEnabled);

        this.logger.log(`Конфиг ${peerName} успешно заменён`);
        return { peer: updatedPeer, config };
      } catch (error) {
        // Если не удалось создать конфиг в туннеле, откатываем изменения
        this.logger.error(`Ошибка создания нового конфига в туннеле: ${error}`);
        await this.db
          .update(schema.peers)
          .set({
            publicKey: oldPeer.publicKey,
            privateKey: oldPeer.privateKey,
            presharedKey: oldPeer.presharedKey,
            vlessUuid: oldPeer.vlessUuid,
            ip: oldPeer.ip,
            endpoint: oldPeer.endpoint,
            paused: oldPeer.paused,
            pausedAt: oldPeer.pausedAt,
            pausedReason: oldPeer.pausedReason,
            lastReplacedAt: oldPeer.lastReplacedAt,
            lastTrafficAt: oldPeer.lastTrafficAt,
            lastHandshakeAt: oldPeer.lastHandshakeAt,
            rxBytes: oldPeer.rxBytes,
            txBytes: oldPeer.txBytes,
            inactivityNotifiedAt: oldPeer.inactivityNotifiedAt,
          })
          .where(eq(schema.peers.name, peerName));

        // Откатываем кеш IP
        this.removeIpFromCache(credentials.ip);
        this.addIpToCache(oldPeer.ip);

        // Инвалидируем кеши после отката
        this.invalidatePeerCache(peerName);
        this.invalidateUserPeersCache(oldPeer.telegramId);

        throw error;
      }
    });
  }

  /**
   * Генерирует строку конфига AmneziaWG для существующего пира
   */
  async getPeerConfigString(peerName: string): Promise<string> {
    const peer = await this.findPeer(peerName);

    // Сборка конфига живёт в туннеле: в [Interface] идут ещё и параметры
    // обфускации, а Endpoint туннель подставляет актуальный — peer.endpoint из
    // БД хранит лишь тот, что был на момент создания пира.
    return await this.tunnel.buildClientConfig({
      privateKey: peer.privateKey,
      presharedKey: peer.presharedKey,
      ip: peer.ip,
    });
  }

  /**
   * Генерирует QR-код для конфига пира (возвращает Buffer с PNG изображением)
   */
  async generatePeerQrCode(peerName: string): Promise<Buffer> {
    const config = await this.getPeerConfigString(peerName);

    // С I1..I5 (QUIC-имитация) конфиг занимает килобайты: при уровне M и 512 px
    // модули выходят меньше пикселя, и AmneziaVPN не распознаёт код. Уровень L
    // даёт запас по ёмкости, а размер считаем от числа модулей (≥ 8 px на модуль)
    const margin = 4;
    const { modules } = QRCode.create(config, { errorCorrectionLevel: 'L' });
    const width = Math.max(512, (modules.size + margin * 2) * 8);

    return QRCode.toBuffer(config, {
      type: 'png',
      width,
      margin,
      errorCorrectionLevel: 'L',
    });
  }

  /** vlessUuid есть у всех пиров (см. backfillVlessUuid) — но тип его допускает null. */
  private requireVlessUuid(peer: TPeerSelect): string {
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }
    return peer.vlessUuid;
  }

  /**
   * URL подписки. Отдаётся по тому же домену, что и CDN-канал: /sub на NestJS
   * проксирует reverse-proxy на хосте (см. README). Без домена подписку
   * публиковать негде — остаются только прямые vless://-ссылки, поэтому null.
   */
  private buildSubscriptionUrl(vlessUuid: string): string | null {
    const { domain, realityPort } = this.xrayService.getPublicParams();
    if (!domain) return null;

    const origin =
      realityPort === 443
        ? `https://${domain}`
        : `https://${domain}:${realityPort}`;
    return `${origin}/sub/${vlessUuid}`;
  }

  /**
   * Тот же /sub, но с полным конфигом (log+dns+inbounds) — для официальных
   * sing-box-клиентов (SFA/SFI/SFM): они, в отличие от Hiddify/NekoBox, не
   * достраивают TUN/DNS сами.
   */
  private buildFullSubscriptionUrl(vlessUuid: string): string | null {
    const url = this.buildSubscriptionUrl(vlessUuid);
    return url ? `${url}/full` : null;
  }

  async getPeerVlessText(peerName: string): Promise<string> {
    const peer = await this.findPeer(peerName);
    const vlessUuid = this.requireVlessUuid(peer);

    const subscriptionUrl = this.buildSubscriptionUrl(vlessUuid);
    const links = this.xrayService.buildShareLinks(peer.name, vlessUuid);
    const linksBlock = links.map((link) => `\`${link}\``).join('\n\n');

    if (!subscriptionUrl) {
      return (
        `🔗 *Ссылки для подключения* — добавьте в приложение любую:\n\n` +
        linksBlock
      );
    }

    return (
      `🔗 *Ссылка-подписка* — для приложений с поддержкой VLESS. ` +
      `Подключение через CDN (WebSocket + TLS):\n\`${subscriptionUrl}\`\n\n` +
      `*Если подписка не добавляется* — импортируйте ссылку VLESS:\n` +
      linksBlock
    );
  }

  async generatePeerVlessQrCode(peerName: string): Promise<Buffer> {
    const peer = await this.findPeer(peerName);
    const vlessUuid = this.requireVlessUuid(peer);

    const payload =
      this.buildSubscriptionUrl(vlessUuid) ??
      this.xrayService.buildShareLinks(peer.name, vlessUuid)[0];

    return QRCode.toBuffer(payload, {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  }

  /**
   * QR специально для официальных sing-box-клиентов (SFA/SFI/SFM). Их сканер
   * не распознаёт обычную https-ссылку как профиль (в отличие от Hiddify/
   * NekoBox/v2rayNG) — нужен deep-link их же схемы sing-box://import-remote-
   * profile с url/name в query. Ссылка внутри — на /full (с log/dns/inbounds),
   * т.к. именно её ждёт официальный клиент.
   */
  async generatePeerSingBoxQrCode(peerName: string): Promise<Buffer> {
    const peer = await this.findPeer(peerName);
    const fullSubscriptionUrl = this.buildFullSubscriptionUrl(
      this.requireVlessUuid(peer),
    );

    if (!fullSubscriptionUrl) {
      throw new InternalServerErrorException(
        'Подписка недоступна: не задан XRAY_DOMAIN',
      );
    }

    const deepLink = `sing-box://import-remote-profile?url=${encodeURIComponent(
      fullSubscriptionUrl,
    )}&name=${encodeURIComponent(peer.name)}`;

    return QRCode.toBuffer(deepLink, {
      type: 'png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  }

  /**
   * Получить статистику кеша (для мониторинга)
   */
  getCacheStats(): {
    usedIpsCache: number;
    usedIpsCacheAge: number | null;
    globalCache: Record<string, CacheStats> | CacheStats | null;
  } {
    return {
      usedIpsCache: this.usedIpsCache?.size ?? 0,
      usedIpsCacheAge: this.usedIpsCacheTime
        ? Date.now() - this.usedIpsCacheTime
        : null,
      globalCache: this.cacheService.getStats(),
    };
  }
}
