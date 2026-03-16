import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../database/database.module';
import { payments } from '../database/schema';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
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

  async createPayment(
    telegramId: string,
    amount: number,
    durationDays: number,
    isPromo = false,
    peerName?: string,
  ) {
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
          amount: { value: amount.toFixed(2), currency: 'RUB' },
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
        amount: Math.round(amount),
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

  /**
   * Получить статус платежа из API ЮKassa (для верификации вебхука)
   */
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
}
