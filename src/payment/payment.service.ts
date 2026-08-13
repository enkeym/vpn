import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../database/database.module';
import { payments } from '../database/schema';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { and, desc, eq, ne, notInArray } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../database/schema';
import { SettingsService } from 'src/settings/settings.service';

/** Payload deep link `t.me/bot?start=…` в return_url ЮKassa — по нему бот принудительно синхронизирует платежи. */
export const YOOKASSA_TELEGRAM_RETURN_START_PARAM = 'syncpay';

/** Платёж в ЮKassa в том виде, в котором он нужен боту */
export interface IYooKassaPaymentView {
  status: string | null;
  /** id сохранённого метода оплаты — есть только при payment_method.saved */
  savedPaymentMethodId: string | null;
  paymentMethodTitle: string | null;
}

interface IYooKassaPaymentResponse {
  id?: unknown;
  status?: unknown;
  payment_method?: {
    id?: unknown;
    saved?: unknown;
    title?: unknown;
    type?: unknown;
  };
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly apiUrl = 'https://api.yookassa.ru/v3/payments';
  private readonly adminIds: string[];

  constructor(
    private readonly configService: ConfigService,
    @Inject(DRIZZLE)
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly settingsService: SettingsService,
  ) {
    this.adminIds = (
      this.configService.get<string>('TELEGRAM_ALLOWED_IDS') ?? ''
    )
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }

  private get authHeader() {
    const shopId = this.configService.get<string>('YOOKASSA_SHOP_ID');
    const secretKey = this.configService.get<string>('YOOKASSA_SECRET_KEY');
    return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
  }

  /** Приём оплаты включён/выключен из админ-панели («Параметры»), применяется мгновенно. */
  isPaymentEnabled(): Promise<boolean> {
    return this.settingsService.isPaymentEnabled();
  }

  setPaymentEnabled(value: boolean): Promise<void> {
    return this.settingsService.setPaymentEnabled(value);
  }

  /** Глобальный флаг тестовой оплаты из «Параметров» (влияет только на админов) */
  isTestPayment(): Promise<boolean> {
    return this.settingsService.isTestPayment();
  }

  setTestPayment(value: boolean): Promise<void> {
    return this.settingsService.setTestPayment(value);
  }

  isAdmin(telegramId: string): boolean {
    return this.adminIds.includes(String(telegramId));
  }

  /**
   * Тестовая цена действует только для админов: клиентские продажи идут
   * по полным ценам даже при включённом тестовом режиме.
   */
  async isTestPaymentFor(telegramId: string): Promise<boolean> {
    if (!this.isAdmin(telegramId)) return false;
    return this.settingsService.isTestPayment();
  }

  /** Сумма к списанию: номинал тарифа либо 1 ₽ в тестовом режиме админа */
  async getBilledAmountRub(
    nominalRub: number,
    telegramId: string,
  ): Promise<number> {
    return (await this.isTestPaymentFor(telegramId)) ? 1 : nominalRub;
  }

  /**
   * Объект чека для ЮKassa (54-ФЗ / 422-ФЗ для самозанятого). Без чека платёж
   * самозанятого не фискализируется. Контакт покупателя берётся из
   * RECEIPT_CUSTOMER_EMAIL (пока не собираем личный email клиента — чек
   * регистрируется в ФНС и хранится на служебном контакте продавца).
   * vat_code=1 — «без НДС»: самозанятый на НПД НДС не платит.
   *
   * Возвращает undefined, если контакт не настроен — тогда receipt не
   * прикладывается (иначе ЮKassa отклонит платёж с неполным чеком). Настройка
   * автофискализации самозанятого в ЛК ЮKassa — обязательна, см. docs/legal.
   */
  private buildReceipt(
    amountRub: number,
    description: string,
  ):
    | {
        customer: { email: string };
        items: Array<{
          description: string;
          quantity: string;
          amount: { value: string; currency: 'RUB' };
          vat_code: number;
          payment_subject: 'service';
          payment_mode: 'full_payment';
        }>;
      }
    | undefined {
    const email = this.configService
      .get<string>('RECEIPT_CUSTOMER_EMAIL')
      ?.trim();
    if (!email) {
      this.logger.warn(
        'RECEIPT_CUSTOMER_EMAIL не задан — чек (54-ФЗ/НПД) не будет сформирован. Настройте контакт и автофискализацию самозанятого в ЮKassa.',
      );
      return undefined;
    }
    return {
      customer: { email },
      items: [
        {
          // Наименование услуги в чеке — не более 128 символов
          description: description.slice(0, 128),
          quantity: '1',
          amount: { value: amountRub.toFixed(2), currency: 'RUB' },
          vat_code: 1,
          payment_subject: 'service',
          payment_mode: 'full_payment',
        },
      ],
    };
  }

  getYookassaReturnUrl(): string {
    const raw =
      this.configService.get<string>('TELEGRAM_BOT_USERNAME')?.trim() || 'bot';
    const user = raw.replace(/^@/, '') || 'bot';
    return `https://t.me/${user}?start=${YOOKASSA_TELEGRAM_RETURN_START_PARAM}`;
  }

  /**
   * Счёт ЮKassa с подтверждением от пользователя.
   *
   * `save_payment_method: true` просит ЮKassa сохранить метод оплаты — без этого
   * флага в момент платежа автопродление позже включить нельзя. Само списание
   * остаётся выключенным, пока пользователь не включит его кнопкой.
   */
  async createPayment(
    telegramId: string,
    amount: number,
    durationDays: number,
    isPromo = false,
    peerName?: string,
  ) {
    const chargeRub = await this.getBilledAmountRub(amount, telegramId);
    if (chargeRub !== amount) {
      this.logger.warn(
        `TEST_PAYMENT (админ ${telegramId}): тариф ${amount} ₽ → списание ${chargeRub} ₽ (ЮKassa + БД)`,
      );
    }

    const idempotenceKey = randomUUID();
    const metadata: Record<string, string> = {
      telegramId,
      durationDays: String(durationDays),
      isPromo: String(isPromo),
    };
    if (peerName) metadata.peerName = peerName;

    const description = peerName
      ? `Продление VPN TUNEL на ${durationDays} дней`
      : `Оплата VPN TUNEL на ${durationDays} дней`;
    const receipt = this.buildReceipt(chargeRub, description);

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          amount: { value: chargeRub.toFixed(2), currency: 'RUB' },
          capture: true,
          save_payment_method: true,
          confirmation: {
            type: 'redirect',
            return_url: this.getYookassaReturnUrl(),
          },
          description,
          ...(receipt ? { receipt } : {}),
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

  /**
   * Автосписание по ранее сохранённому методу оплаты: без confirmation,
   * без участия пользователя. Строка в payments помечается isAutoCharge.
   */
  async createAutoChargePayment(params: {
    telegramId: string;
    amount: number;
    durationDays: number;
    peerName: string;
    paymentMethodId: string;
  }): Promise<IYooKassaPaymentResponse> {
    const { telegramId, amount, durationDays, peerName, paymentMethodId } =
      params;
    const chargeRub = await this.getBilledAmountRub(amount, telegramId);
    const idempotenceKey = randomUUID();

    const description = `Автопродление VPN TUNEL на ${durationDays} дней`;
    const receipt = this.buildReceipt(chargeRub, description);

    const response = await axios.post<IYooKassaPaymentResponse>(
      this.apiUrl,
      {
        amount: { value: chargeRub.toFixed(2), currency: 'RUB' },
        capture: true,
        payment_method_id: paymentMethodId,
        description,
        ...(receipt ? { receipt } : {}),
        metadata: {
          telegramId,
          durationDays: String(durationDays),
          isPromo: 'false',
          peerName,
          autoCharge: 'true',
        },
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
    const yookassaId = typeof paymentData.id === 'string' ? paymentData.id : '';
    if (!yookassaId) {
      throw new Error('ЮKassa не вернула id платежа автосписания');
    }

    // Строка всегда создаётся как pending: успех фиксирует только
    // tryClaimPaymentSucceeded в момент выдачи — иначе выдача сочтёт платёж
    // уже обработанным и конфиг не продлится.
    await this.db.insert(payments).values({
      telegramId,
      yookassaId,
      amount: Math.round(chargeRub),
      status: 'pending',
      durationDays,
      isPromo: false,
      peerName,
      paymentMethodId,
      isAutoCharge: true,
    });

    return paymentData;
  }

  /** Платёж из ЮKassa: статус и сохранённый метод оплаты (null при ошибке запроса) */
  async getYooKassaPayment(
    yookassaId: string,
  ): Promise<IYooKassaPaymentView | null> {
    try {
      const response = await axios.get<IYooKassaPaymentResponse>(
        `${this.apiUrl}/${yookassaId}`,
        {
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
        },
      );
      const data = response.data;
      const method = data.payment_method;
      const savedPaymentMethodId =
        method?.saved === true && typeof method.id === 'string'
          ? method.id
          : null;
      return {
        status: typeof data.status === 'string' ? data.status : null,
        savedPaymentMethodId,
        paymentMethodTitle:
          typeof method?.title === 'string' ? method.title : null,
      };
    } catch (error) {
      this.logger.error(
        `Ошибка запроса платежа ${yookassaId} в ЮKassa: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async getPaymentStatusFromYooKassa(
    yookassaId: string,
  ): Promise<string | null> {
    const payment = await this.getYooKassaPayment(yookassaId);
    return payment?.status ?? null;
  }

  /** Запомнить метод оплаты, привязанный к платежу */
  async setPaymentMethodId(
    yookassaId: string,
    paymentMethodId: string,
  ): Promise<void> {
    await this.db
      .update(payments)
      .set({ paymentMethodId })
      .where(eq(payments.yookassaId, yookassaId));
  }

  async updatePaymentStatus(yookassaId: string, status: string) {
    await this.db
      .update(payments)
      .set({ status })
      .where(eq(payments.yookassaId, yookassaId));
  }

  /**
   * Пометить платёж отменённым, не затрагивая уже succeeded-строку. Guard в SQL
   * (`ne(status,'succeeded')`) защищает от порчи состояния поздним webhook'ом
   * `payment.canceled`, пришедшим после успешной выдачи конфига.
   */
  async markCanceledIfNotSucceeded(yookassaId: string): Promise<void> {
    await this.db
      .update(payments)
      .set({ status: 'canceled' })
      .where(
        and(
          eq(payments.yookassaId, yookassaId),
          ne(payments.status, 'succeeded'),
        ),
      );
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
