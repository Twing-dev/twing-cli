-- Design review v2 (2026-09-27): comments are anchored to highlighted text and
-- answered only by people. The previous shape (coordinator first-pass answers,
-- escalate/acknowledge) had no real users, so its rows are dropped rather than
-- migrated -- a comment from the old flow has no anchor to show and a status
-- the new one no longer has. Its history goes with it: the reply events are
-- only readable through the comment they hang off, and leaving them would put
-- orphaned "escalated"/"agent answered" lines in the activity feed.
-- A deliberate one-off exception to activity_events' insert-only convention.
DELETE FROM `activity_events` WHERE `kind` IN ('design_comment_posted', 'design_comment_replied', 'design_comment_escalated', 'design_comment_acknowledged', 'design_comment_resolved');--> statement-breakpoint
DROP TABLE `design_comments`;--> statement-breakpoint
CREATE TABLE `design_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`design_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`anchor_field` text,
	`anchor_change_id` text,
	`anchor_quote` text,
	`anchor_prefix` text,
	`anchor_suffix` text,
	`design_version` integer NOT NULL,
	`status` text NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `design_comments_design_id_idx` ON `design_comments` (`design_id`);--> statement-breakpoint
CREATE INDEX `design_comments_project_status_idx` ON `design_comments` (`project_id`,`status`);
