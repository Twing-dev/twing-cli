CREATE TABLE `design_group_diagrams` (
	`group_id` text PRIMARY KEY NOT NULL,
	`state_key` text NOT NULL,
	`diagrams` text NOT NULL,
	`skipped` text,
	`generated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `design_group_overviews` ADD `source` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `design_group_overviews` ADD `state_key` text DEFAULT '' NOT NULL;