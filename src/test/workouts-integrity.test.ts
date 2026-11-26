/**
 * Workout integrity on a scratch database: multi-source duplicates, sessions beyond one page,
 * local-day attribution and stored distance units.
 *
 * The fixture never reads real health data and never touches `data/health.db`. It is built around
 * `Date.now()` in the profile timezone so the rolling-window queries have data to see.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-workouts-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";
const PAGE_SIZE = 500;

let queries: typeof import("@/db/queries");
let contextService: typeof import("@/lib/services/context");
let profileService: typeof import("@/lib/services/profile");
let day: typeof import("@/lib/day");
let sqlite: import("better-sqlite3").Database;

/**
 * The fixture exercises supported units, an unknown label, and persisted NULL/blank units. The
 * real production distribution of `total_distance_unit` was not inspected for this change.
 */
type Unit = "km" | "m" | "mi";

type InsertInput = {
  startMs: number;
  endMs: number;
  durationSeconds?: number | null;
  totalDistance?: number | null;
  totalDistanceUnit?: string | null;
  kcal?: number | null;
  sourceName?: string | null;
  avgHr?: number | null;
};

function prepareInsert(db: import("better-sqlite3").Database, sql: string) {
  return db.prepare(sql);
}

let insert: ReturnType<typeof prepareInsert>;

function isoLocal(ms: number): string {
  // Asia/Manila has a fixed +08:00 offset (no DST), so the fixture can spell ISO strings exactly.
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
}

function insertWorkout(input: InsertInput): number {
  const info = insert.run(
    "HKWorkoutActivityTypeRunning",
    isoLocal(input.startMs),
    input.startMs,
    day.localDay(input.startMs, TZ),
    isoLocal(input.endMs),
    input.endMs,
    input.durationSeconds === undefined ? 1800 : input.durationSeconds,
    input.totalDistance === undefined ? null : input.totalDistance,
    input.totalDistanceUnit === undefined ? null : input.totalDistanceUnit,
    input.kcal === undefined ? 300 : input.kcal,
    "kcal",
    input.avgHr === undefined ? 140 : input.avgHr,
    input.sourceName === undefined ? "iPhone" : input.sourceName,
  );
  return Number(info.lastInsertRowid);
}

/** The documented dedup key: one row per activity type plus exact start/end. */
function dedupKey(row: { type: string; startDate: string; endDate: string }): string {
  return `${row.type}|${row.startDate}|${row.endDate}`;
}

/**
 * A session key for surfaces that do not expose `endDate` (training history and
 * `healthvaultContext().training.workouts`). The start instant identifies the session there;
 * page rows also have their full dedup key.
 */
function sessionKey(row: { type: string; startDate: string }): string {
  return `${row.type}|${row.startDate}`;
}

const expected = { sessions: 0, seconds: 0, km: 0, kcal: 0 };

/** Logical sessions whose complete row is the *second* inserted row. */
const upgradedStarts: string[] = [];
/** Duplicated sessions whose chosen row must stay the first (complete, lower-id) row. */
const firstWinsStarts: string[] = [];
let meterStart = "";
let mileStart = "";
let midnightStart = "";
let midnightDay = "";
let unknownStart = "";
let nullUnitStart = "";
let blankUnitStart = "";

let today = "";

beforeAll(async () => {
  queries = await import("@/db/queries");
  contextService = await import("@/lib/services/context");
  profileService = await import("@/lib/services/profile");
  day = await import("@/lib/day");
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
  today = day.localDay(Date.now(), TZ);

  expected.sessions = 0;
  expected.seconds = 0;
  expected.km = 0;
  expected.kcal = 0;
  upgradedStarts.length = 0;
  firstWinsStarts.length = 0;

  insert = prepareInsert(sqlite, `
    INSERT INTO workouts (
      workout_activity_type, start_date, start_ms, day, end_date, end_ms,
      duration_seconds, total_distance, total_distance_unit,
      total_energy_burned, total_energy_burned_unit, avg_hr, source_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 600 distinct sessions over 30 local days, 20 per day (05:00–14:30). Ten use metres and ten
  // use miles so the unit filter is exercised with exact and converted distances.
  for (let i = 0; i < 600; i++) {
    const d = day.addDays(today, -(i % 30));
    const slot = Math.floor(i / 30);
    const minutes = 5 * 60 + slot * 30;
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const startMs = day.localTimeMs(d, time, TZ);
    const endMs = startMs + 30 * 60_000;

    let distance = 5;
    let unit: Unit = "km";
    if (i % 60 === 0) {
      distance = 5000;
      unit = "m";
    } else if (i % 60 === 30) {
      distance = 3.10686;
      unit = "mi";
    }
    if (i === 0) meterStart = isoLocal(startMs);
    if (i === 30) mileStart = isoLocal(startMs);

    insertWorkout({ startMs, endMs, totalDistance: distance, totalDistanceUnit: unit });

    // Every seventh session was also recorded by the watch. Alternate what the duplicate is
    // missing, plus one case where both rows are complete and the lower id must win.
    if (i % 7 === 0) {
      const variant = (i / 7) % 3;
      if (variant === 0) {
        insertWorkout({ startMs, endMs, totalDistance: null, sourceName: "Apple Watch" });
      } else if (variant === 1) {
        insertWorkout({
          startMs,
          endMs,
          durationSeconds: null,
          totalDistance: distance,
          totalDistanceUnit: unit,
          sourceName: "Apple Watch",
        });
      } else {
        insertWorkout({
          startMs,
          endMs,
          totalDistance: distance,
          totalDistanceUnit: unit,
          kcal: 310,
          sourceName: "Apple Watch",
        });
        firstWinsStarts.push(isoLocal(startMs));
      }
    }

    expected.sessions += 1;
    expected.seconds += 1800;
    expected.km += distance * (unit === "m" ? 0.001 : unit === "mi" ? 1.609344 : 1);
    expected.kcal += 300;
  }

  // The complete row arrives second: completeness must beat the lower id.
  {
    const d = day.addDays(today, -3);
    const startMs = day.localTimeMs(d, "18:00", TZ);
    const endMs = startMs + 30 * 60_000;
    insertWorkout({ startMs, endMs, totalDistance: null, sourceName: "iPhone" });
    insertWorkout({ startMs, endMs, totalDistance: 5, totalDistanceUnit: "km", sourceName: "Apple Watch" });
    upgradedStarts.push(isoLocal(startMs));
    expected.sessions += 1;
    expected.seconds += 1800;
    expected.km += 5;
    expected.kcal += 300;
  }
  {
    const d = day.addDays(today, -4);
    const startMs = day.localTimeMs(d, "18:00", TZ);
    const endMs = startMs + 30 * 60_000;
    insertWorkout({ startMs, endMs, durationSeconds: null, totalDistance: 5, totalDistanceUnit: "km", sourceName: "iPhone" });
    insertWorkout({ startMs, endMs, totalDistance: 5, totalDistanceUnit: "km", sourceName: "Apple Watch" });
    upgradedStarts.push(isoLocal(startMs));
    expected.sessions += 1;
    expected.seconds += 1800;
    expected.km += 5;
    expected.kcal += 300;
  }

  // An unknown-unit copy must not outrank a duplicate whose distance is actually normalisable.
  {
    const d = day.addDays(today, -8);
    const startMs = day.localTimeMs(d, "20:00", TZ);
    const endMs = startMs + 30 * 60_000;
    insertWorkout({ startMs, endMs, totalDistance: 5, totalDistanceUnit: null, sourceName: "iPhone" });
    insertWorkout({ startMs, endMs, totalDistance: 5, totalDistanceUnit: "km", sourceName: "Apple Watch" });
    upgradedStarts.push(isoLocal(startMs));
    expected.sessions += 1;
    expected.seconds += 1800;
    expected.km += 5;
    expected.kcal += 300;
  }

  // A session that starts before local midnight and ends after it belongs to the start day.
  {
    midnightDay = day.addDays(today, -10);
    const startMs = day.localTimeMs(midnightDay, "23:50", TZ);
    const endMs = day.localTimeMs(day.addDays(midnightDay, 1), "00:20", TZ);
    insertWorkout({ startMs, endMs, totalDistance: 5, totalDistanceUnit: "km" });
    midnightStart = isoLocal(startMs);
    expected.sessions += 1;
    expected.seconds += 1800;
    expected.km += 5;
    expected.kcal += 300;
  }

  // An unrecognised unit keeps the session but never invents a kilometre value.
  {
    const d = day.addDays(today, -5);
    const startMs = day.localTimeMs(d, "21:00", TZ);
    const endMs = startMs + 30 * 60_000;
    insertWorkout({
      startMs,
      endMs,
      totalDistance: 5,
      totalDistanceUnit: "not-a-unit",
    });
    unknownStart = isoLocal(startMs);
    expected.sessions += 1;
    expected.seconds += 1800;
    expected.kcal += 300;
  }

  const addUnknownDistance = (offsetDays: number, unit: string | null) => {
    const d = day.addDays(today, -offsetDays);
    const startMs = day.localTimeMs(d, "21:00", TZ);
    const endMs = startMs + 30 * 60_000;
    insertWorkout({ startMs, endMs, totalDistance: 5, totalDistanceUnit: unit });
    expected.sessions += 1;
    expected.seconds += 1800;
    expected.kcal += 300;
    return isoLocal(startMs);
  };
  nullUnitStart = addUnknownDistance(6, null);
  blankUnitStart = addUnknownDistance(7, "");
});

afterAll(() => {
  // Never close the shared `@/db` handle (sibling suites may still be in the same module registry).
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("workout dedup rule", () => {
  test("one row per (type, start, end): the most complete row is chosen", () => {
    const history = queries.workoutHistory(2000);
    expect(history.length).toBe(expected.sessions);

    const byStart = new Map(history.map((row) => [row.startDate, row]));
    expect(byStart.size).toBe(history.length);
    expect(new Set(history.map((row) => sessionKey(row))).size).toBe(history.length);

    for (const start of firstWinsStarts) {
      expect(byStart.get(start)?.sourceName).toBe("iPhone");
    }
    for (const start of upgradedStarts) {
      const row = byStart.get(start);
      expect(row?.sourceName).toBe("Apple Watch");
      expect(row?.km).toBe(5);
      expect(row?.minutes).toBe(30);
    }

    // Raw rows outnumber deduped sessions because of the phone/watch pairs.
    const rawRows = (sqlite.prepare("SELECT COUNT(*) AS c FROM workouts").get() as { c: number }).c;
    expect(rawRows).toBeGreaterThan(expected.sessions);
  });

  test("totals count each session once, not once per source", () => {
    const all = queries.workoutTotalsAll();
    // The documented rule is one row per (type, start, end): count that key directly on the raw
    // table, so the assertion does not depend on which columns a display row chooses to expose.
    const distinctKeys = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT 1 FROM workouts
           GROUP BY workout_activity_type, start_date, end_date
         )`,
      )
      .get() as { c: number };
    expect(all.sessions).toBe(distinctKeys.c);
    expect(all.sessions).toBe(expected.sessions);
    expect(all.seconds).toBe(expected.seconds);
    expect(all.km).toBeCloseTo(expected.km, 2);
    expect(all.kcal).toBe(expected.kcal);

    const last30 = queries.workoutTotals(30);
    expect(last30.sessions).toBe(expected.sessions);
    expect(last30.minutes ?? 0).toBeCloseTo(expected.seconds / 60, 5);
    expect(last30.km ?? 0).toBeCloseTo(expected.km, 2);
    expect(last30.kcal).toBe(expected.kcal);

    const weekly = queries.weeklyTraining(26);
    expect(weekly.reduce((sum, week) => sum + week.sessions, 0)).toBe(expected.sessions);
    expect(weekly.reduce((sum, week) => sum + (week.minutes ?? 0), 0)).toBeCloseTo(expected.seconds / 60, 5);
    expect(weekly.reduce((sum, week) => sum + (week.km ?? 0), 0)).toBeCloseTo(expected.km, 2);

    const byType = queries.workoutTypeBreakdown(180);
    expect(byType.length).toBe(1);
    expect(byType[0].sessions).toBe(expected.sessions);
    expect(byType[0].km ?? 0).toBeCloseTo(expected.km, 2);

    const trend = queries.workoutTrend(180);
    expect(trend.length).toBe(expected.sessions);
    expect(trend.reduce((sum, point) => sum + (point.km ?? 0), 0)).toBeCloseTo(expected.km, 2);
  });

  test("distance units are normalised and unknown units stay unknown", () => {
    const history = queries.workoutHistory(2000);
    const byStart = new Map(history.map((row) => [row.startDate, row]));

    expect(byStart.get(meterStart)?.km).toBe(5);
    const mile = byStart.get(mileStart);
    expect(mile).toBeDefined();
    expect(mile?.km ?? Number.NaN).toBeCloseTo(5, 4);
    expect(mile?.paceMinPerKm ?? Number.NaN).toBeCloseTo(6, 3);

    for (const start of [unknownStart, nullUnitStart, blankUnitStart]) {
      const unknown = byStart.get(start);
      expect(unknown).toBeDefined();
      expect(unknown?.km).toBeNull();
      expect(unknown?.paceMinPerKm).toBeNull();
    }

    // Weekly summaries use workoutsBetween; the unknown raw numbers must not become km there.
    for (const start of [nullUnitStart, blankUnitStart]) {
      const d = start.slice(0, 10);
      const weekRows = queries.workoutsBetween(d, d);
      expect(weekRows.filter((row) => row.km === null)).toHaveLength(1);
    }
  });

  test("a midnight-crossing session stays on its start day and is counted once", () => {
    const history = queries.workoutHistory(2000);
    const row = history.find((item) => item.startDate === midnightStart);
    expect(row).toBeDefined();
    expect(row?.day).toBe(midnightDay);

    const sameKey = sqlite
      .prepare("SELECT COUNT(*) AS c FROM workouts WHERE start_date = ?")
      .get(midnightStart) as { c: number };
    expect(sameKey.c).toBe(1);
  });
});

describe("workout pagination", () => {
  test("pages cover every deduped row exactly once", () => {
    const total = queries.workoutTotalsAll().sessions;
    const rows: ReturnType<typeof queries.allWorkouts> = [];

    for (let offset = 0; offset < total; offset += PAGE_SIZE) {
      const page = queries.allWorkouts({ limit: PAGE_SIZE, offset });
      expect(page.length).toBe(Math.min(PAGE_SIZE, total - offset));
      rows.push(...page);
    }

    expect(rows.length).toBe(total);
    expect(new Set(rows.map((row) => dedupKey(row))).size).toBe(total);
    expect(queries.allWorkouts({ limit: PAGE_SIZE, offset: total }).length).toBe(0);

    // The paged list and the training list expose the same distance for the same session.
    const history = new Map(queries.workoutHistory(2000).map((row) => [row.startDate, row]));
    for (const row of rows) {
      expect(history.get(row.startDate)?.km).toBe(row.distanceKm);
    }
    for (const start of [nullUnitStart, blankUnitStart]) {
      expect(rows.find((row) => row.startDate === start)?.distanceKm).toBeNull();
    }
  });
});

describe("workout surfaces agree", () => {
  test("counts, context and training queries read the same deduped set", () => {
    const counts = queries.counts();
    const total = queries.workoutTotalsAll().sessions;
    expect(counts.workouts).toBe(total);
    expect(counts.lastWorkoutDay).toBe(today);

    const context = contextService.healthvaultContext();
    expect(context.data.counts.workouts).toBe(total);
    expect(context.data.lastWorkoutDay).toBe(today);
    expect(context.training.workouts.length).toBe(10);

    const firstPage = queries.allWorkouts({ limit: PAGE_SIZE, offset: 0 });
    const firstPageKeys = new Set(firstPage.map((row) => sessionKey(row)));
    for (const row of context.training.workouts) {
      expect(firstPageKeys.has(sessionKey(row))).toBe(true);
    }

    const history = queries.workoutHistory(2000);
    expect(context.training.workouts[0].startDate).toBe(history[0].startDate);

    const delta = queries.trendDelta(30);
    expect(delta.thisPeriod.sessions).toBe(total);
    expect(delta.lastPeriod.sessions).toBe(0);
    expect(delta.kmChangePct).toBeNull();
  });
});
