ALTER TABLE `pending_reviews` ADD `constraint_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `pending_reviews` SET `constraint_ids` = json_array(`constraint_id`) WHERE `constraint_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` DROP COLUMN `constraint_id`;