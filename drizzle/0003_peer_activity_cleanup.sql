ALTER TABLE `peers` ADD `pausedReason` text;--> statement-breakpoint
ALTER TABLE `peers` ADD `lastTrafficAt` integer;--> statement-breakpoint
ALTER TABLE `peers` ADD `lastHandshakeAt` integer;--> statement-breakpoint
ALTER TABLE `peers` ADD `rxBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `txBytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `inactivityNotifiedAt` integer;--> statement-breakpoint
CREATE INDEX `peers_paused_reason_idx` ON `peers` (`paused`,`pausedReason`);--> statement-breakpoint
CREATE INDEX `peers_activity_idx` ON `peers` (`paused`,`lastTrafficAt`);
