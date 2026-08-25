ALTER TABLE `designs` ADD `group_id` text;--> statement-breakpoint
CREATE INDEX `designs_group_id_idx` ON `designs` (`group_id`);