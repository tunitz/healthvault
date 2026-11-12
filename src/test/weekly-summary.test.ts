/**
 * Weekly training & recovery summary on a scratch database.
 *
 * Two seeded weeks with deliberate gaps: the previous week has every metric, the current week
 * has a run but no record rows (so the summary must flag stale data rather than implying a
 * quiet week). Never reads real health data and never opens `data/health.db`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-weekly-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";

let training: typeof import("@/lib/services/training");
let contextService: typeof import("@/lib/services/context");
let day: typeof import("@/lib/day");
let profileService: typeof import("@/lib/services/profile");
let sqlite: import("better-sqlite3").Database;

let today = "";
let currentStart = "";
let previousStart = "";
let previousEnd = "";

/** Asia/Manila has a fixed +08:00 offset (no DST), so the fixture can spell ISO strings. */
function isoLocal(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
}

type Stmt = import("better-sqlite3").Statement<unknown[]>;

let insertWorkout: Stmt;
let insertRecord: Stmt;
let insertStrengthSet: Stmt;

function workout(type: string, d: string, time: string, minutes: number, km: number | null, source = "iPhone") {
  const startMs = day.localTimeMs(d, time, TZ);
  const endMs = startMs + minutes * 60_000;
  insertWorkout.run(
    type,
    isoLocal(startMs),
    startMs,
    d,
    isoLocal(endMs),
    endMs,
    minutes * 60,
    km,
    km === null ? null : "km",
    300,
    "kcal",
    140,
    source,
  );
}

function record(type: string, unit: string, value: number, d: string, time: string, source = "iPhone") {
  const startMs = day.localTimeMs(d, time, TZ);
  insertRecord.run(type, unit, value, isoLocal(startMs), startMs, d, isoLocal(startMs), startMs, source);
}

/** A sleep segment from 23:00 to `hours` later, attributed to the day it started. */
function sleep(d: string, hours: number) {
  const startMs = day.localTimeMs(d, "23:00", TZ);
  const endMs = startMs + hours * 3_600_000;
  insertRecord.run(
    "HKCategoryTypeIdentifierSleepAnalysis",
    "hour",
    2, // Asleep
    isoLocal(startMs),
    startMs,
    d,
    isoLocal(endMs),
    endMs,
    "Apple Watch",
  );
}

function set(d: string, exercise: string, setNo: number, reps: number, loadKg: number) {
  insertStrengthSet.run(d, exercise, setNo, reps, loadKg, Date.now());
}

beforeAll(async () => {
  training = await import("@/lib/services/training");
  contextService = await import("@/lib/services/context");
  day = await import("@/lib/day");
  profileService = await import("@/lib/services/profile");
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);

  today = day.localDay(Date.now(), TZ);
  currentStart = day.weekStart(today);
  previousStart = day.addDays(currentStart, -7);
  previousEnd = day.addDays(previousStart, 6);

  insertWorkout = sqlite.prepare(`
    INSERT INTO workouts (
      workout_activity_type, start_date, start_ms, day, end_date, end_ms,
      duration_seconds, total_distance, total_distance_unit,
      total_energy_burned, total_energy_burned_unit, avg_hr, source_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRecord = sqlite.prepare(`
    INSERT INTO records (
      type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStrengthSet = sqlite.prepare(`
    INSERT INTO strength_sets (day, exercise, set_no, reps, load_kg, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Current week: one run, but no steps/sleep/HR/weight records. The summary must not read this
  // gap as a quiet week.
  workout("HKWorkoutActivityTypeRunning", currentStart, "06:00", 30, 5);

  // Previous week: two runs (best pace 24 min / 4 km = 6.0), one deduped strength session.
  workout("HKWorkoutActivityTypeRunning", previousStart, "06:00", 40, 6.25);
  workout("HKWorkoutActivityTypeRunning", day.addDays(previousStart, 3), "18:00", 24, 4);
  workout("HKWorkoutActivityTypeFunctionalStrengthTraining", day.addDays(previousStart, 1), "18:00", 30, null);
  workout(
    "HKWorkoutActivityTypeFunctionalStrengthTraining",
    day.addDays(previousStart, 1),
    "18:00",
    30,
    null,
    "Apple Watch",
  );
  set(day.addDays(previousStart, 1), "Squat", 1, 5, 80);
  set(day.addDays(previousStart, 1), "Squat", 2, 5, 82.5);
  set(day.addDays(previousStart, 1), "Bench", 1, 8, 60);

  // Previous week: three days of steps/resting HR/sleep, two weight readings.
  record("HKQuantityTypeIdentifierStepCount", "count", 8000, previousStart, "12:00");
  record("HKQuantityTypeIdentifierStepCount", "count", 10000, day.addDays(previousStart, 2), "12:00");
  record("HKQuantityTypeIdentifierStepCount", "count", 12000, day.addDays(previousStart, 4), "12:00");

  record("HKQuantityTypeIdentifierRestingHeartRate", "bpm", 56, previousStart, "07:00");
  record("HKQuantityTypeIdentifierRestingHeartRate", "bpm", 54, day.addDays(previousStart, 2), "07:00");
  record("HKQuantityTypeIdentifierRestingHeartRate", "bpm", 55, day.addDays(previousStart, 4), "07:00");

  sleep(previousStart, 7.5);
  sleep(day.addDays(previousStart, 2), 7.5);
  sleep(day.addDays(previousStart, 4), 7.5);

  record("HKQuantityTypeIdentifierBodyMass", "kg", 80, day.addDays(previousStart, 2), "07:00");
  record("HKQuantityTypeIdentifierBodyMass", "kg", 78.5, day.addDays(previousStart, 4), "07:00");
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("weekly summary boundaries", () => {
  test("weeks start on Sunday in Asia/Manila and end on Saturday", () => {
    const summary = training.weeklySummary(1);
    expect(summary.timezone).toBe(TZ);
    expect(summary.weekStart).toBe(previousStart);
    expect(summary.weekEnd).toBe(previousEnd);
    expect(day.weekdayIndex(summary.weekStart)).toBe(0);
    expect(day.weekdayIndex(summary.weekEnd)).toBe(6);
    expect(day.daysBetween(summary.weekStart, summary.weekEnd)).toBe(6);
  });

  test("the current week is the Sunday-start week containing today", () => {
    const summary = training.weeklySummary(0);
    expect(summary.weekStart).toBe(day.weekStart(today));
    expect(summary.weekEnd).toBe(day.addDays(day.weekStart(today), 6));
  });

  test("offset is clamped to the eight weeks the UI offers", () => {
    expect(training.MAX_WEEK_OFFSET).toBe(8);
    expect(training.weeklySummary(-3).weekStart).toBe(currentStart);
    expect(training.weeklySummary(99).weekStart).toBe(day.addDays(currentStart, -8 * 7));
  });

  test("the context carries the current week's compact summary", () => {
    const weekly = contextService.healthvaultContext().training.weekly;
    expect(weekly.weekStart).toBe(currentStart);
    expect(weekly.runs.count).toBe(1);
    expect(weekly.steps.daysWithData).toBe(0);
  });
});

describe("weekly summary values", () => {
  test("previous week: runs are deduped and pace is the best session", () => {
    const { runs } = training.weeklySummary(1);
    expect(runs.count).toBe(2);
    expect(runs.km).toBeCloseTo(10.25, 2);
    expect(runs.minutes).toBeCloseTo(64, 2);
    expect(runs.bestPaceMinPerKm ?? Number.NaN).toBeCloseTo(6, 2);
  });

  test("previous week: one Apple strength session and the manual sets stay separate", () => {
    const { strength } = training.weeklySummary(1);
    expect(strength.appleSessions).toBe(1);
    expect(strength.loggedSets).toBe(3);
    expect(strength.exercises).toBe(2);
  });

  test("previous week: steps, sleep and resting HR use each day once", () => {
    const summary = training.weeklySummary(1);
    expect(summary.steps.daysWithData).toBe(3);
    expect(summary.steps.avgPerDay).toBeCloseTo(10_000, 2);
    expect(summary.sleep.nights).toBe(3);
    expect(summary.sleep.avgPerNight).toBeCloseTo(7.5, 2);
    expect(summary.restingHr.avg).toBeCloseTo(55, 2);
    expect(summary.restingHr.latest).toBe(55);
    expect(summary.restingHr.latestDay).toBe(day.addDays(previousStart, 4));
  });

  test("previous week: weight is the weekly average with a within-week change", () => {
    const { weight } = training.weeklySummary(1);
    expect(weight.readings).toBe(2);
    expect(weight.avgKg).toBeCloseTo(79.25, 2);
    expect(weight.changeKg).toBeCloseTo(-1.5, 2);
    expect(weight.sparse).toBe(false);
  });

  test("current week has its run but no record series, and is flagged stale", () => {
    const summary = training.weeklySummary(0);
    expect(summary.runs.count).toBe(1);
    expect(summary.runs.km).toBeCloseTo(5, 2);
    expect(summary.runs.minutes).toBeCloseTo(30, 2);
    expect(summary.runs.bestPaceMinPerKm ?? Number.NaN).toBeCloseTo(6, 2);

    expect(summary.strength.appleSessions).toBe(0);
    expect(summary.steps.daysWithData).toBe(0);
    expect(summary.sleep.nights).toBe(0);
    expect(summary.restingHr.avg).toBeNull();
    expect(summary.weight.readings).toBe(0);
    expect(summary.weight.sparse).toBe(true);

    expect(summary.freshness.lastRecordDay).toBe(day.addDays(previousStart, 4));
    expect(summary.freshness.lastWorkoutDay).toBe(currentStart);
    expect(summary.freshness.stale).toBe(true);
  });

  test("an empty past week has an explicit empty shape, not a false trend", () => {
    const summary = training.weeklySummary(2);
    expect(summary.weekStart).toBe(day.addDays(currentStart, -14));
    expect(summary.runs).toEqual({ count: 0, km: 0, minutes: 0, bestPaceMinPerKm: null });
    expect(summary.strength).toEqual({ appleSessions: 0, loggedSets: 0, exercises: 0 });
    expect(summary.steps).toEqual({ avgPerDay: 0, daysWithData: 0 });
    expect(summary.sleep).toEqual({ avgPerNight: 0, nights: 0 });
    expect(summary.restingHr).toEqual({ avg: null, latest: null, latestDay: null });
    expect(summary.weight).toEqual({ avgKg: null, readings: 0, changeKg: null, sparse: true });
    // Data exists after this week, so the week is empty but not stale.
    expect(summary.freshness.stale).toBe(false);
  });
});
