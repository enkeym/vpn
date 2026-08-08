--> Конфиги wg0 больше не обслуживаются: интерфейс не поднимается, ключи из
--> awg0.conf их не знают. Удаляем записи до сноса колонки — после DROP COLUMN
--> отличить их будет уже нечем.
DELETE FROM `peers` WHERE `protocol` = 'wg';--> statement-breakpoint
DROP INDEX `peers_protocol_idx`;--> statement-breakpoint
ALTER TABLE `peers` DROP COLUMN `protocol`;--> statement-breakpoint
ALTER TABLE `payments` DROP COLUMN `protocol`;
