ALTER TABLE `designs` ADD `last_activity_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `designs` SET `last_activity_at` = `created_at` WHERE `last_activity_at` = 0;
