/**
 * Synthetic fixtures for isolated development previews ONLY.
 * Never point DATABASE_PATH at the live database when running this.
 */
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { testDatabaseSymlinkViolation, testDatabaseViolation } from "../src/db/guard";

const path = process.env.DATABASE_PATH?.trim();
const liveDataDir = resolve(process.cwd(), "data").toLowerCase();
const violation = path
  ? testDatabaseViolation(path) ??
    testDatabaseSymlinkViolation(path) ??
    (resolve(path).toLowerCase().startsWith(liveDataDir) ? "inside live data directory" : undefined)
  : "DATABASE_PATH is not set";
if (!path || violation) {
  throw new Error(`Refusing to seed (${violation}): set DATABASE_PATH to an isolated scratch database`);
}
const db = new Database(path);
db.pragma("journal_mode = WAL");
const now = Date.now();
const DAY = 86_400_000;
const parsedEnd = process.env.SEED_END_MS ? Number(process.env.SEED_END_MS) : now;
const endDate = new Date(Number.isFinite(parsedEnd) ? parsedEnd : now);
const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const run = db.transaction(() => {
  db.prepare(`INSERT OR IGNORE INTO profile
    (id, name, birth_date, sex, height_cm, timezone, units, goal_weight_kg, goal_json, created_at_ms, updated_at_ms)
    VALUES (1, 'Alex', '1994-05-15', 'male', 175, 'UTC', 'metric', 70,
            '{"type":"run5k","targetSeconds":1680}', ?, ?)`).run(now, now);

  db.prepare(`INSERT OR IGNORE INTO nutrition_targets
    (effective_from, kcal, protein_g, carbs_g, fat_g, fibre_g, sodium_mg, created_at_ms, updated_at_ms)
    VALUES ('2026-01-01', 2200, 140, 250, 70, 30, 2000, ?, ?)`).run(now, now);

  const record = db.prepare(`INSERT OR IGNORE INTO records
    (type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const stepType = "HKQuantityTypeIdentifierStepCount";
  const hrType = "HKQuantityTypeIdentifierHeartRate";
  const sleepType = "HKCategoryTypeIdentifierSleepAnalysis";
  for (let i = 0; i < 60; i++) {
    const dayMs = end - i * DAY;
    const day = dayStr(dayMs);
    const start = dayMs + 8 * 3_600_000;
    record.run(stepType, "count", 8000 + ((i * 917) % 6000), new Date(start).toISOString(), start, day, new Date(start + 600_000).toISOString(), start + 600_000, "iPhone");
    for (let h = 0; h < 4; h++) {
      const t = start + h * 3_600_000;
      record.run(hrType, "count/min", 62 + ((i * 7 + h * 11) % 38), new Date(t).toISOString(), t, day, new Date(t + 60_000).toISOString(), t + 60_000, "Watch");
    }
    for (const [stage, hours] of [[2, 1.5], [4, 2], [5, 1], [6, 1.5]] as const) {
      const t = dayMs + 23 * 3_600_000;
      record.run(sleepType, "count", stage, new Date(t).toISOString(), t, day, new Date(t + hours * 3_600_000).toISOString(), t + hours * 3_600_000, "Watch");
    }
    // Activity rings: present as quantity records but with NO ActivitySummary rows, mirroring
    // the real export. Exercises use the same source as energy so per-day dedup picks one.
    const energyT = dayMs + 12 * 3_600_000;
    record.run("HKQuantityTypeIdentifierActiveEnergyBurned", "kcal", 320 + (i % 6) * 95,
      new Date(energyT).toISOString(), energyT, day, new Date(energyT + 600_000).toISOString(), energyT + 600_000, "iPhone");
    const exerciseT = dayMs + 13 * 3_600_000;
    record.run("HKQuantityTypeIdentifierAppleExerciseTime", "min", 20 + (i % 8) * 7,
      new Date(exerciseT).toISOString(), exerciseT, day, new Date(exerciseT + 600_000).toISOString(), exerciseT + 600_000, "iPhone");
  }

  const workout = db.prepare(`INSERT OR IGNORE INTO workouts
    (workout_activity_type, start_date, start_ms, day, end_date, end_ms, duration_seconds,
     total_distance, total_distance_unit, total_energy_burned, avg_hr, max_hr, source_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'km', ?, ?, ?, 'Watch')`);
  for (let i = 0; i < 6; i++) {
    const dayMs = end - i * 7 * DAY;
    const day = dayStr(dayMs);
    const t = dayMs + 6 * 3_600_000;
    const seconds = 1500 + i * 25;
    workout.run("HKWorkoutActivityTypeRunning", new Date(t).toISOString(), t, day,
      new Date(t + seconds * 1000).toISOString(), t + seconds * 1000, seconds,
      (5000 + i * 250) / 1000, 320 + i * 5, 150 + i, 175 + i);
  }

  const weight = db.prepare(`INSERT OR IGNORE INTO measurements
    (day, taken_at_ms, kind, value, unit, created_at_ms) VALUES (?, ?, 'weight', ?, 'kg', ?)`);
  for (let i = 0; i < 8; i++) {
    const dayMs = end - i * 7 * DAY;
    weight.run(dayStr(dayMs), dayMs + 7 * 3_600_000, 71 - i * 0.3, now);
  }

  const food = db.prepare(`INSERT OR IGNORE INTO foods
    (name, serving_grams, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
     fibre_per_100g, sodium_per_100g, state, source, created_at_ms, updated_at_ms)
    VALUES (?, 100, ?, ?, ?, ?, ?, ?, 'raw', 'usda', ?, ?)`);
  food.run("Spinach, raw", 23, 2.9, 3.6, 0.4, 2.2, 79, now, now);
  food.run("Chicken breast, raw", 120, 22.5, 0, 2.6, 0, 45, now, now);
  food.run("Rolled oats, dry", 389, 16.9, 66.3, 6.9, 10.6, 2, now, now);
  food.run("Whole egg", 143, 12.6, 0.7, 9.5, 0, 142, now, now);
  food.run("Whey protein", 400, 80, 8, 6, 0, 120, now, now);

  const foodRows = db.prepare("SELECT id, name FROM foods ORDER BY id").all() as { id: number; name: string }[];
  const foodId = (name: string) => foodRows.find((f) => f.name === name)?.id ?? null;
  const mealLog = db.prepare(`INSERT OR IGNORE INTO food_log
    (day, meal, eaten_at_ms, food_id, name, grams, kcal, protein_g, carbs_g, fat_g, fibre_g, sodium_mg, estimated, weight_source, macro_source, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'weighed', 'usda', ?, ?)`);
  for (let i = 0; i < 7; i++) {
    const dayMs = end - i * DAY;
    const day = dayStr(dayMs);
    mealLog.run(day, "breakfast", dayMs + 8 * 3_600_000, foodId("Rolled oats, dry"), "Rolled oats, dry", 80, 311, 13.5, 53.0, 5.5, 8.5, 2, now, now);
    mealLog.run(day, "breakfast", dayMs + 8 * 3_600_000 + 60_000, foodId("Whole egg"), "Whole egg", 180, 257, 22.7, 1.3, 17.1, 0, 256, now, now);
    mealLog.run(day, "lunch", dayMs + 13 * 3_600_000, foodId("Chicken breast, raw"), "Chicken breast, raw", 220, 264, 49.5, 0, 5.7, 0, 99, now, now);
    mealLog.run(day, "lunch", dayMs + 13 * 3_600_000 + 60_000, foodId("Spinach, raw"), "Spinach, raw", 150, 35, 4.4, 5.4, 0.6, 3.3, 119, now, now);
    mealLog.run(day, "snack", dayMs + 17 * 3_600_000, foodId("Whey protein"), "Whey protein", 35, 140, 28, 2.8, 2.1, 0, 42, now, now);
  }

  const plan = db.prepare(`INSERT OR IGNORE INTO planned_sessions
    (day, kind, intent, title, target_json, status, block_start, week_no, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const blockStart = dayStr(end - 7 * DAY);
  plan.run(dayStr(end - 3 * DAY), "run", "easy", "Easy 5K aerobic run", '{"distanceKm":5,"paceMinPerKm":6.2}', "done", blockStart, 1, now, now);
  plan.run(dayStr(end - DAY), "strength", "strength", "Upper body & core", '{"focus":"Push/Pull"}', "done", blockStart, 1, now, now);
  plan.run(dayStr(end), "run", "quality", "Tempo intervals 4x4 min", '{"distanceKm":6,"paceMinPerKm":5.5}', "planned", blockStart, 1, now, now);
  plan.run(dayStr(end + 2 * DAY), "run", "long_easy", "Weekend long run", '{"distanceKm":8,"paceMinPerKm":6.4}', "planned", blockStart, 1, now, now);

  const strength = db.prepare(`INSERT OR IGNORE INTO strength_sets
    (day, exercise, set_no, reps, load_kg, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`);
  for (let s = 1; s <= 3; s++) {
    strength.run(dayStr(end - DAY), "Barbell Squat", s, 8, 80, now);
    strength.run(dayStr(end - DAY), "Bench Press", s, 8, 65, now);
  }

  const supp = db.prepare(`INSERT OR IGNORE INTO supplements
    (name, dose, unit, schedule_json, active, created_at_ms, updated_at_ms)
    VALUES (?, 1, 'capsule', '{"time":"08:00"}', 1, ?, ?)`);
  supp.run("Vitamin D", now, now);
  supp.run("Omega 3", now, now);
  const ids = db.prepare("SELECT id FROM supplements ORDER BY id").all() as { id: number }[];
  const log = db.prepare(`INSERT OR IGNORE INTO supplement_logs
    (supplement_id, day, taken_at_ms, dose, unit, created_at_ms) VALUES (?, ?, ?, 1, 'capsule', ?)`);
  for (let i = 0; i < 5; i++) {
    const day = dayStr(end - i * DAY);
    for (const s of ids) log.run(s.id, day, end - i * DAY + 8 * 3_600_000, now);
  }
});

run();
console.log("seeded synthetic fixtures into", path);
db.close();
