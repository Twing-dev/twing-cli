CREATE TABLE `design_documents` (
  `group_id` text PRIMARY KEY NOT NULL,
  `content_json` text,
  `revision` integer DEFAULT 0 NOT NULL,
  `requested_version` integer DEFAULT 1 NOT NULL,
  `requested_fingerprint` text,
  `published_fingerprint` text,
  `published_source_projects` text DEFAULT '[]' NOT NULL,
  `generation_status` text DEFAULT 'pending' NOT NULL,
  `last_error_code` text,
  `updated_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `design_documents_status_idx` ON `design_documents` (`generation_status`);
--> statement-breakpoint
-- Existing designs keep their original presentation until changed or regenerated.
CREATE TRIGGER `design_document_insert` AFTER INSERT ON `designs` BEGIN
  INSERT INTO design_documents (group_id) VALUES (COALESCE(NEW.group_id, NEW.id))
  ON CONFLICT(group_id) DO UPDATE SET
    requested_version = requested_version + 1, requested_fingerprint = NULL,
    generation_status = 'pending', last_error_code = NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `design_document_update` AFTER UPDATE ON `designs`
WHEN OLD.group_id IS NOT NEW.group_id OR OLD.project_id IS NOT NEW.project_id
  OR OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary
  OR OLD.raw_plan_excerpt IS NOT NEW.raw_plan_excerpt OR OLD.changes IS NOT NEW.changes
  OR OLD.creates IS NOT NEW.creates OR OLD.touches IS NOT NEW.touches
  OR OLD.depends_on IS NOT NEW.depends_on
BEGIN
  INSERT INTO design_documents (group_id) VALUES (COALESCE(OLD.group_id, OLD.id))
  ON CONFLICT(group_id) DO UPDATE SET
    requested_version = requested_version + 1, requested_fingerprint = NULL,
    generation_status = 'pending', last_error_code = NULL;
  INSERT INTO design_documents (group_id)
    SELECT COALESCE(NEW.group_id, NEW.id)
    WHERE COALESCE(NEW.group_id, NEW.id) IS NOT COALESCE(OLD.group_id, OLD.id)
  ON CONFLICT(group_id) DO UPDATE SET
    requested_version = requested_version + 1, requested_fingerprint = NULL,
    generation_status = 'pending', last_error_code = NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `design_document_delete` AFTER DELETE ON `designs` BEGIN
  INSERT INTO design_documents (group_id) VALUES (COALESCE(OLD.group_id, OLD.id))
  ON CONFLICT(group_id) DO UPDATE SET
    requested_version = requested_version + 1, requested_fingerprint = NULL,
    generation_status = 'pending', last_error_code = NULL;
END;
