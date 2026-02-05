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

export const peers = sqliteTable(
  'peers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    telegramId: text('telegramId').notNull(),
    username: text('username'),
    configMessageId: integer('configMessageId'),
    name: text('name').notNull().unique(),
    description: text('description'),
    publicKey: text('publicKey').notNull(),
    privateKey: text('privateKey').notNull(),
    presharedKey: text('presharedKey'),
    ip: text('ip').notNull().unique(),
    endpoint: text('endpoint').notNull(),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }),
    lastReplacedAt: integer('lastReplacedAt', { mode: 'timestamp' }),
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
  ],
);
