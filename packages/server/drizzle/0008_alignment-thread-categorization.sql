ALTER TABLE `alignment_threads` ADD `category` text;--> statement-breakpoint
ALTER TABLE `alignment_threads` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `alignment_threads` ADD `symbol_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `alignment_threads` ADD `initiating_design_id` text;--> statement-breakpoint
ALTER TABLE `alignment_threads` ADD `last_activity_at` integer;--> statement-breakpoint
UPDATE `alignment_threads` SET `last_activity_at` = `opened_at` WHERE `last_activity_at` IS NULL;