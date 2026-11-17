CREATE TABLE `measures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`grams_default` real,
	`ml` real,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_measures_name` ON `measures` (`name`);--> statement-breakpoint
CREATE TABLE `recipe_ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`food_id` integer,
	`name` text,
	`grams` real NOT NULL,
	`measure_json` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`servings_total` integer DEFAULT 2 NOT NULL,
	`note` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `food_log` ADD `weight_source` text;--> statement-breakpoint
ALTER TABLE `food_log` ADD `macro_source` text;--> statement-breakpoint
ALTER TABLE `food_log` ADD `grams_as` text;--> statement-breakpoint
ALTER TABLE `food_log` ADD `raw_equivalent_grams` real;--> statement-breakpoint
ALTER TABLE `food_log` ADD `recipe_id` integer REFERENCES recipes(id);--> statement-breakpoint
ALTER TABLE `food_log` ADD `serving_no` integer;--> statement-breakpoint
ALTER TABLE `food_log` ADD `serving_fraction` real DEFAULT 1;--> statement-breakpoint
ALTER TABLE `food_log` ADD `recipe_serving_json` text;--> statement-breakpoint
ALTER TABLE `foods` ADD `state` text DEFAULT 'raw' NOT NULL;--> statement-breakpoint
ALTER TABLE `foods` ADD `yield_factor` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `foods` ADD `measures_json` text;
--> statement-breakpoint
-- Household-measure defaults. A per-food override (foods.measures_json) always wins, because
-- bulk density differs per product (a tbsp of honey is 21 g, a tbsp of instant coffee is 6 g).
-- Units without a universal mass stay NULL: logging them needs a food override or explicit grams.
INSERT OR IGNORE INTO `measures` (`name`, `grams_default`, `ml`, `note`) VALUES
	('tbsp', 15, 15, 'default 15 g / 15 ml; override per food where bulk density differs'),
	('tsp', 5, 5, 'default 5 g / 5 ml; override per food'),
	('kutsarita', 5, 5, 'Filipino teaspoon (5 ml); override per food'),
	('cup', 240, 240, 'default 240 g / 240 ml for water-like liquids; override per food'),
	('piece', NULL, NULL, 'no universal mass; set a per-food override (e.g. jumbo egg 60 g)'),
	('scoop', NULL, NULL, 'no universal mass; set a per-food override (e.g. whey 32.4 g)'),
	('strip', NULL, NULL, 'no universal mass; set a per-food override (e.g. KFC fry 2 g)');
--> statement-breakpoint
-- Canonical defaults from the real log. Exact name + brand only (never a fuzzy name match),
-- and only for rows whose new columns still hold their defaults. These statements never create
-- a food, never touch food_log, never rewrite updated_at_ms, and never overwrite a measure or
-- yield factor the user has already edited. They are idempotent: after the first run the guards
-- no longer match the affected rows.
UPDATE `foods` SET `measures_json` = '{"kutsarita":7,"tbsp":21}'
WHERE `name` = 'Honey' AND `brand` IS NULL AND `measures_json` IS NULL;--> statement-breakpoint
UPDATE `foods` SET `measures_json` = '{"tbsp":6,"tsp":1.8}'
WHERE `name` = 'NESCAFÉ Gold, instant coffee (dry)' AND `brand` = 'Nescafé' AND `measures_json` IS NULL;--> statement-breakpoint
UPDATE `foods` SET `measures_json` = '{"piece":60}'
WHERE `name` = 'Egg, whole, raw (jumbo 60g)' AND `brand` IS NULL AND `measures_json` IS NULL;--> statement-breakpoint
UPDATE `foods` SET `measures_json` = '{"strip":2}'
WHERE `name` = 'KFC Crispy Fries' AND `brand` = 'KFC Philippines' AND `measures_json` IS NULL;--> statement-breakpoint
UPDATE `foods` SET `measures_json` = '{"scoop":32.4}'
WHERE `name` = 'Whey Protein, ACTIVE, Chocolate' AND `brand` = 'ACTIVE' AND `measures_json` IS NULL;--> statement-breakpoint
UPDATE `foods` SET `yield_factor` = 0.75
WHERE `name` = 'Chicken breast, skinless, raw' AND `brand` IS NULL AND `yield_factor` = 1 AND `state` = 'raw';
