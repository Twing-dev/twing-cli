-- Owner-editable design title/overview (2026-10-02). Additive only: an older
-- server started against a DB carrying these columns runs fine (drizzle's
-- sqlite migrator compares only against the latest applied migration, and
-- every query in packages/server/src names its columns explicitly).
--
-- IF THIS IS EVER REVERTED AND RE-LANDED, REUSE THIS FILE -- do not
-- `drizzle-kit generate` a replacement. The migrator applies only migrations
-- newer than the single latest already-applied one, so a regenerated file
-- with an older `when` than a 0022 that already ran is silently skipped: no
-- error, missing columns, and a crash on the first query touching them.
ALTER TABLE `designs` ADD `title` text;--> statement-breakpoint
ALTER TABLE `designs` ADD `summary_extracted` text;--> statement-breakpoint
ALTER TABLE `designs` ADD `overview_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `designs` ADD `overview_revised_at` integer;--> statement-breakpoint
ALTER TABLE `designs` ADD `overview_revised_by` text;--> statement-breakpoint
ALTER TABLE `designs` ADD `overview_revision_source` text;