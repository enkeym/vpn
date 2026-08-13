CREATE TABLE `user_autopay` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`paymentMethodId` text,
	`paymentMethodTitle` text,
	`durationDays` integer NOT NULL,
	`peerName` text,
	`nextChargeAt` integer,
	`lastChargeAt` integer,
	`warnNotifiedAt` integer,
	`lastError` text,
	`failedAttempts` integer DEFAULT 0 NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_autopay_telegramId_unique` ON `user_autopay` (`telegramId`);--> statement-breakpoint
CREATE INDEX `user_autopay_telegram_idx` ON `user_autopay` (`telegramId`);--> statement-breakpoint
CREATE INDEX `user_autopay_due_idx` ON `user_autopay` (`enabled`,`nextChargeAt`);--> statement-breakpoint
ALTER TABLE `payments` ADD `paymentMethodId` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `isAutoCharge` integer DEFAULT false NOT NULL;