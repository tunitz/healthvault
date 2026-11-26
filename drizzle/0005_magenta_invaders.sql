CREATE TABLE `planned_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`intent` text,
	`title` text NOT NULL,
	`note` text,
	`target_json` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`workout_id` integer,
	`block_start` text,
	`week_no` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`workout_id`) REFERENCES `workouts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_planned_sessions_day` ON `planned_sessions` (`day`);--> statement-breakpoint
CREATE TABLE `strength_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`exercise` text NOT NULL,
	`set_no` integer DEFAULT 1 NOT NULL,
	`reps` real,
	`load_kg` real,
	`note` text,
	`workout_id` integer,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`workout_id`) REFERENCES `workouts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_strength_sets_exercise_day` ON `strength_sets` (`exercise`,`day`);--> statement-breakpoint
CREATE INDEX `idx_strength_sets_day` ON `strength_sets` (`day`);--> statement-breakpoint
ALTER TABLE `profile` ADD `goal_json` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `whey_link_json` text;