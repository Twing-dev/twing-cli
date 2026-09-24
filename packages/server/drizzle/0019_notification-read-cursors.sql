CREATE TABLE `notification_reads` (
	`developer_id` text PRIMARY KEY NOT NULL,
	`last_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_events_developer_kind_idx` ON `activity_events` (`developer_id`,`kind`);