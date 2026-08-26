ALTER TABLE `alignment_threads` ADD `sub_kind` text;--> statement-breakpoint
ALTER TABLE `designs` ADD `justified_symbol_conflicts` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_reviews` ADD `symbol_conflict_waivers` text DEFAULT '[]' NOT NULL;