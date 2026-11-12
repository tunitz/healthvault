/**
 * 5K attempt queries on a scratch database.
 *
 * Covers the 4.9–5.5 km attempt window, the 4.95 km best-attempt gate, the pace tie-break
 * (shorter duration), unit normalisation, the dedup rule and the goal default. Never reads
 * real health data and never opens `data/health.db`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-five-k-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";

let queries: typeof import("@/db/queries");
let profileService: typeof import("@/lib/services/profile");
let day: typeof import("@/lib/day");
let sqlite: import("better-sqlite3").Database;
let insert: import("better-sqlite3").Statement<unknown[]>;
let today = "";

type InsertOptions = {
  unit?: string | null;
  type?: string;
  source?: string;
  time?: string;
};

function isoLocal(ms: number): string {
  // Asia/Manila has a fixed +08:00 offset (no DST), so the fixture can spell ISO strings.
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
}

/** Insert one workout `offsetDays` before today; returns its local day. */
function workout(offsetDays: number, km: number | null, seconds: number, options: InsertOptions = {}): string {
  const d = day.addDays(today, -offsetDays);
  const startMs = day.localTimeMs(d, options.time ?? "06:00", TZ);
  const endMs = startMs + seconds * 1_000;
  insert.run(
    options.type ?? "HKWorkoutActivityTypeRunning",
    isoLocal(startMs),
    startMs,
    d,
    isoLocal(endMs),
    endMs,
    seconds,
    km,
    options.unit === undefined ? (km === null ? null : "km") : options.unit,
    300,
    "kcal",
    140,
    options.source ?? "iPhone",
  );
  return d;
}

beforeAll(async () => {
  queries = await import("@/db/queries");
  profileService = await import("@/lib/services/profile");
  day = await import("@/lib/day");
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
  today = day.localDay(Date.now(), TZ);

  insert = sqlite.prepare(`
    INSERT INTO workouts (
      workout_activity_type, start_date, start_ms, day, end_date, end_ms,
      duration_seconds, total_distance, total_distance_unit,
      total_energy_burned, total_energy_burned_unit, avg_hr, source_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // In-window attempts: 4.9 (in), 4.95 (in), 5.0 (in), 5.5 (in); 4.89 is below the window.
  workout(10, 4.89, 1_500);
  workout(11, 4.9, 1_450);
  workout(12, 4.95, 1_485);
  workout(13, 5, 1_500);
  workout(14, 5.5, 1_650);

  // Out of window: 5.51 km, unknown/missing units, a non-running session, an old attempt.
  workout(15, 5.51, 1_660);
  workout(16, 5, 1_500, { unit: "furlong" });
  workout(17, 5, 1_500, { type: "HKWorkoutActivityTypeCycling" });
  workout(18, 5, 1_500, { unit: null });
  workout(19, 5, 1_500, { unit: "" });
  workout(400, 5, 1_500);

  // Phone + watch duplicate of one 5 km session: the complete row must be the only attempt.
  workout(20, 5, 1_500, { source: "iPhone" });
  workout(20, null, 1_500, { source: "Apple Watch" });

  // A mile row is compared after normalisation (3.10685596 mi = 5 km).
  workout(21, 5 / 1.609344, 1_500, { unit: "mi" });
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("fiveKAttempts", () => {
  test("accepts 4.9–5.5 km inclusive and rejects either side", () => {
    const days = queries.fiveKAttempts().map((attempt) => attempt.day);
    expect(days).not.toContain(day.addDays(today, -10)); // 4.89 km
    expect(days).toContain(day.addDays(today, -11)); // 4.9 km
    expect(days).toContain(day.addDays(today, -12)); // 4.95 km
    expect(days).toContain(day.addDays(today, -14)); // 5.5 km
    expect(days).not.toContain(day.addDays(today, -15)); // 5.51 km
    expect(days).not.toContain(day.addDays(today, -16)); // unknown unit
    expect(days).not.toContain(day.addDays(today, -17)); // cycling
    expect(days).not.toContain(day.addDays(today, -18)); // NULL unit
    expect(days).not.toContain(day.addDays(today, -19)); // blank unit
    expect(days).not.toContain(day.addDays(today, -400)); // outside 365 days
  });

  test("returns oldest first and one row per deduped session", () => {
    const attempts = queries.fiveKAttempts();
    const days = attempts.map((attempt) => attempt.day);
    expect(days).toEqual([...days].sort());
    // 6 qualifying sessions: 4.9, 4.95, 5.0, 5.5 plus the duplicate's complete row and the mile.
    expect(attempts).toHaveLength(6);
    expect(attempts.filter((attempt) => attempt.day === day.addDays(today, -20))).toHaveLength(1);
  });

  test("normalises a mile distance into kilometres", () => {
    const mile = queries.fiveKAttempts().find((attempt) => attempt.day === day.addDays(today, -21));
    expect(mile).toBeDefined();
    expect(mile!.km).toBeCloseTo(5, 3);
    expect(mile!.paceMinPerKm).toBeCloseTo(5, 3);
  });

  test("computes pace from duration and the normalised distance", () => {
    const attempt = queries.fiveKAttempts().find((row) => row.day === day.addDays(today, -12));
    expect(attempt).toBeDefined();
    expect(attempt!.seconds).toBe(1_485);
    expect(attempt!.paceMinPerKm).toBeCloseTo(1_485 / 60 / 4.95, 5);
  });

  test("the days window moves the lower bound", () => {
    expect(queries.fiveKAttempts(15)).toHaveLength(4);
  });
});

describe("fiveKBest", () => {
  test("ignores attempts shorter than 4.95 km even when their pace is faster", () => {
    const shortest = queries.fiveKAttempts().find((attempt) => attempt.day === day.addDays(today, -11));
    expect(shortest!.seconds).toBe(1_450); // the fastest row by pace, but 4.9 km
    expect(queries.fiveKBest()?.seconds).not.toBe(1_450);
  });

  test("a pace tie goes to the shorter duration", () => {
    const best = queries.fiveKBest();
    expect(best).not.toBeNull();
    expect(best!.km).toBeCloseTo(4.95, 5);
    expect(best!.seconds).toBe(1_485);
    expect(best!.paceMinPerKm).toBeCloseTo(5, 5);
  });

  test("returns null when the range has no qualifying attempt", () => {
    expect(queries.fiveKBest(1)).toBeNull();
  });
});

describe("goal defaults", () => {
  test("an unconfigured profile is sub-30:00 at 6:00 min/km", () => {
    const goal = profileService.trainingGoal(profileService.getProfile());
    expect(goal).toEqual({
      type: "run5k",
      targetSeconds: 1_800,
      targetPaceMinPerKm: 6,
      configured: false,
    });
  });

  test("an explicit target keeps its derived pace", () => {
    const saved = profileService.updateProfile({ goal: { type: "run5k", targetSeconds: 1_710 } });
    expect(profileService.trainingGoal(saved)).toEqual({
      type: "run5k",
      targetSeconds: 1_710,
      targetPaceMinPerKm: 5.7,
      configured: true,
    });
  });
});
