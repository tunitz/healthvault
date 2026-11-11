# Ingredient snapshots and history refresh — `0004` handoff

Canonical migration: `drizzle/0004_ingredient_snapshots_history.sql`
SHA-256: `2ae44d2bb3ed4c54fedb968359ea11c41e8f7217ba8be21f7a2aab5a1eaea53b`

This is the SQL and the cross-stack contract. It is additive: no existing `food_log`, `foods` or
`recipes` row is rewritten, and no historical ingredient is invented for an old aggregate row.
The Next.js implementation is in `src/db/schema.ts`, `src/lib/services/recipes.ts`,
`src/lib/services/nutrition.ts`, `src/lib/services/food-log-snapshots.ts`,
`src/lib/services/food-history.ts`, and the agent route/plugin. The Rust worktree must apply the
same SQL in the same order; it was intentionally not edited here.

## Exact SQL

```sql
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
```

## Semantics the Rust side must match

- `food_log_ingredients.grams` is the amount in the logged portion; `per_serving_grams` is the
  amount in one serving. Rescaling a `serving_fraction` recomputes children from
  `per_serving_grams × new_fraction`, never by compounding the previous row.
- `amount_basis` is `"batch"` for a recipe-definition ingredient, or the override basis
  (`"batch"`/`"serving"`). It makes `measure_json` unambiguous.
- `food_log.recipe_serving_json` stores per-one-serving totals, including `snapshotVersion: 2`
  and `ingredientCount` for new rows. Old rows without it remain valid.
- `basis_state`/`basis_yield_factor` snapshot the food basis on a plain food entry. History refresh
  uses `basis_state` plus `raw_equivalent_grams`; it never re-applies a current yield factor to an
  old row.
- `resolved = 0` means a name-only ingredient: grams are kept, macros are zero. Never synthesize
  nutrition for it.
- `food_log_ingredients.recipe_id` and `recipe_ingredient_id` are deliberately plain integers with
  no FK: they are historical provenance and must survive a recipe edit or deletion without the
  snapshot being rewritten.
- `food_log_revisions.food_id` and `food_revisions.food_id` deliberately have no FK so an audit row
  can outlive a food that was deleted while unused.

## Agent contracts (additive; existing inputs unchanged)

```text
meal_get { id } -> FoodEntry & { ingredients: FoodLogIngredient[], ingredientSnapshotComplete: boolean|null }

recipe_log { recipeId, meal, day?, servingNo?, servingFraction?, eatenAt?, name?, note?, weightSource?,
             ingredientOverrides?: [{ ingredientId?, foodId?, grams?, measure?, gramsAs? }],
             amountBasis?: "batch" | "serving" }
  -> { day, meal, recipeId, servingNo, servingFraction, incomplete, unresolvedIngredients,
       amountBasis: "batch"|"serving"|null, entry, ingredients: FoodLogIngredient[] }
  amountBasis is REQUIRED when ingredientOverrides is non-empty and rejected without overrides.
  Each override needs grams or measure (not both), and ingredientId or foodId. A duplicate
  target or a food appearing twice is a 400 (use ingredientId).

recipe_delete { id } -> { deleted, archived, reason?, loggedEntries?, snapshotIngredients?, archivedAtMs? }
  archived:true when logged rows OR copied child snapshots still reference the recipe;
  deleted:true only when neither does.

meal_update
  Explicit macros on a recipe entry with child snapshots are rejected with 409 (macros are
  derived from the children); servingFraction/servingNo combined with macros is 400.

food_history_preview { foodIds?: number[], entryIds?: number[], fromDay?, toDay? }
  -> { scope, previewHash, changed, unchanged, skipped, skippedReasons,
       changes: [{ kind:"entry"|"ingredient", entryId, ingredientId, foodId, name, day, meal,
                   status:"changed"|"unchanged"|"skipped", reason,
                   previous: Macros & {grams, rawEquivalentGrams} | null,
                   proposed: Macros & {grams, rawEquivalentGrams} | null }] }
  At least one of foodIds/entryIds is required. Read-only. A scope matching more than 500
  snapshots is rejected before any write.

food_history_refresh { foodIds?, entryIds?, fromDay?, toDay?, previewHash }
  -> { applied, entriesTouched, revisions, skipped, previewHash }
  Recomputes the preview; a mismatched hash is 409. Writes one revision per changed row and
  recomputes an affected recipe parent from its stored children.
```

Skip reasons: `food_missing`, `basis_unknown`, `basis_changed`, `yield_changed`,
`unresolved_ingredient`, `aggregate_snapshot_without_ingredients`. Old aggregate-only recipe rows
are not candidates for a food-scoped refresh; when explicitly named in `entryIds` they are surfaced
as skipped, and `meal_get`/`nutrition_day` report `ingredientSnapshotComplete: false` when the
recorded `ingredientCount` does not match the child rows (including a truncated snapshot). A
`servingFraction`/`grams` rescale of such a row is refused with 409 (no stored per-serving
arithmetic to rescale); explicit macro/gram edits remain available. Refresh never promotes an
existing `estimated`/manual provenance to `label` and never forces `estimated` off.

## Coordination status

The Rust worktree now embeds the canonical `0004` (SHA-256
`2ae44d2bb3ed4c54fedb968359ea11c41e8f7217ba8be21f7a2aab5a1eaea53b`,
`drizzle_created_at` `1_794_413_286_621`) with the `amount_basis` column. Its `0003` hash
(`0dc11291...`, created_at `1_794_396_538_714`) is unchanged. The full shared-migration test suite,
including the Next/Rust cross-stack lock tests, passes on a scratch database.


## Verification expectations shared with the Next app

- `PRAGMA integrity_check = ok` after migrating a fresh and a pre-`0004` database.
- Migration count in `__drizzle_migrations` / `hv_migrations` equals the journal length.
- Logging a serving writes one parent plus one child per ingredient in one transaction.
- `meal_delete` removes children and revisions; `copy_day` copies them.
- Repeating the `0004` migration is a no-op.
