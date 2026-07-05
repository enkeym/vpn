ALTER TABLE `peers` ADD `hysteriaPassword` text;--> statement-breakpoint
CREATE UNIQUE INDEX `peers_hysteriaPassword_unique` ON `peers` (`hysteriaPassword`);