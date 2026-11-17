CREATE TABLE `food_log_ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`food_log_id` integer NOT NULL,
	`recipe_id` integer,
	`recipe_ingredient_id` integer,
	`food_id` integer,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`amount_basis` text,
	`grams` real NOT NULL,
	`per_serving_grams` real NOT NULL,
	`measure_json` text,
	`grams_as` text,
	`food_state` text,
	`yield_factor` real,
	`raw_equivalent_grams` real,
	`kcal_per_100g` real,
	`protein_per_100g` real,
	`carbs_per_100g` real,
	`fat_per_100g` real,
	`fibre_per_100g` real,
	`sodium_per_100g` real,
	`kcal` real DEFAULT 0 NOT NULL,
	`protein_g` real DEFAULT 0 NOT NULL,
	`carbs_g` real DEFAULT 0 NOT NULL,
	`fat_g` real DEFAULT 0 NOT NULL,
	`fibre_g` real DEFAULT 0 NOT NULL,
	`sodium_mg` real DEFAULT 0 NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL,
	`macro_source` text,
	`weight_source` text,
	`source` text,
	`source_url` text,
	`source_date` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`food_log_id`) REFERENCES `food_log`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_food_log_ingredients_log` ON `food_log_ingredients` (`food_log_id`);--> statement-breakpoint
CREATE INDEX `idx_food_log_ingredients_food` ON `food_log_ingredients` (`food_id`);--> statement-breakpoint
CREATE TABLE `food_log_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`food_log_id` integer NOT NULL,
	`food_log_ingredient_id` integer,
	`food_id` integer,
	`reason` text NOT NULL,
	`previous_json` text NOT NULL,
	`new_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`food_log_id`) REFERENCES `food_log`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`food_log_ingredient_id`) REFERENCES `food_log_ingredients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_food_log_revisions_log` ON `food_log_revisions` (`food_log_id`);--> statement-breakpoint
CREATE INDEX `idx_food_log_revisions_ingredient` ON `food_log_revisions` (`food_log_ingredient_id`);--> statement-breakpoint
CREATE TABLE `food_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`food_id` integer NOT NULL,
	`reason` text NOT NULL,
	`previous_json` text NOT NULL,
	`current_json` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_food_revisions_food` ON `food_revisions` (`food_id`);--> statement-breakpoint
ALTER TABLE `food_log` ADD `basis_state` text;--> statement-breakpoint
ALTER TABLE `food_log` ADD `basis_yield_factor` real;--> statement-breakpoint
ALTER TABLE `foods` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `foods` ADD `source_date` text;--> statement-breakpoint
ALTER TABLE `recipes` ADD `archived_at_ms` integer;--> statement-breakpoint
ALTER TABLE `recipes` ADD `archived_reason` text;