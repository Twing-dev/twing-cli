ALTER TABLE `designs` ADD `justified_conflicts` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `conflict_waivers` text DEFAULT '[]' NOT NULL;