/**
 * Activity totals must not read as a permanent zero when an Apple export has quantity records
 * but no ActivitySummary elements. Scratch DB only — never opens the live database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-activity-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

let sqlite: import("better-sqlite3").Database;
let queries: typeof import("@/db/queries");
let day: string;
let previousDay: string;

beforeAll(async () => {
  sqlite = (await import("@/db")).sqlite;
  queries = await import("@/db/queries");
  const { getTimezone } = await import("@/lib/services/profile");
  const { addDays, localDay } = await import("@/lib/day");
  day = localDay(Date.now(), getTimezone());
  previousDay = addDays(day, -1);
});

afterAll(() => {
  sqlite?.close();
  rmSync(scratchDir, { recursive: true, force: true });
});

function record(type: string, onDay: string, value: number, source: string, index: number) {
  const startMs = Date.parse(`${onDay}T00:${String(index).padStart(2, "0")}:00+08:00`);
  sqlite.prepare(`INSERT INTO records
    (type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    type, type.includes("Energy") ? "kcal" : "min", value,
    `${onDay} 00:${String(index).padStart(2, "0")}:00 +0800`, startMs, onDay,
    `${onDay} 00:${String(index).padStart(2, "0")}:01 +0800`, startMs + 60_000, source,
  );
}

const ENERGY = "HKQuantityTypeIdentifierActiveEnergyBurned";
const EXERCISE = "HKQuantityTypeIdentifierAppleExerciseTime";

describe("activity fallback when ActivitySummary rows are absent", () => {
  test("derives energy and exercise from records with one source per day", () => {
    // Phone: 3 samples (30 kcal). Watch: 1 larger sample (100 kcal). Phone must win on samples.
    record(ENERGY, day, 10, "iPhone", 1);
    record(ENERGY, day, 10, "iPhone", 2);
    record(ENERGY, day, 10, "iPhone", 3);
    record(ENERGY, day, 100, "Watch", 4);
    record(EXERCISE, day, 5, "iPhone", 5);
    record(EXERCISE, day, 5, "iPhone", 6);
    record(ENERGY, previousDay, 20, "iPhone", 7);

    const totals = queries.activitySummaryTotals(30);
    expect(totals.energy).toBe(50); // 30 today + 20 yesterday, not 120
    expect(totals.exerciseMinutes).toBe(10);
    expect(totals.moveMinutes).toBe(0); // never fabricated
    expect(totals.days).toBe(2);

    const series = queries.activitySummarySeries(30);
    expect(series.length).toBe(2);
    expect(series.map((p) => p.day)).toEqual([previousDay, day]);
    expect(series[1].activeEnergy).toBe(30);
    expect(series[1].exerciseTime).toBe(10);
    expect(series[1].activeEnergyGoal).toBeNull();
    expect(series[1].standHours).toBeNull();
  });

  test("ActivitySummary rows remain authoritative when present", () => {
    sqlite.prepare(`INSERT INTO activity_summaries
      (date_components, day, active_energy_burned, apple_exercise_time)
      VALUES (?, ?, 999, 42)`).run(day, day);
    const totals = queries.activitySummaryTotals(30);
    expect(totals.energy).toBe(999);
    expect(totals.exerciseMinutes).toBe(42);
    expect(totals.days).toBe(1);
    expect(queries.activitySummarySeries(30)).toEqual([{
      day,
      activeEnergy: 999,
      activeEnergyGoal: null,
      moveMinutes: null,
      exerciseTime: 42,
      standHours: null,
    }]);
  });
});
