CREATE TABLE `activity_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date_components` text NOT NULL,
	`day` text NOT NULL,
	`active_energy_burned` real,
	`active_energy_burned_goal` real,
	`apple_move_minutes` real,
	`apple_move_minutes_goal` real,
	`apple_exercise_time` real,
	`apple_exercise_time_goal` real,
	`apple_stand_hours` real,
	`apple_stand_hours_goal` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_summaries_date_components_unique` ON `activity_summaries` (`date_components`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type_identifier` text NOT NULL,
	`unit` text NOT NULL,
	`value` real NOT NULL,
	`start_date` text NOT NULL,
	`start_ms` integer NOT NULL,
	`day` text NOT NULL,
	`end_date` text NOT NULL,
	`end_ms` integer NOT NULL,
	`source_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_records_key` ON `records` (`type_identifier`,`start_date`,`end_date`,`source_name`,`value`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text NOT NULL,
	`records_inserted` integer DEFAULT 0 NOT NULL,
	`records_duplicates` integer DEFAULT 0 NOT NULL,
	`message` text,
	`created_at_ms` integer NOT NULL,
	`finished_at_ms` integer
);
--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workout_activity_type` text NOT NULL,
	`start_date` text NOT NULL,
	`start_ms` integer NOT NULL,
	`day` text NOT NULL,
	`end_date` text NOT NULL,
	`end_ms` integer NOT NULL,
	`duration_seconds` real,
	`total_distance` real,
	`total_distance_unit` text,
	`total_energy_burned` real,
	`total_energy_burned_unit` text,
	`source_name` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workouts_key` ON `workouts` (`workout_activity_type`,`start_date`,`end_date`,`source_name`);