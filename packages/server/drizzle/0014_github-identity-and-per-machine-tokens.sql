CREATE TABLE `developer_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`developer_id` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `developer_tokens_developer_idx` ON `developer_tokens` (`developer_id`);--> statement-breakpoint
ALTER TABLE `developers` ADD `github_user_id` text;--> statement-breakpoint
ALTER TABLE `developers` ADD `github_login` text;--> statement-breakpoint
CREATE UNIQUE INDEX `developers_github_user_id_unique` ON `developers` (`github_user_id`);--> statement-breakpoint
-- Carry every existing credential over, or authentication breaks for
-- everyone the instant `resolveToken` starts reading `developer_tokens`
-- instead of `developers.token_hash`. The live coordinator has real
-- identities on it; this is not a fresh-install migration.
--
-- `developers.token_hash` stays populated and is still written on identity
-- creation, so rolling this release back leaves working credentials behind.
-- It is dropped a release later, once there is nothing to roll back to.
INSERT OR IGNORE INTO `developer_tokens` (`token_hash`, `developer_id`, `label`, `created_at`)
  SELECT `token_hash`, `developer_id`, 'pre-per-machine-tokens', `created_at` FROM `developers`;
