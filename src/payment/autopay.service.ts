import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { userAutopay } from '../database/schema';
import { PeersService } from '../peers/peers.service';
import { BotService } from '../bot/bot.service';
import { PaymentService } from './payment.service';
import { PaymentFulfillmentService } from './payment-fulfillment.service';
import { getPlanPrice, isPaidDuration, type PaidDuration } from './pricing';

export type TAutopay = typeof userAutopay.$inferSelect;

export type AutopayEnableResult =
  | 'enabled'
  | 'no_payment_method'
  | 'no_peer'
  | 'unlimited_peer';

/**
 * Автопродление подписки рекуррентными платежами ЮKassa.
 *
 * Метод оплаты сохраняется при обычном платеже (`save_payment_method`), но само
 * списание остаётся выключенным, пока пользователь не включит его кнопкой.
 * Списание идёт за сутки до окончания срока конфига, чтобы VPN не отключался.
 */
@Injectable()
export class AutopayService {
  private readonly logger = new Logger(AutopayService.name);

  /** За сколько до окончания подписки списываем */
  private static readonly CHARGE_LEAD_MS = 24 * 60 * 60 * 1000;
  /** За сколько до списания предупреждаем пользователя */
  private static readonly WARN_LEAD_MS = 3 * 24 * 60 * 60 * 1000;
  /** После стольких неудачных списаний автопродление отключается */
  private static readonly MAX_FAILED_ATTEMPTS = 3;
  /** Пауза между повторными попытками списания */
  private static readonly RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

  constructor(
    @Inject(DRIZZLE)
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly paymentService: PaymentService,
    private readonly peersService: PeersService,
    @Inject(forwardRef(() => PaymentFulfillmentService))
    private readonly paymentFulfillment: PaymentFulfillmentService,
    @Inject(forwardRef(() => BotService))
    private readonly botService: BotService,
  ) {}

  async getState(telegramId: string): Promise<TAutopay | null> {
    const row = await this.db.query.userAutopay.findFirst({
      where: eq(userAutopay.telegramId, String(telegramId)),
    });
    return row ?? null;
  }

  /** Тариф автопродления: сохранённый в состоянии либо переданный, с фолбэком на 30 дней */
  private resolveDuration(value: number | undefined | null): PaidDuration {
    if (value != null && isPaidDuration(value)) return value;
    return 30;
  }

  /**
   * Запомнить метод оплаты после успешного платежа картой.
   * Автосписание при этом не включается — только становится доступным.
   */
  async rememberPaymentMethod(params: {
    telegramId: string;
    paymentMethodId: string;
    paymentMethodTitle: string | null;
    durationDays: number;
    peerName: string | null;
  }): Promise<void> {
    const telegramId = String(params.telegramId);
    const durationDays = this.resolveDuration(params.durationDays);
    const existing = await this.getState(telegramId);

    if (!existing) {
      await this.db.insert(userAutopay).values({
        telegramId,
        enabled: false,
        paymentMethodId: params.paymentMethodId,
        paymentMethodTitle: params.paymentMethodTitle,
        durationDays,
        peerName: params.peerName,
      });
      return;
    }

    await this.db
      .update(userAutopay)
      .set({
        paymentMethodId: params.paymentMethodId,
        paymentMethodTitle: params.paymentMethodTitle,
        // тариф и конфиг обновляем по последней покупке — автопродление идёт по ней
        durationDays,
        peerName: params.peerName ?? existing.peerName,
        failedAttempts: 0,
        lastError: null,
      })
      .where(eq(userAutopay.telegramId, telegramId));
  }

  /** Конфиг для автопродления: указанный явно либо самый «долгий» срочный конфиг пользователя */
  private async resolveTargetPeer(
    telegramId: string,
    preferredPeerName: string | null,
  ): Promise<{ name: string; expiresAt: Date } | 'no_peer' | 'unlimited_peer'> {
    const peers = await this.peersService.getPeersByTelegramId(telegramId);
    if (peers.length === 0) return 'no_peer';

    const preferred = preferredPeerName
      ? peers.find((p) => p.name === preferredPeerName)
      : undefined;
    const candidate =
      preferred ??
      peers
        .filter((p) => p.expiresAt != null)
        .sort(
          (a, b) =>
            (b.expiresAt as Date).getTime() - (a.expiresAt as Date).getTime(),
        )[0];

    if (!candidate) return 'unlimited_peer';
    if (!candidate.expiresAt) return 'unlimited_peer';

    return { name: candidate.name, expiresAt: candidate.expiresAt };
  }

  private chargeDateFor(expiresAt: Date): Date {
    return new Date(expiresAt.getTime() - AutopayService.CHARGE_LEAD_MS);
  }

  async enable(
    telegramId: string,
    options?: { durationDays?: number; peerName?: string },
  ): Promise<AutopayEnableResult> {
    const id = String(telegramId);
    const state = await this.getState(id);
    if (!state?.paymentMethodId) return 'no_payment_method';

    const target = await this.resolveTargetPeer(
      id,
      options?.peerName ?? state.peerName,
    );
    if (target === 'no_peer' || target === 'unlimited_peer') return target;

    const durationDays = this.resolveDuration(
      options?.durationDays ?? state.durationDays,
    );

    await this.db
      .update(userAutopay)
      .set({
        enabled: true,
        durationDays,
        peerName: target.name,
        nextChargeAt: this.chargeDateFor(target.expiresAt),
        warnNotifiedAt: null,
        failedAttempts: 0,
        lastError: null,
      })
      .where(eq(userAutopay.telegramId, id));

    this.logger.log(
      `Автопродление включено: user=${id}, конфиг=${target.name}, тариф=${durationDays} дн.`,
    );
    return 'enabled';
  }

  async disable(telegramId: string): Promise<void> {
    const id = String(telegramId);
    await this.db
      .update(userAutopay)
      .set({ enabled: false, nextChargeAt: null, warnNotifiedAt: null })
      .where(eq(userAutopay.telegramId, id));
    this.logger.log(`Автопродление выключено: user=${id}`);
  }

  /** Ежечасно: предупреждения о ближайшем списании и сами списания */
  @Cron(CronExpression.EVERY_HOUR)
  async processDueCharges(): Promise<void> {
    const rows = await this.db
      .select()
      .from(userAutopay)
      .where(
        and(
          eq(userAutopay.enabled, true),
          isNotNull(userAutopay.paymentMethodId),
        ),
      );
    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        await this.processOne(row);
      } catch (error) {
        this.logger.error(
          `Автопродление ${row.telegramId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  private async processOne(row: TAutopay): Promise<void> {
    const target = await this.resolveTargetPeer(row.telegramId, row.peerName);

    if (target === 'no_peer') {
      await this.disable(row.telegramId);
      this.logger.warn(
        `Автопродление отключено: у ${row.telegramId} не осталось конфигов`,
      );
      return;
    }
    if (target === 'unlimited_peer') {
      await this.disable(row.telegramId);
      return;
    }

    // Срок конфига мог измениться (ручное продление) — держим дату списания в актуальном состоянии
    const chargeAt = this.chargeDateFor(target.expiresAt);
    if (
      row.nextChargeAt == null ||
      row.nextChargeAt.getTime() !== chargeAt.getTime() ||
      row.peerName !== target.name
    ) {
      await this.db
        .update(userAutopay)
        .set({
          nextChargeAt: chargeAt,
          peerName: target.name,
          warnNotifiedAt:
            row.nextChargeAt != null &&
            row.nextChargeAt.getTime() !== chargeAt.getTime()
              ? null
              : row.warnNotifiedAt,
        })
        .where(eq(userAutopay.telegramId, row.telegramId));
    }

    const now = Date.now();
    if (now >= chargeAt.getTime()) {
      await this.charge(row, target.name);
      return;
    }

    const warnFrom = chargeAt.getTime() - AutopayService.WARN_LEAD_MS;
    const alreadyWarned =
      row.warnNotifiedAt != null &&
      row.warnNotifiedAt.getTime() >= warnFrom &&
      row.nextChargeAt != null &&
      row.nextChargeAt.getTime() === chargeAt.getTime();

    if (now >= warnFrom && !alreadyWarned) {
      const durationDays = this.resolveDuration(row.durationDays);
      const amount = await this.paymentService.getBilledAmountRub(
        getPlanPrice(durationDays),
        row.telegramId,
      );
      await this.botService.notifyAutopayChargeSoon(
        row.telegramId,
        target.name,
        durationDays,
        amount,
        chargeAt,
      );
      await this.db
        .update(userAutopay)
        .set({ warnNotifiedAt: new Date() })
        .where(eq(userAutopay.telegramId, row.telegramId));
    }
  }

  /** Списание по сохранённому методу и выдача продлённого конфига */
  private async charge(row: TAutopay, peerName: string): Promise<void> {
    const paymentMethodId = row.paymentMethodId;
    if (!paymentMethodId) {
      await this.disable(row.telegramId);
      return;
    }

    const durationDays = this.resolveDuration(row.durationDays);
    const nominalPrice = getPlanPrice(durationDays);
    const billedAmount = await this.paymentService.getBilledAmountRub(
      nominalPrice,
      row.telegramId,
    );

    // Незакрытое автосписание уже есть — добираем его результат, нового счёта не создаём
    const unsettled = await this.paymentService.listRecentUnsettledPayments(
      row.telegramId,
      5,
    );
    const pendingAuto = unsettled.find((p) => p.isAutoCharge);
    if (pendingAuto) {
      await this.paymentFulfillment.fulfillByYookassaId(
        pendingAuto.yookassaId,
        row.telegramId,
        { trustYooKassaSucceeded: false },
      );
      await this.refreshAfterCharge(row.telegramId, peerName);
      return;
    }

    try {
      const payment = await this.paymentService.createAutoChargePayment({
        telegramId: row.telegramId,
        amount: nominalPrice,
        durationDays,
        peerName,
        paymentMethodId,
      });

      const status = typeof payment.status === 'string' ? payment.status : '';
      const yookassaId = typeof payment.id === 'string' ? payment.id : '';

      if (status === 'succeeded' && yookassaId) {
        await this.paymentFulfillment.fulfillByYookassaId(
          yookassaId,
          row.telegramId,
          { trustYooKassaSucceeded: true },
        );
        await this.refreshAfterCharge(row.telegramId, peerName);
        this.logger.log(
          `Автопродление списано: user=${row.telegramId}, ${billedAmount} ₽, ${durationDays} дн.`,
        );
        return;
      }

      if (status === 'pending' || status === 'waiting_for_capture') {
        // Итог доберут вебхук или следующий проход — состояние не трогаем
        this.logger.log(
          `Автопродление ${row.telegramId}: платёж ${yookassaId} в статусе ${status}`,
        );
        return;
      }

      await this.registerFailure(
        row,
        billedAmount,
        `Статус платежа: ${status || 'неизвестен'}`,
      );
    } catch (error) {
      await this.registerFailure(
        row,
        billedAmount,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** После успешного списания — пересчёт даты следующего и сброс счётчика ошибок */
  private async refreshAfterCharge(
    telegramId: string,
    peerName: string,
  ): Promise<void> {
    const target = await this.resolveTargetPeer(telegramId, peerName);
    const nextChargeAt =
      target === 'no_peer' || target === 'unlimited_peer'
        ? null
        : this.chargeDateFor(target.expiresAt);

    await this.db
      .update(userAutopay)
      .set({
        nextChargeAt,
        lastChargeAt: new Date(),
        warnNotifiedAt: null,
        failedAttempts: 0,
        lastError: null,
      })
      .where(eq(userAutopay.telegramId, String(telegramId)));
  }

  private async registerFailure(
    row: TAutopay,
    amount: number,
    reason: string,
  ): Promise<void> {
    const failedAttempts = row.failedAttempts + 1;
    const exhausted = failedAttempts >= AutopayService.MAX_FAILED_ATTEMPTS;

    await this.db
      .update(userAutopay)
      .set({
        failedAttempts,
        lastError: reason.slice(0, 500),
        enabled: !exhausted,
        nextChargeAt: exhausted
          ? null
          : new Date(Date.now() + AutopayService.RETRY_DELAY_MS),
      })
      .where(eq(userAutopay.telegramId, row.telegramId));

    this.logger.warn(
      `Автосписание не прошло (${failedAttempts}/${AutopayService.MAX_FAILED_ATTEMPTS}) для ${row.telegramId}: ${reason}`,
    );

    await this.botService.notifyAutopayChargeFailed(
      row.telegramId,
      amount,
      exhausted ? 0 : AutopayService.MAX_FAILED_ATTEMPTS - failedAttempts,
    );
  }
}
