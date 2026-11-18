import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const uploads = sqliteTable("uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  bytes: integer("bytes").notNull(),
  status: text("status").notNull(), // running | done | failed
  recordsInserted: integer("records_inserted").notNull().default(0),
  recordsDuplicates: integer("records_duplicates").notNull().default(0),
  message: text("message"),
  createdAtMs: integer("created_at_ms").notNull(),
  finishedAtMs: integer("finished_at_ms"),
});

export const records = sqliteTable(
  "records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    typeIdentifier: text("type_identifier").notNull(),
    unit: text("unit").notNull(),
    value: real("value").notNull(),
    startDate: text("start_date").notNull(),
    startMs: integer("start_ms").notNull(),
    day: text("day").notNull(),
    endDate: text("end_date").notNull(),
    endMs: integer("end_ms").notNull(),
    sourceName: text("source_name").notNull(),
  },
  (t) => [
    uniqueIndex("uq_records_key").on(t.typeIdentifier, t.startDate, t.endDate, t.sourceName, t.value),
    // metrics_series filters `WHERE type_identifier = ? AND start_ms >= ?` on a 1M+ row table.
    index("idx_records_type_start_ms").on(t.typeIdentifier, t.startMs),
  ],
);

export const workouts = sqliteTable(
  "workouts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workoutActivityType: text("workout_activity_type").notNull(),
    startDate: text("start_date").notNull(),
    startMs: integer("start_ms").notNull(),
    day: text("day").notNull(),
    endDate: text("end_date").notNull(),
    endMs: integer("end_ms").notNull(),
    durationSeconds: real("duration_seconds"),
    totalDistance: real("total_distance"),
    totalDistanceUnit: text("total_distance_unit"),
    totalEnergyBurned: real("total_energy_burned"),
    totalEnergyBurnedUnit: text("total_energy_burned_unit"),
    // from <WorkoutStatistics type="...HeartRate" average/minimum/maximum> — the intensity
    // signal that shows whether training is paying off
    avgHr: real("avg_hr"),
    minHr: real("min_hr"),
    maxHr: real("max_hr"),
    sourceName: text("source_name"),
    metadataJson: text("metadata_json"),
  },
  (t) => [uniqueIndex("uq_workouts_key").on(t.workoutActivityType, t.startDate, t.endDate, t.sourceName)],
);

/* ---------------------------------------------------------------------------------------------
 * Manual tracking: profile, body measurements, food log, supplements.
 *
 * These tables are additive; the Apple import tables above are untouched. Day strings are the
 * user's local calendar day (profile.timezone), never SQLite's UTC `date('now')`. Timestamps are
 * epoch ms. Food log rows are immutable snapshots: editing a food never rewrites history.
 * ------------------------------------------------------------------------------------------- */

/** Singleton row (id = 1). Everything is nullable until the user fills it in. */
export const profile = sqliteTable("profile", {
  id: integer("id").primaryKey(),
  name: text("name"),
  birthDate: text("birth_date"), // YYYY-MM-DD
  sex: text("sex"), // male | female | other
  heightCm: real("height_cm"),
  timezone: text("timezone").notNull().default("Asia/Shanghai"), // IANA
  units: text("units").notNull().default("metric"), // metric | imperial
  workScheduleJson: text("work_schedule_json"), // { days: [{ weekday, start, end }], note }
  goalWeightKg: real("goal_weight_kg"),
  goalsNote: text("goals_note"),
  dietNote: text("diet_note"),
  activityNote: text("activity_note"),
  /** Training goal, e.g. { type: "run5k", targetSeconds: 1800 }. Pace is derived on read. */
  goalJson: text("goal_json"),
  /** One-tap whey logging target: { foodId, supplementId: number | null, grams, meal }. */
  wheyLinkJson: text("whey_link_json"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** Manual measurements. Apple BodyMass is merged in on read, never copied here. */
export const measurements = sqliteTable(
  "measurements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(), // local day
    takenAtMs: integer("taken_at_ms").notNull(),
    kind: text("kind").notNull(), // weight | bodyFat | waist
    value: real("value").notNull(),
    unit: text("unit").notNull(), // kg | % | cm
    note: text("note"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [uniqueIndex("uq_measurements_kind_at").on(t.kind, t.takenAtMs)],
);

/** Effective-dated nutrition goals; the newest effectiveFrom <= day wins. */
export const nutritionTargets = sqliteTable(
  "nutrition_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    effectiveFrom: text("effective_from").notNull(),
    kcal: real("kcal"),
    proteinG: real("protein_g"),
    carbsG: real("carbs_g"),
    fatG: real("fat_g"),
    fibreG: real("fibre_g"),
    sodiumMg: real("sodium_mg"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [uniqueIndex("uq_nutrition_targets_from").on(t.effectiveFrom)],
);

/** Household measures shared by every food: tbsp, tsp, kutsarita, cup, piece, scoop, strip. */
export const measures = sqliteTable(
  "measures",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(), // tbsp | tsp | kutsarita | cup | piece | scoop | strip
    gramsDefault: real("grams_default"), // null = the unit has no universal mass; use a food override
    ml: real("ml"),
    note: text("note"),
  },
  (t) => [uniqueIndex("uq_measures_name").on(t.name)],
);

/**
 * A reusable food. Macros are per 100 g of the food's stated `state` (raw by default), so a log
 * entry only needs grams. `yieldFactor` converts a weight in another state to that basis:
 * cooked g per raw g for raw foods (0.75 chicken breast), cooked g per dry g for dry foods.
 */
export const foods = sqliteTable(
  "foods",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    brand: text("brand"),
    barcode: text("barcode"),
    servingGrams: real("serving_grams").notNull().default(100),
    kcalPer100g: real("kcal_per_100g").notNull(),
    proteinPer100g: real("protein_per_100g").notNull().default(0),
    carbsPer100g: real("carbs_per_100g").notNull().default(0),
    fatPer100g: real("fat_per_100g").notNull().default(0),
    fibrePer100g: real("fibre_per_100g").notNull().default(0),
    sodiumPer100g: real("sodium_per_100g").notNull().default(0),
    state: text("state").notNull().default("raw"), // raw | cooked | dry | rehydrated | none
    yieldFactor: real("yield_factor").notNull().default(1), // cooked g per raw g (or per dry g)
    measuresJson: text("measures_json"), // per-food overrides, e.g. {"tbsp":6,"tsp":2,"piece":60}
    extraJson: text("extra_json"),
    source: text("source").notNull().default("manual"), // manual | label | usda | package | agent
    sourceUrl: text("source_url"), // provenance: where the per-100 g values came from
    sourceDate: text("source_date"), // provenance: YYYY-MM-DD the values were read
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [uniqueIndex("uq_foods_name_brand").on(t.name, t.brand)],
);

/** A composite dish. Totals are always computed from the ingredients, never stored. */
export const recipes = sqliteTable("recipes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  servingsTotal: integer("servings_total").notNull().default(2),
  note: text("note"),
  /** Set instead of deleting a recipe that has logged history. Archived recipes are history. */
  archivedAtMs: integer("archived_at_ms"),
  archivedReason: text("archived_reason"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** One ingredient of a recipe. Grams are resolved (and the measure kept) at write time. */
export const recipeIngredients = sqliteTable("recipe_ingredients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipeId: integer("recipe_id")
    .notNull()
    .references(() => recipes.id),
  foodId: integer("food_id").references(() => foods.id), // null = name-only ingredient
  name: text("name"), // used when food_id is null, or as a display override
  grams: real("grams").notNull(), // raw/as-stated ingredient weight
  measureJson: text("measure_json"), // optional { name, count } the grams were resolved from
  position: integer("position").notNull().default(0),
});

/** Immutable per-entry snapshot of what was eaten. */
export const foodLog = sqliteTable(
  "food_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    meal: text("meal").notNull(), // breakfast | lunch | dinner | snack
    eatenAtMs: integer("eaten_at_ms").notNull(),
    foodId: integer("food_id").references(() => foods.id),
    name: text("name").notNull(),
    grams: real("grams").notNull(), // what the user weighed or counted
    kcal: real("kcal").notNull(),
    proteinG: real("protein_g").notNull().default(0),
    carbsG: real("carbs_g").notNull().default(0),
    fatG: real("fat_g").notNull().default(0),
    fibreG: real("fibre_g").notNull().default(0),
    sodiumMg: real("sodium_mg").notNull().default(0),
    estimated: integer("estimated").notNull().default(0), // derived from macro_source; kept for the UI/API
    weightSource: text("weight_source"), // weighed | counted | guessed
    macroSource: text("macro_source"), // label | usda | recipe | estimated
    gramsAs: text("grams_as"), // raw | cooked — the state the user actually weighed
    rawEquivalentGrams: real("raw_equivalent_grams"), // grams on the food's macro basis
    /** The food's per-100 g basis state when this row was written (raw/cooked/dry/...). */
    basisState: text("basis_state"),
    /** The food's yield factor when this row was written; provenance only, never re-applied. */
    basisYieldFactor: real("basis_yield_factor"),
    recipeId: integer("recipe_id").references(() => recipes.id),
    servingNo: integer("serving_no"), // 1-based serving of the recipe
    servingFraction: real("serving_fraction").default(1),
    recipeServingJson: text("recipe_serving_json"), // per-one-serving snapshot at log time
    note: text("note"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    /** Immutable one-tap whey association and the prior supplement-log snapshot for Undo. */
    wheyActionJson: text("whey_action_json"),
    /** Non-null only for one-tap whey rows; unique per local day for concurrent duplicate guards. */
    wheyActionDay: text("whey_action_day"),
  },
  (t) => [
    uniqueIndex("uq_food_log_day_meal_at").on(t.day, t.meal, t.eatenAtMs, t.name),
    uniqueIndex("uq_food_log_whey_action_day").on(t.wheyActionDay),
  ],
);

/**
 * The full per-ingredient snapshot of a recipe-sourced `food_log` row.
 *
 * A recipe edit or archive never touches these rows, so history keeps the exact food ids,
 * quantities, household measure, state, source metadata and per-serving arithmetic that were
 * used at log time. `grams` is the amount in the logged portion; `perServingGrams` is the
 * amount in one serving, which is what a later `servingFraction` edit rescales from.
 */
export const foodLogIngredients = sqliteTable(
  "food_log_ingredients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    foodLogId: integer("food_log_id")
      .notNull()
      .references(() => foodLog.id),
    /** Historical references: kept even when the live recipe is later archived or deleted. */
    recipeId: integer("recipe_id"),
    recipeIngredientId: integer("recipe_ingredient_id"),
    foodId: integer("food_id").references(() => foods.id),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    /** Whole recipe / one serving / recipe definition, so `measureJson` is never ambiguous. */
    amountBasis: text("amount_basis"), // batch | serving
    grams: real("grams").notNull(), // amount in this logged portion
    perServingGrams: real("per_serving_grams").notNull(), // amount in one serving
    measureJson: text("measure_json"), // { name, count } the grams were resolved from
    gramsAs: text("grams_as"), // raw | cooked — what the user actually weighed
    foodState: text("food_state"), // snapshot of the food's per-100 g basis
    yieldFactor: real("yield_factor"), // snapshot of the food's yield factor
    rawEquivalentGrams: real("raw_equivalent_grams"),
    kcalPer100g: real("kcal_per_100g"),
    proteinPer100g: real("protein_per_100g"),
    carbsPer100g: real("carbs_per_100g"),
    fatPer100g: real("fat_per_100g"),
    fibrePer100g: real("fibre_per_100g"),
    sodiumPer100g: real("sodium_per_100g"),
    kcal: real("kcal").notNull().default(0), // portion macros
    proteinG: real("protein_g").notNull().default(0),
    carbsG: real("carbs_g").notNull().default(0),
    fatG: real("fat_g").notNull().default(0),
    fibreG: real("fibre_g").notNull().default(0),
    sodiumMg: real("sodium_mg").notNull().default(0),
    /** False for a name-only ingredient: grams are kept, macros are never invented. */
    resolved: integer("resolved").notNull().default(0),
    macroSource: text("macro_source"),
    weightSource: text("weight_source"),
    source: text("source"), // snapshot of foods.source
    sourceUrl: text("source_url"),
    sourceDate: text("source_date"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("idx_food_log_ingredients_log").on(t.foodLogId),
    index("idx_food_log_ingredients_food").on(t.foodId),
  ],
);

/** Every food definition change, so a past snapshot can be audited against what the food was. */
export const foodRevisions = sqliteTable(
  "food_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** No FK: the revision is an audit record and must outlive a food deleted while unused. */
    foodId: integer("food_id").notNull(),
    reason: text("reason").notNull(),
    previousJson: text("previous_json").notNull(),
    currentJson: text("current_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [index("idx_food_revisions_food").on(t.foodId)],
);

/**
 * Audit trail for every explicit past-meal correction. `food_log_ingredient_id` is null for a
 * plain food entry and set for one ingredient row; the previous/new JSON is the full snapshot.
 */
export const foodLogRevisions = sqliteTable(
  "food_log_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    foodLogId: integer("food_log_id")
      .notNull()
      .references(() => foodLog.id),
    foodLogIngredientId: integer("food_log_ingredient_id").references(() => foodLogIngredients.id),
    /** No FK: an audit row may outlive a food that was never logged and is later deleted. */
    foodId: integer("food_id"),
    reason: text("reason").notNull(),
    previousJson: text("previous_json").notNull(),
    newJson: text("new_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("idx_food_log_revisions_log").on(t.foodLogId),
    index("idx_food_log_revisions_ingredient").on(t.foodLogIngredientId),
  ],
);

export const supplements = sqliteTable("supplements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  dose: real("dose").notNull().default(1),
  unit: text("unit").notNull().default("capsule"),
  scheduleJson: text("schedule_json"), // { time: "08:00", days: [1..7] | null }
  nutrientsJson: text("nutrients_json"),
  notes: text("notes"),
  active: integer("active").notNull().default(1),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const supplementLogs = sqliteTable(
  "supplement_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    supplementId: integer("supplement_id")
      .notNull()
      .references(() => supplements.id),
    day: text("day").notNull(),
    takenAtMs: integer("taken_at_ms").notNull(),
    dose: real("dose").notNull(),
    unit: text("unit").notNull(),
    note: text("note"),
    createdAtMs: integer("created_at_ms").notNull(),
    /** Set only by a linked one-tap whey action; manual upserts clear it. */
    wheyActionId: text("whey_action_id"),
  },
  (t) => [uniqueIndex("uq_supplement_logs_day").on(t.supplementId, t.day)],
);

/**
 * A planned training session. Planned rows are intent, never activity: they never enter
 * workout volume or calorie totals. `workoutId` optionally points at the imported workout that
 * fulfilled the session — that Apple row stays the single source of the actual effort.
 */
export const plannedSessions = sqliteTable(
  "planned_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(), // local day
    kind: text("kind").notNull(), // run | strength | rest | test
    intent: text("intent"), // easy | quality | long_easy | test | strength
    title: text("title").notNull(),
    note: text("note"),
    /** e.g. {"structure":"6 × 2 min comfortably hard / 2 min easy","distanceKm":5,"paceMinPerKm":6} */
    targetJson: text("target_json"),
    status: text("status").notNull().default("planned"), // planned | done | skipped
    workoutId: integer("workout_id").references(() => workouts.id),
    /** Identifies the generated block, so one unfinished block can be detected. */
    blockStart: text("block_start"),
    weekNo: integer("week_no"), // 1-based week within the block
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("idx_planned_sessions_day").on(t.day)],
);

/**
 * Manually logged strength detail. Canonical load is kg (`loadKg`); the UI converts for display.
 * These rows may link to an imported workout but never mutate it and never add volume/kcal:
 * imported workout rows remain the only source of session totals.
 */
export const strengthSets = sqliteTable(
  "strength_sets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(), // local day
    exercise: text("exercise").notNull(),
    setNo: integer("set_no").notNull().default(1),
    reps: real("reps"),
    loadKg: real("load_kg"),
    note: text("note"),
    workoutId: integer("workout_id").references(() => workouts.id),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("idx_strength_sets_exercise_day").on(t.exercise, t.day),
    index("idx_strength_sets_day").on(t.day),
  ],
);

export const activitySummaries = sqliteTable("activity_summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dateComponents: text("date_components").notNull().unique(),
  day: text("day").notNull(),
  activeEnergyBurned: real("active_energy_burned"),
  activeEnergyBurnedGoal: real("active_energy_burned_goal"),
  appleMoveMinutes: real("apple_move_minutes"),
  appleMoveMinutesGoal: real("apple_move_minutes_goal"),
  appleExerciseTime: real("apple_exercise_time"),
  appleExerciseTimeGoal: real("apple_exercise_time_goal"),
  appleStandHours: real("apple_stand_hours"),
  appleStandHoursGoal: real("apple_stand_hours_goal"),
});

/* ---------------------------------------------------------------------------------------------
 * Stage 3: versioned, cross-device preferences + UI-first single-user credentials.
 *
 * Both are singletons (id = 1). Settings store one validated JSON blob with a revision used for
 * optimistic concurrency, so a stale device cannot silently overwrite another device's edits.
 * Credentials are authoritative only once `active = 1` is written by setup or a password change;
 * until then legacy env credentials apply. Secrets are stored as hashes / a session HMAC key only.
 * ------------------------------------------------------------------------------------------- */

/** Singleton (id = 1): the whole validated settings object plus its revision, in one JSON blob. */
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  value: text("value").notNull(), // JSON: the validated AppSettings object
  revision: integer("revision").notNull().default(0),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** Singleton (id = 1): persisted UI-first credentials. Never a plaintext password. */
export const authCredentials = sqliteTable("auth_credentials", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash").notNull(), // scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>
  sessionSecret: text("session_secret").notNull(), // HMAC key for UI session cookies
  agentToken: text("agent_token"), // nullable: null falls back to the env/token-file agent token
  active: integer("active").notNull().default(1), // 1 = authoritative over legacy env credentials
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});
