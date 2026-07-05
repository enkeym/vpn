PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`username` text,
	`configMessageId` integer,
	`qrMessageId` integer,
	`fileMessageId` integer,
	`name` text NOT NULL,
	`description` text,
	`publicKey` text,
	`privateKey` text,
	`presharedKey` text,
	`vlessUuid` text,
	`hysteriaPassword` text,
	`ip` text,
	`endpoint` text,
	`paused` integer DEFAULT false NOT NULL,
	`pausedAt` integer,
	`pausedReason` text,
	`expiresAt` integer,
	`isTrial` integer DEFAULT false NOT NULL,
	`lastReplacedAt` integer,
	`lastTrafficAt` integer,
	`lastHandshakeAt` integer,
	`rxBytes` integer DEFAULT 0 NOT NULL,
	`txBytes` integer DEFAULT 0 NOT NULL,
	`inactivityNotifiedAt` integer,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_peers`("id", "telegramId", "username", "configMessageId", "qrMessageId", "fileMessageId", "name", "description", "publicKey", "privateKey", "presharedKey", "vlessUuid", "hysteriaPassword", "ip", "endpoint", "paused", "pausedAt", "pausedReason", "expiresAt", "isTrial", "lastReplacedAt", "lastTrafficAt", "lastHandshakeAt", "rxBytes", "txBytes", "inactivityNotifiedAt", "createdAt", "updatedAt") SELECT "id", "telegramId", "username", "configMessageId", "qrMessageId", "fileMessageId", "name", "description", "publicKey", "privateKey", "presharedKey", "vlessUuid", "hysteriaPassword", "ip", "endpoint", "paused", "pausedAt", "pausedReason", "expiresAt", "isTrial", "lastReplacedAt", "lastTrafficAt", "lastHandshakeAt", "rxBytes", "txBytes", "inactivityNotifiedAt", "createdAt", "updatedAt" FROM `peers`;--> statement-breakpoint
DROP TABLE `peers`;--> statement-breakpoint
ALTER TABLE `__new_peers` RENAME TO `peers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `peers_name_unique` ON `peers` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `peers_vlessUuid_unique` ON `peers` (`vlessUuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `peers_hysteriaPassword_unique` ON `peers` (`hysteriaPassword`);--> statement-breakpoint
CREATE UNIQUE INDEX `peers_ip_unique` ON `peers` (`ip`);--> statement-breakpoint
CREATE INDEX `peers_telegram_id_idx` ON `peers` (`telegramId`);--> statement-breakpoint
CREATE INDEX `peers_name_idx` ON `peers` (`name`);--> statement-breakpoint
CREATE INDEX `peers_ip_idx` ON `peers` (`ip`);--> statement-breakpoint
CREATE INDEX `peers_paused_idx` ON `peers` (`paused`);--> statement-breakpoint
CREATE INDEX `peers_expiration_idx` ON `peers` (`paused`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `peers_paused_reason_idx` ON `peers` (`paused`,`pausedReason`);--> statement-breakpoint
CREATE INDEX `peers_activity_idx` ON `peers` (`paused`,`lastTrafficAt`);