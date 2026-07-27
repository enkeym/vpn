ALTER TABLE `payments` ADD `protocol` text DEFAULT 'wg' NOT NULL;--> statement-breakpoint
ALTER TABLE `peers` ADD `protocol` text DEFAULT 'wg' NOT NULL;--> statement-breakpoint
CREATE INDEX `peers_protocol_idx` ON `peers` (`protocol`,`paused`);