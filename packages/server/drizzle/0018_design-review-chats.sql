CREATE TABLE `design_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`design_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `design_chats_design_reviewer` ON `design_chats` (`design_id`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `design_chats_project_id_idx` ON `design_chats` (`project_id`);