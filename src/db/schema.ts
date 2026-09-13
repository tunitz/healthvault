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
