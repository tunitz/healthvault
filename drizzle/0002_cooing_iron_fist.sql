CREATE TABLE `food_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`meal` text NOT NULL,
	`eaten_at_ms` integer NOT NULL,
	`food_id` integer,
	`name` text NOT NULL,
	`grams` real NOT NULL,
	`kcal` real NOT NULL,
	`protein_g` real DEFAULT 0 NOT NULL,
	`carbs_g` real DEFAULT 0 NOT NULL,
	`fat_g` real DEFAULT 0 NOT NULL,
	`fibre_g` real DEFAULT 0 NOT NULL,
	`sodium_mg` real DEFAULT 0 NOT NULL,
	`estimated` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_food_log_day_meal_at` ON `food_log` (`day`,`meal`,`eaten_at_ms`,`name`);--> statement-breakpoint
CREATE TABLE `foods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`barcode` text,
	`serving_grams` real DEFAULT 100 NOT NULL,
	`kcal_per_100g` real NOT NULL,
	`protein_per_100g` real DEFAULT 0 NOT NULL,
	`carbs_per_100g` real DEFAULT 0 NOT NULL,
	`fat_per_100g` real DEFAULT 0 NOT NULL,
	`fibre_per_100g` real DEFAULT 0 NOT NULL,
	`sodium_per_100g` real DEFAULT 0 NOT NULL,
	`extra_json` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_foods_name_brand` ON `foods` (`name`,`brand`);--> statement-breakpoint
CREATE TABLE `measurements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`taken_at_ms` integer NOT NULL,
	`kind` text NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`note` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_measurements_kind_at` ON `measurements` (`kind`,`taken_at_ms`);--> statement-breakpoint
CREATE TABLE `nutrition_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`effective_from` text NOT NULL,
	`kcal` real,
	`protein_g` real,
	`carbs_g` real,
	`fat_g` real,
	`fibre_g` real,
	`sodium_mg` real,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_nutrition_targets_from` ON `nutrition_targets` (`effective_from`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text,
	`birth_date` text,
	`sex` text,
	`height_cm` real,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`units` text DEFAULT 'metric' NOT NULL,
	`work_schedule_json` text,
	`goal_weight_kg` real,
	`goals_note` text,
	`diet_note` text,
	`activity_note` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplement_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplement_id` integer NOT NULL,
	`day` text NOT NULL,
	`taken_at_ms` integer NOT NULL,
	`dose` real NOT NULL,
	`unit` text NOT NULL,
	`note` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`supplement_id`) REFERENCES `supplements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_supplement_logs_day` ON `supplement_logs` (`supplement_id`,`day`);--> statement-breakpoint
CREATE TABLE `supplements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`dose` real DEFAULT 1 NOT NULL,
	`unit` text DEFAULT 'capsule' NOT NULL,
	`schedule_json` text,
	`nutrients_json` text,
	`notes` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
