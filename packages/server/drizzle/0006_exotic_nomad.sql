ALTER TABLE `designs` ADD `justified_overlaps` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `overlap_waivers` text DEFAULT '[]' NOT NULL;