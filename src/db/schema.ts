import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  (t) => [uniqueIndex("uq_records_key").on(t.typeIdentifier, t.startDate, t.endDate, t.sourceName, t.value)],
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

/** A reusable food. Macros are per 100 g so a log entry only needs grams. */
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
    extraJson: text("extra_json"),
    source: text("source").notNull().default("manual"), // manual | agent
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [uniqueIndex("uq_foods_name_brand").on(t.name, t.brand)],
);

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
    grams: real("grams").notNull(),
    kcal: real("kcal").notNull(),
    proteinG: real("protein_g").notNull().default(0),
    carbsG: real("carbs_g").notNull().default(0),
    fatG: real("fat_g").notNull().default(0),
    fibreG: real("fibre_g").notNull().default(0),
    sodiumMg: real("sodium_mg").notNull().default(0),
    estimated: integer("estimated").notNull().default(0), // 1 = macros guessed, show a flag
    note: text("note"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [uniqueIndex("uq_food_log_day_meal_at").on(t.day, t.meal, t.eatenAtMs, t.name)],
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
  },
  (t) => [uniqueIndex("uq_supplement_logs_day").on(t.supplementId, t.day)],
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
