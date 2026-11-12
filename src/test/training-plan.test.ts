/**
 * 16-week training block generation and planned-session lifecycle on a scratch database.
 *
 * Covers block shape/dates, the optional strength sessions, double-start refusal, status
 * transitions with same-day workout linking, planned-vs-imported separation, and starting a new
 * block after the previous one is finished. Never reads real health data or `data/health.db`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-training-plan-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";

let trainingPlan: typeof import("@/lib/services/training-plan");
let queries: typeof import("@/db/queries");
let profileService: typeof import("@/lib/services/profile");
let day: typeof import("@/lib/day");
let ValidationError: typeof import("@/lib/validate").ValidationError;
let sqlite: import("better-sqlite3").Database;
let insertWorkout: import("better-sqlite3").Statement<unknown[]>;

let today = "";
let thisMonday = "";

function isoLocal(ms: number): string {
  // Asia/Manila has a fixed +08:00 offset (no DST), so the fixture can spell ISO strings.
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
}

/** Insert one imported running workout on `workoutDay` and return its id. */
function addWorkout(workoutDay: string, km = 5, seconds = 1_500): number {
  const startMs = day.localTimeMs(workoutDay, "06:00", TZ);
  const endMs = startMs + seconds * 1_000;
  const info = insertWorkout.run(
    "HKWorkoutActivityTypeRunning",
    isoLocal(startMs),
    startMs,
    workoutDay,
    isoLocal(endMs),
    endMs,
    seconds,
    km,
    "km",
    300,
    "kcal",
    140,
    "iPhone",
  );
  return Number(info.lastInsertRowid);
}

function expectValidation(fn: () => unknown, status: number, pattern: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { status: number }).status).toBe(status);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected a ValidationError");
}

function plannedRows(): { id: number; day: string; week_no: number; kind: string; status: string }[] {
  return sqlite
    .prepare("SELECT id, day, week_no, kind, status FROM planned_sessions ORDER BY day, id")
    .all() as { id: number; day: string; week_no: number; kind: string; status: string }[];
}

beforeAll(async () => {
  trainingPlan = await import("@/lib/services/training-plan");
  queries = await import("@/db/queries");
  profileService = await import("@/lib/services/profile");
  day = await import("@/lib/day");
  ({ ValidationError } = await import("@/lib/validate"));
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
  today = day.localDay(Date.now(), TZ);
  // Monday of the current Sunday-start week. When today is Sunday this is tomorrow, which is
  // still a valid future start and keeps the fixture independent of the day the suite runs.
  thisMonday = day.addDays(day.weekStart(today), 1);

  insertWorkout = sqlite.prepare(`
    INSERT INTO workouts (
      workout_activity_type, start_date, start_ms, day, end_date, end_ms,
      duration_seconds, total_distance, total_distance_unit,
      total_energy_burned, total_energy_burned_unit, avg_hr, source_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM planned_sessions").run();
  sqlite.prepare("DELETE FROM workouts").run();
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("TRAINING_BLOCK", () => {
  test("encodes 16 weeks with Mon/Wed/Sat runs and optional Tue/Fri strength", () => {
    expect(trainingPlan.TRAINING_BLOCK).toHaveLength(16);
    for (const [index, week] of trainingPlan.TRAINING_BLOCK.entries()) {
      expect(week.weekNo).toBe(index + 1);
      const runs = week.sessions.filter((session) => session.kind !== "strength");
      expect(runs.map((session) => session.weekday)).toEqual([1, 3, 6]);
      const strengthDays = week.sessions
        .filter((session) => session.kind === "strength")
        .map((session) => session.weekday);
      expect(strengthDays).toEqual([2, 5]);
    }
  });

  test("uses the roadmap's quality progression", () => {
    for (const weekNo of [5, 6, 7, 8]) {
      const quality = trainingPlan.TRAINING_BLOCK[weekNo - 1].sessions.find(
        (session) => session.intent === "quality",
      );
      expect(quality?.title).toContain("6 × 2 min");
    }
    expect(
      trainingPlan.TRAINING_BLOCK[8].sessions.find((session) => session.intent === "quality")?.title,
    ).toContain("4 × 600 m");
    expect(
      trainingPlan.TRAINING_BLOCK[11].sessions.find((session) => session.intent === "quality")?.title,
    ).toContain("5 × 600 m");
    expect(
      trainingPlan.TRAINING_BLOCK[11].sessions.find((session) => session.intent === "quality")?.target
        ?.paceMinPerKm,
    ).toBe(6);
    for (const weekNo of [13, 14, 15]) {
      const quality = trainingPlan.TRAINING_BLOCK[weekNo - 1].sessions.find(
        (session) => session.intent === "quality",
      );
      expect(quality?.title).toContain("3 × 1 km");
      expect(quality?.target?.paceMinPerKm).toBe(6);
    }
  });

  test("week 16 reduces volume and ends with a 5K test", () => {
    const week = trainingPlan.TRAINING_BLOCK[15];
    expect(week.sessions).toHaveLength(5);
    const testSession = week.sessions.find((session) => session.kind === "test");
    expect(testSession).toBeDefined();
    expect(testSession!.weekday).toBe(6);
    expect(testSession!.target).toEqual({
      structure: "5K time trial at 6:00/km",
      distanceKm: 5,
      paceMinPerKm: 6,
    });
    expect(week.sessions.some((session) => session.intent === "quality")).toBe(false);
  });
});

describe("startBlock", () => {
  test("generates 16 weeks of runs on the right dates and week numbers", () => {
    const result = trainingPlan.startBlock(thisMonday);
    expect(result).toEqual({ blockStart: thisMonday, weeks: 16, sessions: 48 });

    const rows = plannedRows();
    expect(rows).toHaveLength(48);
    expect(rows[0].day).toBe(thisMonday);
    expect(rows.some((row) => row.kind === "strength")).toBe(false);

    const firstWeek = rows.filter((row) => row.week_no === 1);
    expect(firstWeek.map((row) => row.day)).toEqual([
      thisMonday,
      day.addDays(thisMonday, 2),
      day.addDays(thisMonday, 5),
    ]);

    const testSession = rows.find((row) => row.week_no === 16 && row.kind === "test");
    expect(testSession?.day).toBe(day.addDays(thisMonday, 15 * 7 + 5));
    expect(Math.max(...rows.map((row) => row.week_no))).toBe(16);
  });

  test("materialises Tue/Fri strength only when asked", () => {
    const result = trainingPlan.startBlock(thisMonday, { includeStrength: true });
    expect(result.sessions).toBe(80);

    const rows = plannedRows();
    expect(rows.filter((row) => row.kind === "strength")).toHaveLength(32);
    const firstWeekStrength = rows
      .filter((row) => row.week_no === 1 && row.kind === "strength")
      .map((row) => row.day);
    expect(firstWeekStrength).toEqual([
      day.addDays(thisMonday, 1),
      day.addDays(thisMonday, 4),
    ]);
  });

  test("refuses a non-Monday start and writes nothing", () => {
    expectValidation(() => trainingPlan.startBlock(day.addDays(thisMonday, 1)), 400, /Monday/);
    expect(plannedRows()).toHaveLength(0);
  });

  test("refuses a second block while the first still has planned sessions", () => {
    trainingPlan.startBlock(thisMonday);
    expectValidation(() => trainingPlan.startBlock(thisMonday), 409, /still in progress/);
    expectValidation(
      () => trainingPlan.startBlock(day.addDays(thisMonday, 7)),
      409,
      /still in progress/,
    );
    expect(plannedRows()).toHaveLength(48);
  });
});

describe("setSessionStatus", () => {
  test("moves between done, skipped and planned and manages the workout link", () => {
    trainingPlan.startBlock(thisMonday);
    const session = trainingPlan.currentBlock()!.thisWeek[0];
    const workoutId = addWorkout(session.day);
    const wrongDayWorkout = addWorkout(day.addDays(session.day, 1));

    const done = trainingPlan.setSessionStatus(session.id, "done", workoutId);
    expect(done.status).toBe("done");
    expect(done.workoutId).toBe(workoutId);

    expectValidation(
      () => trainingPlan.setSessionStatus(session.id, "done", wrongDayWorkout),
      400,
      /session's day/,
    );
    expect(trainingPlan.currentBlock()!.thisWeek[0].workoutId).toBe(workoutId);

    const skipped = trainingPlan.setSessionStatus(session.id, "skipped");
    expect(skipped.status).toBe("skipped");
    expect(skipped.workoutId).toBeNull();

    const reopened = trainingPlan.setSessionStatus(session.id, "planned");
    expect(reopened.status).toBe("planned");
    expect(reopened.workoutId).toBeNull();
  });

  test("rejects an unknown session, an invalid status and a link on a non-completed row", () => {
    trainingPlan.startBlock(thisMonday);
    const session = trainingPlan.currentBlock()!.thisWeek[0];
    const workoutId = addWorkout(session.day);

    expectValidation(
      () => trainingPlan.setSessionStatus(99_999, "done"),
      404,
      /Planned session not found/,
    );
    expectValidation(
      () => trainingPlan.setSessionStatus(session.id, "finished"),
      400,
      /status must be one of: planned, done, skipped/,
    );
    expectValidation(
      () => trainingPlan.setSessionStatus(session.id, "planned", workoutId),
      400,
      /only be linked to a completed session/,
    );
  });

  test("rejects a workout id that does not exist", () => {
    trainingPlan.startBlock(thisMonday);
    const session = trainingPlan.currentBlock()!.thisWeek[0];
    expectValidation(
      () => trainingPlan.setSessionStatus(session.id, "done", 99_999),
      404,
      /does not match an imported workout/,
    );
  });
});

describe("block state", () => {
  test("reports the current week, this week's sessions and the full outline", () => {
    trainingPlan.startBlock(thisMonday, { includeStrength: true });
    const state = trainingPlan.currentBlock();
    expect(state).not.toBeNull();
    expect(state!.blockStart).toBe(thisMonday);
    expect(state!.totalWeeks).toBe(16);
    expect(state!.currentWeekNo).toBe(1);
    expect(state!.weekStart).toBe(thisMonday);
    expect(state!.weekEnd).toBe(day.addDays(thisMonday, 6));
    expect(state!.weeks).toHaveLength(16);
    expect(state!.weeks[0].total).toBe(5);
    expect(state!.thisWeek).toHaveLength(5);
    expect(state!.finished).toBe(false);

    const testSession = state!.weeks[15].sessions.find((session) => session.kind === "test")!;
    const target = trainingPlan.sessionTarget(testSession);
    expect(target?.distanceKm).toBe(5);
    expect(target?.paceMinPerKm).toBe(6);
  });

  test("a finished block does not block the next one", () => {
    trainingPlan.startBlock(thisMonday);
    for (const row of plannedRows()) {
      trainingPlan.setSessionStatus(row.id, "skipped");
    }
    expect(trainingPlan.currentBlock()!.finished).toBe(true);

    const nextMonday = day.addDays(thisMonday, 16 * 7);
    const next = trainingPlan.startBlock(nextMonday);
    expect(next.blockStart).toBe(nextMonday);
    expect(trainingPlan.currentBlock()!.blockStart).toBe(nextMonday);
  });

  test("planned sessions never change workout totals", () => {
    addWorkout(thisMonday);
    const before = queries.workoutTotalsAll();
    trainingPlan.startBlock(thisMonday, { includeStrength: true });
    expect(queries.workoutTotalsAll()).toEqual(before);
    expect(queries.workoutsBetween(thisMonday, thisMonday)).toHaveLength(1);
  });
});

describe("nextMonday", () => {
  test("is strictly after today and is a Monday", () => {
    const next = trainingPlan.nextMonday(today);
    expect(day.weekdayIndex(next)).toBe(1);
    expect(day.daysBetween(today, next)).toBeGreaterThan(0);
    expect(day.daysBetween(today, next)).toBeLessThanOrEqual(7);
  });
});
