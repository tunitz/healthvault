CREATE TABLE `ecg_recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`recorded_at` text NOT NULL,
	`recorded_at_ms` integer NOT NULL,
	`day` text NOT NULL,
	`classification` text NOT NULL,
	`avg_hr` real,
	`sampling_hz` real DEFAULT 512 NOT NULL,
	`unit` text DEFAULT 'µV' NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`samples_json` text NOT NULL,
	`symptoms` text,
	`device` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ecg_recordings_filename` ON `ecg_recordings` (`filename`);--> statement-breakpoint
CREATE INDEX `idx_ecg_recordings_day` ON `ecg_recordings` (`day`);--> statement-breakpoint
CREATE TABLE `workout_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workout_id` integer,
	`filename` text NOT NULL,
	`day` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`point_count` integer DEFAULT 0 NOT NULL,
	`distance_km` real DEFAULT 0 NOT NULL,
	`elevation_gain_m` real DEFAULT 0 NOT NULL,
	`elevation_loss_m` real DEFAULT 0 NOT NULL,
	`polyline_json` text NOT NULL,
	`splits_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`workout_id`) REFERENCES `workouts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workout_routes_filename` ON `workout_routes` (`filename`);--> statement-breakpoint
CREATE INDEX `idx_workout_routes_workout` ON `workout_routes` (`workout_id`);--> statement-breakpoint
CREATE INDEX `idx_workout_routes_day` ON `workout_routes` (`day`);--> statement-breakpoint
ALTER TABLE `uploads` ADD `rows_processed` integer DEFAULT 0 NOT NULL;