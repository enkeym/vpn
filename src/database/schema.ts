import { randomUUID } from 'crypto';
import { integer } from 'drizzle-orm/sqlite-core';
import { text } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';

export const familyMembers = sqliteTable('family_members', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  telegramId: text('telegramId').notNull().unique(),
  displayName: text('displayName'),
  addedBy: text('addedBy').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
});

export const peers = sqliteTable('peers', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  telegramId: text('telegramId').notNull(),
  username: text('username'),
  configMessageId: integer('configMessageId'),
  name: text('name').notNull().unique(),
  publicKey: text('publicKey').notNull(),
  privateKey: text('privateKey').notNull(),
  presharedKey: text('presharedKey'),
  ip: text('ip').notNull().unique(),
  endpoint: text('endpoint').notNull(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }),
  createdAt: integer('createdAt', { mode: 'timestamp' }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
});
