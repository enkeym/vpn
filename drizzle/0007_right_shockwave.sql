CREATE TABLE `peer_device_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`peerName` text NOT NULL,
	`deviceCount` integer NOT NULL,
	`ips` text NOT NULL,
	`notifiedAt` integer
);
--> statement-breakpoint
CREATE INDEX `peer_device_alerts_peer_idx` ON `peer_device_alerts` (`peerName`);--> statement-breakpoint
CREATE INDEX `peer_device_alerts_notified_idx` ON `peer_device_alerts` (`notifiedAt`);