import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../database/database.module';
import { payments } from '../database/schema';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { and, desc, eq, ne, notInArray } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../database/schema';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly apiUrl = 'https://api.yookassa.ru/v3/payments';

  constructor(
    private readonly configService: ConfigService,
    @Inject(DRIZZLE)
    private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  private get authHeader() {
    const shopId = this.configService.get<string>('YOOKASSA_SHOP_ID');
    const secretKey = this.configService.get<string>('YOOKASSA_SECRET_KEY');
    return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
  }

  isTestPayment(): boolean {
    return this.configService.get<string>('TEST_PAYMENT') === 'true';
  }

  getBilledAmountRub(nominalRub: number): number {
    return this.isTestPayment() ? 1 : nominalRub;
  }

  async createPayment(
    telegramId: string,
    amount: number,
    durationDays: number,
    isPromo = false,
    peerName?: string,
  ) {
    const chargeRub = this.getBilledAmountRub(amount);
    if (this.isTestPayment() && chargeRub !== amount) {
      this.logger.warn(
        `TEST_PAYMENT: тариф ${amount} ₽ → списание ${chargeRub} ₽ (ЮKassa + БД)`,
      );
    }

    const idempotenceKey = randomUUID();
    const metadata: Record<string, string> = {
      telegramId,
      durationDays: String(durationDays),
      isPromo: String(isPromo),
    };
    if (peerName) metadata.peerName = peerName;

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          amount: { value: chargeRub.toFixed(2), currency: 'RUB' },
          capture: true,
          confirmation: {
            type: 'redirect',
            return_url: `https://t.me/${this.configService.get('TELEGRAM_BOT_USERNAME') || 'bot'}`,
          },
          description: peerName
            ? `Продление VPN TUNEL на ${durationDays} дней`
            : `Оплата VPN TUNEL на ${durationDays} дней`,
          metadata,
        },
        {
          headers: {
            'Idempotence-Key': idempotenceKey,
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
        },
      );

      const paymentData = response.data;

      // Сохраняем в БД со статусом pending
      await this.db.insert(payments).values({
        telegramId,
        yookassaId: paymentData.id,
        amount: Math.round(chargeRub),
        status: paymentData.status,
        durationDays,
        isPromo,
        peerName: peerName ?? null,
      });

      return paymentData;
    } catch (error) {
      this.logger.error('Error creating YuKassa payment', error);
      throw error;
    }
  }

  async getPaymentByYookassaId(yookassaId: string) {
    const results = await this.db
      .select()
      .from(payments)
      .where(eq(payments.yookassaId, yookassaId))
      .limit(1);
    return results[0];
  }

  async getPaymentStatusFromYooKassa(
    yookassaId: string,
  ): Promise<string | null> {
    try {
      const response = await axios.get(`${this.apiUrl}/${yookassaId}`, {
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
      });
      return response.data?.status ?? null;
    } catch (error) {
      this.logger.error(
        `Ошибка проверки статуса платежа ${yookassaId} в ЮKassa: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async updatePaymentStatus(yookassaId: string, status: string) {
    await this.db
      .update(payments)
      .set({ status })
      .where(eq(payments.yookassaId, yookassaId));
  }

  /** Привязать inline-сообщение со счётом (для замены текста после оплаты) */
  async setInvoiceUiAnchor(
    yookassaId: string,
    chatId: string,
    messageId: number,
  ): Promise<void> {
    await this.db
      .update(payments)
      .set({ invoiceChatId: chatId, invoiceMessageId: messageId })
      .where(eq(payments.yookassaId, yookassaId));
  }

  async tryClaimPaymentSucceeded(
    yookassaId: string,
  ): Promise<typeof payments.$inferSelect | null> {
    const rows = await this.db
      .update(payments)
      .set({ status: 'succeeded' })
      .where(
        and(
          eq(payments.yookassaId, yookassaId),
          ne(payments.status, 'succeeded'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async listRecentUnsettledPayments(telegramId: string, limit = 5) {
    return this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.telegramId, telegramId),
          notInArray(payments.status, ['succeeded', 'canceled']),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(limit);
  }
}
