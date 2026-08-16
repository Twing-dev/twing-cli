ALTER TABLE `designs` ADD `justified_constraint_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `constraint_id` text;