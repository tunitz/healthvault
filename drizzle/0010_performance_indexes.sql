CREATE INDEX `idx_activity_summaries_day` ON `activity_summaries` (`day`);--> statement-breakpoint
CREATE INDEX `idx_food_log_food` ON `food_log` (`food_id`);--> statement-breakpoint
CREATE INDEX `idx_food_log_recipe` ON `food_log` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `idx_food_log_ingredients_recipe` ON `food_log_ingredients` (`recipe_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_foods_name_null_brand` ON `foods` (`name`) WHERE "foods"."brand" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_recipe_ingredients_recipe` ON `recipe_ingredients` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `idx_recipe_ingredients_food` ON `recipe_ingredients` (`food_id`);--> statement-breakpoint
CREATE INDEX `idx_records_type_day_source` ON `records` (`type_identifier`,`day`,`source_name`);--> statement-breakpoint
CREATE INDEX `idx_records_day` ON `records` (`day`);--> statement-breakpoint
CREATE INDEX `idx_workouts_day_start_ms` ON `workouts` (`day`,`start_ms`);