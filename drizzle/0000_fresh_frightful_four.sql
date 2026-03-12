CREATE TABLE `blocked_users` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`reason` text,
	`blockedBy` text NOT NULL,
	`createdAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_users_telegramId_unique` ON `blocked_users` (`telegramId`);--> statement-breakpoint
CREATE INDEX `blocked_telegram_id_idx` ON `blocked_users` (`telegramId`);--> statement-breakpoint
CREATE TABLE `family_members` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`displayName` text,
	`addedBy` text NOT NULL,
	`createdAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `family_members_telegramId_unique` ON `family_members` (`telegramId`);--> statement-breakpoint
CREATE INDEX `family_telegram_id_idx` ON `family_members` (`telegramId`);--> statement-breakpoint
CREATE INDEX `family_added_by_idx` ON `family_members` (`addedBy`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`yookassaId` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'RUB' NOT NULL,
	`status` text NOT NULL,
	`durationDays` integer NOT NULL,
	`isPromo` integer DEFAULT false NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_yookassaId_unique` ON `payments` (`yookassaId`);--> statement-breakpoint
CREATE INDEX `payments_telegram_id_idx` ON `payments` (`telegramId`);--> statement-breakpoint
CREATE INDEX `payments_yookassa_id_idx` ON `payments` (`yookassaId`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`);--> statement-breakpoint
CREATE TABLE `peers` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`username` text,
	`configMessageId` integer,
	`qrMessageId` integer,
	`fileMessageId` integer,
	`name` text NOT NULL,
	`description` text,
	`publicKey` text NOT NULL,
	`privateKey` text NOT NULL,
	`presharedKey` text,
	`ip` text NOT NULL,
	`endpoint` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`pausedAt` integer,
	`expiresAt` integer,
	`isTrial` integer DEFAULT false NOT NULL,
	`lastReplacedAt` integer,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peers_name_unique` ON `peers` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `peers_ip_unique` ON `peers` (`ip`);--> statement-breakpoint
CREATE INDEX `peers_telegram_id_idx` ON `peers` (`telegramId`);--> statement-breakpoint
CREATE INDEX `peers_name_idx` ON `peers` (`name`);--> statement-breakpoint
CREATE INDEX `peers_ip_idx` ON `peers` (`ip`);--> statement-breakpoint
CREATE INDEX `peers_paused_idx` ON `peers` (`paused`);--> statement-breakpoint
CREATE INDEX `peers_expiration_idx` ON `peers` (`paused`,`expiresAt`);--> statement-breakpoint
CREATE TABLE `user_promo_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`usedDiscountTier` integer NOT NULL,
	`createdAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_promo_usage_telegramId_unique` ON `user_promo_usage` (`telegramId`);--> statement-breakpoint
CREATE INDEX `user_promo_telegram_idx` ON `user_promo_usage` (`telegramId`);