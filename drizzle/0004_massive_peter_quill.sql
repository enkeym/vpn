ALTER TABLE `peers` ADD `vlessUuid` text;--> statement-breakpoint
CREATE UNIQUE INDEX `peers_vlessUuid_unique` ON `peers` (`vlessUuid`);