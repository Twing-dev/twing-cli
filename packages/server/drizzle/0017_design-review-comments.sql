CREATE TABLE `design_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`design_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`target_change_id` text,
	`status` text NOT NULL,
	`agent_answered_at` integer,
	`escalated_at` integer,
	`escalated_by` text,
	`acknowledged_at` integer,
	`resolved_at` integer,
	`resolved_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `design_comments_design_id_idx` ON `design_comments` (`design_id`);--> statement-breakpoint
CREATE INDEX `design_comments_project_status_idx` ON `design_comments` (`project_id`,`status`);