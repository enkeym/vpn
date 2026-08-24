import { randomUUID } from 'crypto';
import { integer, index } from 'drizzle-orm/sqlite-core';
import { text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';

export const familyMembers = sqliteTable(
  'family_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull().unique(),
    displayName: text('displayName'),
    addedBy: text('addedBy').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
  },
  (table) => [
    // Индекс для поиска по telegramId (часто используется в проверках доступа)
    index('family_telegram_id_idx').on(table.telegramId),
    // Индекс для поиска по addedBy (админ видит только своих участников)
    index('family_added_by_idx').on(table.addedBy),
  ],
);

export const blockedUsers = sqliteTable(
  'blocked_users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull().unique(),
    reason: text('reason'),
    blockedBy: text('blockedBy').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
  },
  (table) => [
    // Индекс для проверки блокировки (вызывается на каждый запрос)
    index('blocked_telegram_id_idx').on(table.telegramId),
  ],
);

/** Разовая акция: скидка на первое продление 60 или 90 дней (взаимоисключающая) */
export const userPromoUsage = sqliteTable(
  'user_promo_usage',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull().unique(),
    /** Использованный тариф со скидкой: 60 или 90 (после использования второй тариф без скидки) */
    usedDiscountTier: integer('usedDiscountTier').notNull(), // 60 | 90
    createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
  },
  (table) => [index('user_promo_telegram_idx').on(table.telegramId)],
);

/** Учёт выдачи пробного периода — переживает удаление peer'а (retention policy), поэтому триал не выдаётся повторно. */
export const userTrialUsage = sqliteTable(
  'user_trial_usage',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull().unique(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
  },
  (table) => [index('user_trial_telegram_idx').on(table.telegramId)],
);

/**
 * Автопродление подписки: сохранённый в ЮKassa метод оплаты и расписание списаний.
 * Строка появляется после первого успешного платежа картой (enabled = false),
 * само списание включается только кнопкой пользователя.
 */
export const userAutopay = sqliteTable(
  'user_autopay',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull().unique(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    /** id сохранённого метода оплаты в ЮKassa (без него автосписание невозможно) */
    paymentMethodId: text('paymentMethodId'),
    /** Человекочитаемое описание метода для UI («Банковская карта ···1234») */
    paymentMethodTitle: text('paymentMethodTitle'),
    /** Тариф автопродления (дни) */
    durationDays: integer('durationDays').notNull(),
    /** Конфиг, который продлевается списанием */
    peerName: text('peerName'),
    /** Момент следующего списания (за сутки до окончания подписки) */
    nextChargeAt: integer('nextChargeAt', { mode: 'timestamp' }),
    lastChargeAt: integer('lastChargeAt', { mode: 'timestamp' }),
    /** Когда предупредили о ближайшем списании (чтобы не дублировать) */
    warnNotifiedAt: integer('warnNotifiedAt', { mode: 'timestamp' }),
    lastError: text('lastError'),
    failedAttempts: integer('failedAttempts').notNull().default(0),
    createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    index('user_autopay_telegram_idx').on(table.telegramId),
    index('user_autopay_due_idx').on(table.enabled, table.nextChargeAt),
  ],
);

/** Runtime-настройки бота (оплата вкл/выкл, тестовая оплата) — переключаются из админ-панели без рестарта. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
});

export const peers = sqliteTable(
  'peers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull(),
    username: text('username'),
    configMessageId: integer('configMessageId'),
    qrMessageId: integer('qrMessageId'),
    fileMessageId: integer('fileMessageId'),
    name: text('name').notNull().unique(),
    description: text('description'),
    publicKey: text('publicKey').notNull(),
    privateKey: text('privateKey').notNull(),
    presharedKey: text('presharedKey'),
    /**
     * UUID клиента VLESS (Xray) — второй канал доступа рядом с AmneziaWG.
     * Nullable: конфиги, созданные до появления Xray, получают его бэкфиллом
     * в PeersService.backfillVlessUuid при старте. Он же служит токеном в URL
     * подписки (/sub/:uuid) — отдельный секрет не заводим.
     */
    vlessUuid: text('vlessUuid').unique(),
    ip: text('ip').notNull().unique(),
    endpoint: text('endpoint').notNull(),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    pausedAt: integer('pausedAt', { mode: 'timestamp' }),
    pausedReason: text('pausedReason', {
      enum: ['expired', 'manual', 'inactive'],
    }),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }),
    isTrial: integer('isTrial', { mode: 'boolean' }).notNull().default(false),
    lastReplacedAt: integer('lastReplacedAt', { mode: 'timestamp' }),
    lastTrafficAt: integer('lastTrafficAt', { mode: 'timestamp' }),
    lastHandshakeAt: integer('lastHandshakeAt', { mode: 'timestamp' }),
    rxBytes: integer('rxBytes').notNull().default(0),
    txBytes: integer('txBytes').notNull().default(0),
    inactivityNotifiedAt: integer('inactivityNotifiedAt', {
      mode: 'timestamp',
    }),
    createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    // Индекс для поиска конфигов пользователя (очень частый запрос)
    index('peers_telegram_id_idx').on(table.telegramId),
    // Индекс для поиска по имени конфига
    index('peers_name_idx').on(table.name),
    // Индекс для поиска по IP (используется при создании новых конфигов)
    index('peers_ip_idx').on(table.ip),
    // Индекс для поиска активных/неактивных конфигов
    index('peers_paused_idx').on(table.paused),
    // Составной индекс для поиска истекающих активных конфигов
    index('peers_expiration_idx').on(table.paused, table.expiresAt),
    index('peers_paused_reason_idx').on(table.paused, table.pausedReason),
    index('peers_activity_idx').on(table.paused, table.lastTrafficAt),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull(),
    yookassaId: text('yookassaId').notNull().unique(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('RUB'),
    status: text('status').notNull(), // 'pending', 'succeeded', 'canceled', 'waiting_for_capture'
    durationDays: integer('durationDays').notNull(),
    isPromo: integer('isPromo', { mode: 'boolean' }).notNull().default(false),
    /** Имя конфига для продления (null = новая покупка) */
    peerName: text('peerName'),
    /** Сохранённый/использованный метод оплаты ЮKassa */
    paymentMethodId: text('paymentMethodId'),
    /** Платёж создан автосписанием (без участия пользователя) */
    isAutoCharge: integer('isAutoCharge', { mode: 'boolean' })
      .notNull()
      .default(false),
    invoiceChatId: text('invoiceChatId'),
    invoiceMessageId: integer('invoiceMessageId'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    index('payments_telegram_id_idx').on(table.telegramId),
    index('payments_yookassa_id_idx').on(table.yookassaId),
    index('payments_status_idx').on(table.status),
  ],
);
