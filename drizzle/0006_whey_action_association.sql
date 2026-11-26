ALTER TABLE `food_log` ADD `whey_action_json` text;
--> statement-breakpoint
ALTER TABLE `food_log` ADD `whey_action_day` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_food_log_whey_action_day` ON `food_log` (`whey_action_day`);
--> statement-breakpoint
ALTER TABLE `supplement_logs` ADD `whey_action_id` text;
