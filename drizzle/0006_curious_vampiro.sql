CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `user_trial_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`telegramId` text NOT NULL,
	`createdAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_trial_usage_telegramId_unique` ON `user_trial_usage` (`telegramId`);--> statement-breakpoint
CREATE INDEX `user_trial_telegram_idx` ON `user_trial_usage` (`telegramId`);--> statement-breakpoint
-- Бэкфилл: переносим уже выданные триалы (по ещё живым peers) в отдельную таблицу,
-- чтобы фикс бага не выдал этим пользователям пробный период повторно.
INSERT INTO `user_trial_usage` (`id`, `telegramId`, `createdAt`)
SELECT lower(hex(randomblob(16))), `telegramId`, MIN(`createdAt`)
FROM `peers`
WHERE `isTrial` = 1
GROUP BY `telegramId`;