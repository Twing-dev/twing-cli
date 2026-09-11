CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`developer_id` text NOT NULL,
	`project_ids` text NOT NULL,
	`blob_path` text NOT NULL,
	`bytes` integer NOT NULL,
	`record_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `captures_developer_session` ON `captures` (`developer_id`,`session_id`);--> statement-breakpoint
ALTER TABLE `project_records` ADD `design_active_ttl_ms` integer;