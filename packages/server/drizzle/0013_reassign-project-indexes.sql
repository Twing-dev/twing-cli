CREATE INDEX `alignment_threads_design_id_idx` ON `alignment_threads` (`design_id`);--> statement-breakpoint
CREATE INDEX `alignment_threads_initiating_design_id_idx` ON `alignment_threads` (`initiating_design_id`);--> statement-breakpoint
CREATE INDEX `pending_reviews_design_id_idx` ON `pending_reviews` (`design_id`);