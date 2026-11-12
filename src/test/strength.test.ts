/**
 * Manual strength log on a scratch database.
 *
 * Covers per-day/per-exercise set numbering, input validation, same-day workout linking without
 * mutating the imported workout, recent-session grouping, the 8-week progression and the compact
 * context payload. The last suite proves manual detail never reaches workout totality, run volume
 * or the food log. Never reads real health data and never opens `data/health.db`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-strength-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";

let strength: typeof import("@/lib/services/strength");
let queries: typeof import("@/db/queries");
let contextService: typeof import("@/lib/services/context");
let training: typeof import("@/lib/services/training");
let profileService: typeof import("@/lib/services/profile");
let day: typeof import("@/lib/day");
let ValidationError: typeof import("@/lib/validate").ValidationError;
let sqlite: import("better-sqlite3").Database;
let insertWorkout: import("better-sqlite3").Statement<unknown[]>;

let today = "";
let currentStart = "";

/** Asia/Manila has a fixed +08:00 offset (no DST), so the fixture can spell ISO strings. */
function isoLocal(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
}

/** Insert one imported workout on `workoutDay` and return its id. */
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

function strengthRowCount(): number {
  return (sqlite.prepare("SELECT COUNT(*) AS c FROM strength_sets").get() as { c: number }).c;
}

beforeAll(async () => {
  strength = await import("@/lib/services/strength");
  queries = await import("@/db/queries");
  contextService = await import("@/lib/services/context");
  training = await import("@/lib/services/training");
  profileService = await import("@/lib/services/profile");
  day = await import("@/lib/day");
  ({ ValidationError } = await import("@/lib/validate"));
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
  today = day.localDay(Date.now(), TZ);
  currentStart = day.weekStart(today);

  insertWorkout = sqlite.prepare(`
    INSERT INTO workouts (
      workout_activity_type, start_date, start_ms, day, end_date, end_ms,
      duration_seconds, total_distance, total_distance_unit,
      total_energy_burned, total_energy_burned_unit, avg_hr, source_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM strength_sets").run();
  sqlite.prepare("DELETE FROM workouts").run();
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("addStrengthSets", () => {
  test("numbers sets per day and exercise, defaulting the day to today", () => {
    const first = strength.addStrengthSets({
      exercise: "Bench press",
      sets: [
        { reps: 8, loadKg: 60 },
        { reps: 8, loadKg: 62.5 },
      ],
    });
    expect(first.map((row) => row.setNo)).toEqual([1, 2]);
    expect(first.every((row) => row.day === today)).toBe(true);
    expect(first[0].loadKg).toBe(60);
    expect(first[1].loadKg).toBe(62.5);

    const second = strength.addStrengthSets({
      exercise: "Bench press",
      sets: [{ reps: 6, loadKg: 65 }],
    });
    expect(second[0].setNo).toBe(3);

    const otherExercise = strength.addStrengthSets({
      exercise: "Squat",
      sets: [{ reps: 5, loadKg: 80 }],
    });
    expect(otherExercise[0].setNo).toBe(1);

    const otherDay = strength.addStrengthSets({
      day: day.addDays(today, -1),
      exercise: "Bench press",
      sets: [{ reps: 5, loadKg: 60 }],
    });
    expect(otherDay[0].setNo).toBe(1);
    expect(otherDay[0].day).toBe(day.addDays(today, -1));
  });

  test("keeps a missing rep or load unknown rather than zero", () => {
    const rows = strength.addStrengthSets({
      exercise: "Pull-up",
      note: "bodyweight",
      sets: [{ reps: 8 }, { reps: 6, loadKg: null }, { loadKg: 10 }],
    });
    expect(rows.map((row) => row.reps)).toEqual([8, 6, null]);
    expect(rows.map((row) => row.loadKg)).toEqual([null, null, 10]);
    expect(rows.every((row) => row.note === "bodyweight")).toBe(true);
  });

  test("rejects invalid exercises, values and blank sets without writing anything", () => {
    expectValidation(
      () => strength.addStrengthSets({ exercise: "x".repeat(121), sets: [{ reps: 1 }] }),
      400,
      /at most 120/,
    );
    expectValidation(
      () => strength.addStrengthSets({ exercise: "Bench press", sets: [{ reps: 1_001 }] }),
      400,
      /≤ 1000/,
    );
    expectValidation(
      () => strength.addStrengthSets({ exercise: "Bench press", sets: [{ loadKg: -1 }] }),
      400,
      /≥ 0/,
    );
    expectValidation(
      () => strength.addStrengthSets({ exercise: "Bench press", sets: [] }),
      400,
      /non-empty/,
    );
    expectValidation(
      () => strength.addStrengthSets({ exercise: "Bench press", sets: [{}] }),
      400,
      /needs reps or loadKg/,
    );
    expectValidation(
      () => strength.addStrengthSets({ exercise: "   ", sets: [{ reps: 1 }] }),
      400,
      /exercise is required/,
    );
    expect(strengthRowCount()).toBe(0);
  });

  test("links a same-day imported workout without changing it", () => {
    const workoutId = addWorkout(today);
    const workoutBefore = sqlite.prepare("SELECT * FROM workouts WHERE id = ?").get(workoutId);
    const totalsBefore = queries.workoutTotalsAll();
    const workoutsBefore = queries.workoutsBetween(today, today);

    const rows = strength.addStrengthSets({
      exercise: "Deadlift",
      sets: [{ reps: 5, loadKg: 100 }],
      workoutId,
    });

    expect(rows[0].workoutId).toBe(workoutId);
    expect(queries.workoutTotalsAll()).toEqual(totalsBefore);
    expect(queries.workoutsBetween(today, today)).toEqual(workoutsBefore);
    expect(sqlite.prepare("SELECT * FROM workouts WHERE id = ?").get(workoutId)).toEqual(workoutBefore);
  });

  test("rejects a workout from another day or an unknown id", () => {
    const yesterdayWorkout = addWorkout(day.addDays(today, -1));

    expectValidation(
      () =>
        strength.addStrengthSets({
          exercise: "Deadlift",
          sets: [{ reps: 5 }],
          workoutId: yesterdayWorkout,
        }),
      400,
      /set's day/,
    );
    expectValidation(
      () =>
        strength.addStrengthSets({
          exercise: "Deadlift",
          sets: [{ reps: 5 }],
          workoutId: 99_999,
        }),
      404,
      /does not match an imported workout/,
    );
    expect(strengthRowCount()).toBe(0);
  });
});

describe("listStrengthSessions", () => {
  test("groups the recent window by day and separates exercises", () => {
    strength.addStrengthSets({
      day: today,
      exercise: "Bench press",
      sets: [
        { reps: 8, loadKg: 60 },
        { reps: 8, loadKg: 62.5 },
      ],
    });
    strength.addStrengthSets({ day: today, exercise: "Squat", sets: [{ reps: 5, loadKg: 80 }] });
    strength.addStrengthSets({
      day: day.addDays(today, -1),
      exercise: "Squat",
      sets: [
        { reps: 5, loadKg: 85 },
        { reps: 5, loadKg: 85 },
      ],
    });
    // Outside the 14-day window: must not appear.
    strength.addStrengthSets({
      day: day.addDays(today, -20),
      exercise: "Bench press",
      sets: [{ reps: 5, loadKg: 70 }],
    });

    const sessions = strength.listStrengthSessions(14);
    expect(sessions.map((session) => session.day)).toEqual([today, day.addDays(today, -1)]);
    expect(sessions[0].sets).toHaveLength(3);
    expect(sessions[0].exercises.map((item) => item.exercise)).toEqual(["Bench press", "Squat"]);

    const bench = sessions[0].exercises.find((item) => item.exercise === "Bench press")!;
    expect(bench).toMatchObject({
      sets: 2,
      topLoadKg: 62.5,
      reps: 16,
      repsRecorded: 2,
      volumeKg: 8 * 60 + 8 * 62.5,
      weightedSets: 2,
    });

    const squat = sessions[1].exercises[0];
    expect(squat).toMatchObject({ sets: 2, topLoadKg: 85, reps: 10, volumeKg: 850, weightedSets: 2 });

    expect(strength.listStrengthSessions(1)).toHaveLength(1);
  });
});

describe("exerciseProgression", () => {
  test("buckets by Sunday-start week with best load, reps at best and volume", () => {
    strength.addStrengthSets({
      day: currentStart,
      exercise: "Bench press",
      sets: [{ reps: 5, loadKg: 80 }],
    });
    strength.addStrengthSets({
      day: day.addDays(currentStart, 1),
      exercise: "Bench press",
      sets: [
        { reps: 5, loadKg: 85 },
        { reps: 3, loadKg: 90 },
      ],
    });
    strength.addStrengthSets({
      day: day.addDays(currentStart, -7),
      exercise: "Bench press",
      sets: [{ reps: 10, loadKg: 60 }],
    });
    // Another exercise and a set outside the 8-week window must not leak in.
    strength.addStrengthSets({ day: currentStart, exercise: "Squat", sets: [{ reps: 5, loadKg: 100 }] });
    strength.addStrengthSets({
      day: day.addDays(currentStart, -8 * 7),
      exercise: "Bench press",
      sets: [{ reps: 5, loadKg: 200 }],
    });

    const weeks = strength.exerciseProgression("Bench press", 8);
    expect(weeks).toHaveLength(8);
    expect(weeks[0].weekStart).toBe(day.addDays(currentStart, -7 * 7));
    expect(weeks[7].weekStart).toBe(currentStart);

    const current = weeks[7];
    expect(current.weekEnd).toBe(day.addDays(currentStart, 6));
    expect(current.sets).toBe(3);
    expect(current.bestLoadKg).toBe(90);
    expect(current.repsAtBest).toBe(3);
    expect(current.totalVolume).toBe(5 * 80 + 5 * 85 + 3 * 90);
    expect(current.weightedSets).toBe(3);

    const previous = weeks[6];
    expect(previous.sets).toBe(1);
    expect(previous.bestLoadKg).toBe(60);
    expect(previous.repsAtBest).toBe(10);
    expect(previous.totalVolume).toBe(600);

    const empty = weeks[3];
    expect(empty.sets).toBe(0);
    expect(empty.bestLoadKg).toBeNull();
    expect(empty.repsAtBest).toBeNull();
    expect(empty.totalVolume).toBe(0);
    expect(empty.weightedSets).toBe(0);
    expect(weeks.some((week) => week.bestLoadKg === 200)).toBe(false);
  });

  test("repsAtBest comes from the first set that reached the best load", () => {
    strength.addStrengthSets({
      day: currentStart,
      exercise: "Overhead press",
      sets: [
        { reps: 5, loadKg: 40 },
        { reps: 8, loadKg: 40 },
      ],
    });

    const [week] = strength.exerciseProgression("Overhead press", 1);
    expect(week.bestLoadKg).toBe(40);
    expect(week.repsAtBest).toBe(5);
  });
});

describe("recent exercises and context", () => {
  test("recent exercises are distinct and most recently trained first", () => {
    strength.addStrengthSets({
      day: day.addDays(today, -2),
      exercise: "Squat",
      sets: [{ reps: 5, loadKg: 80 }],
    });
    strength.addStrengthSets({ day: today, exercise: "Bench press", sets: [{ reps: 5, loadKg: 60 }] });
    strength.addStrengthSets({ day: today, exercise: "Bench press", sets: [{ reps: 5, loadKg: 65 }] });

    expect(strength.recentExercises(10)).toEqual(["Bench press", "Squat"]);
  });

  test("context counts distinct days this week and carries the recent exercises", () => {
    strength.addStrengthSets({ day: today, exercise: "Bench press", sets: [{ reps: 5, loadKg: 60 }] });
    strength.addStrengthSets({ day: today, exercise: "Squat", sets: [{ reps: 5, loadKg: 80 }] });
    if (currentStart !== today) {
      strength.addStrengthSets({
        day: currentStart,
        exercise: "Squat",
        sets: [{ reps: 5, loadKg: 80 }],
      });
    }

    const expectedDays = new Set([today, currentStart]).size;
    const compact = strength.strengthContext();
    expect(compact.sessionsThisWeek).toBe(expectedDays);
    expect(compact.recentExercises).toEqual(expect.arrayContaining(["Bench press", "Squat"]));

    expect(contextService.healthvaultContext().strength).toEqual(compact);
  });
});

describe("manual detail stays out of every total", () => {
  test("never changes workout totals, weekly run volume or the food log", () => {
    const workoutId = addWorkout(today);
    const totalsBefore = queries.workoutTotalsAll();
    const runsBefore = training.weeklySummary(0).runs;
    const foodBefore = (sqlite.prepare("SELECT COUNT(*) AS c FROM food_log").get() as { c: number }).c;

    strength.addStrengthSets({
      exercise: "Bench press",
      sets: [{ reps: 5, loadKg: 60 }],
      workoutId,
    });

    expect(queries.workoutTotalsAll()).toEqual(totalsBefore);
    expect(training.weeklySummary(0).runs).toEqual(runsBefore);
    expect(training.weeklySummary(0).strength).toEqual({
      appleSessions: 0,
      loggedSets: 1,
      exercises: 1,
    });
    expect((sqlite.prepare("SELECT COUNT(*) AS c FROM food_log").get() as { c: number }).c).toBe(foodBefore);
  });
});
