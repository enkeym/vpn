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
    // WireGuard/AmneziaWG упразднён — поля остаются nullable ради обратной
    // совместимости со старыми записями, новые пиры их не заполняют.
    publicKey: text('publicKey'),
    privateKey: text('privateKey'),
    presharedKey: text('presharedKey'),
    // VLESS UUID для Xray. Nullable — старые WG-пиры получают его бэкфиллом
    // в PeersService.syncXrayWithDb при старте.
    vlessUuid: text('vlessUuid').unique(),
    // Hysteria2 упразднена — поле остаётся nullable ради обратной совместимости
    // со старыми записями, новые пиры его не заполняют (как publicKey/privateKey от WG).
    hysteriaPassword: text('hysteriaPassword').unique(),
    ip: text('ip').unique(),
    endpoint: text('endpoint'),
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

/**
 * Срабатывания лимита устройств. Блокировка не применяется — только запись
 * факта и уведомление владельцу, чтобы сначала оценить долю ложных
 * срабатываний на живых пользователях (см. DeviceLimitService).
 */
export const peerDeviceAlerts = sqliteTable(
  'peer_device_alerts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    peerName: text('peerName').notNull(),
    /** Сколько одновременных IP насчитали в момент срабатывания. */
    deviceCount: integer('deviceCount').notNull(),
    /** Список IP через запятую — чтобы разбирать обращения в поддержку. */
    ips: text('ips').notNull(),
    notifiedAt: integer('notifiedAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
  },
  (table) => [
    index('peer_device_alerts_peer_idx').on(table.peerName),
    index('peer_device_alerts_notified_idx').on(table.notifiedAt),
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
