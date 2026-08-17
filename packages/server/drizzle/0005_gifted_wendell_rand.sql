PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_records` (
	`project_id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`founded_by` text NOT NULL,
	`founded_at` integer NOT NULL,
	`github_owner` text,
	`github_repo` text
);
--> statement-breakpoint
INSERT INTO `__new_project_records`("project_id", "org_id", "founded_by", "founded_at", "github_owner", "github_repo") SELECT "project_id", "org_id", "founded_by", "founded_at", "github_owner", "github_repo" FROM `project_records`;--> statement-breakpoint
DROP TABLE `project_records`;--> statement-breakpoint
ALTER TABLE `__new_project_records` RENAME TO `project_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;