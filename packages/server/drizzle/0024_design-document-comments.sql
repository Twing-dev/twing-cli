ALTER TABLE `design_comments` ADD `anchor_document_group_id` text;
--> statement-breakpoint
ALTER TABLE `design_comments` ADD `anchor_document_revision` integer;
--> statement-breakpoint
ALTER TABLE `design_comments` ADD `anchor_document_source_projects` text;
--> statement-breakpoint
CREATE INDEX `design_comments_document_group_idx` ON `design_comments` (`anchor_document_group_id`);
