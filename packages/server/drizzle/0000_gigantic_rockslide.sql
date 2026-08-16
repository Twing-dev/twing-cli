CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`developer_id` text,
	`session_id` text,
	`kind` text NOT NULL,
	`related_id` text,
	`ts` integer NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `activity_events_project_ts_idx` ON `activity_events` (`project_id`,`ts`);--> statement-breakpoint
CREATE INDEX `activity_events_related_id_idx` ON `activity_events` (`related_id`);--> statement-breakpoint
CREATE INDEX `activity_events_kind_idx` ON `activity_events` (`kind`);--> statement-breakpoint
CREATE TABLE `alignment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`symbol_id` text NOT NULL,
	`developer_id` text NOT NULL,
	`other_developer_id` text NOT NULL,
	`design_id` text,
	`status` text NOT NULL,
	`system_description` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`closed_by` text
);
--> statement-breakpoint
CREATE INDEX `alignment_threads_project_id_idx` ON `alignment_threads` (`project_id`);--> statement-breakpoint
CREATE TABLE `constraints` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`statement` text NOT NULL,
	`scope` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `constraints_project_id_idx` ON `constraints` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `constraints_project_statement_uidx` ON `constraints` (`project_id`,`statement`);--> statement-breakpoint
CREATE TABLE `designs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`developer_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_label` text,
	`status` text NOT NULL,
	`review_decision` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	`summary` text NOT NULL,
	`creates` text NOT NULL,
	`touches` text NOT NULL,
	`depends_on` text NOT NULL,
	`raw_plan_excerpt` text,
	`ttl_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `designs_project_id_idx` ON `designs` (`project_id`);--> statement-breakpoint
CREATE INDEX `designs_session_id_idx` ON `designs` (`session_id`);--> statement-breakpoint
CREATE TABLE `developers` (
	`developer_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `developers_token_hash_unique` ON `developers` (`token_hash`);--> statement-breakpoint
CREATE TABLE `invites` (
	`code` text PRIMARY KEY NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_org_id` text,
	`scope_project_id` text,
	`role` text NOT NULL,
	`label` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by` text
);
--> statement-breakpoint
CREATE TABLE `org_memberships` (
	`org_id` text NOT NULL,
	`developer_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`org_id`, `developer_id`)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`design_id` text NOT NULL,
	`project_id` text NOT NULL,
	`justification` text NOT NULL,
	`created_at` integer NOT NULL,
	`decision` text
);
--> statement-breakpoint
CREATE INDEX `pending_reviews_project_id_idx` ON `pending_reviews` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_memberships` (
	`project_id` text NOT NULL,
	`developer_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`project_id`, `developer_id`)
);
--> statement-breakpoint
CREATE TABLE `project_records` (
	`project_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`founded_by` text NOT NULL,
	`founded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `roadmap_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `roadmap_items_project_id_idx` ON `roadmap_items` (`project_id`);