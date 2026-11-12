/**
 * Manual strength log.
 *
 * A strength session is one local calendar day of sets. These rows are detail only: they never
 * create, mutate or add to an imported `workouts` row, and they are excluded from every workout
 * volume, duration and calorie total and from the nutrition budget. The imported workout stays
 * the single source of the actual session; `workoutId` only links a set to that same-day effort.
 *
 * Load is canonical kg. The UI converts to the profile's display unit; API/service payloads are
 * never converted.
 */
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { strengthSets, workouts } from "@/db/schema";
import { addDays, localDay, weekStart } from "@/lib/day";
import { getTimezone } from "@/lib/services/profile";
import { dayField, fail, idField, numField, str } from "@/lib/validate";

export type StrengthSet = typeof strengthSets.$inferSelect;

/** One quick-log request cannot create an unbounded number of rows. */
export const MAX_STRENGTH_SETS_PER_LOG = 100;

export type AddStrengthSetsInput = {
  /** Local day; defaults to today in the profile timezone. */
  day?: unknown;
  exercise: unknown;
  /** Array of `{ reps?, loadKg? }`; at least one of the two values is required per set. */
  sets: unknown;
  note?: unknown;
  /** Optional imported workout on the same day. Only links; never mutates the workout. */
  workoutId?: unknown;
};

function blank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * Append sets for one exercise on one day.
 *
 * `setNo` continues from the highest existing number for that `(day, exercise)` pair, so logging
 * the same lift later the same day never restarts at 1. Sets are inserted in one transaction so a
 * validation failure or a process error can never leave a partial session behind.
 */
export function addStrengthSets(input: AddStrengthSetsInput): StrengthSet[] {
  const tz = getTimezone();
  const day = blank(input.day) ? localDay(Date.now(), tz) : dayField(input.day, "day");
  const exercise = str(input.exercise, "exercise", { required: true, max: 120 })!;
  const note = str(input.note, "note", { max: 1000 });

  const rawSets = input.sets;
  if (!Array.isArray(rawSets) || rawSets.length === 0) {
    fail("sets must be a non-empty array");
  }
  if (rawSets.length > MAX_STRENGTH_SETS_PER_LOG) {
    fail(`sets must contain at most ${MAX_STRENGTH_SETS_PER_LOG} entries`);
  }

  const sets = rawSets.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(`sets[${index}] must be an object`);
    }
    const row = raw as Record<string, unknown>;
    const reps = numField(row.reps, `reps for set ${index + 1}`, { min: 0, max: 1000 });
    const loadKg = numField(row.loadKg, `loadKg for set ${index + 1}`, { min: 0, max: 1000 });
    // A blank row is not a set: with neither reps nor load there is nothing to record, and
    // inventing zeros would turn missing detail into a known value.
    if (reps === null && loadKg === null) fail(`set ${index + 1} needs reps or loadKg`);
    return { reps, loadKg };
  });

  let workoutId: number | null = null;
  if (!blank(input.workoutId)) {
    const linkedId = idField(input.workoutId, "workoutId");
    const workout = db
      .select({ id: workouts.id, day: workouts.day })
      .from(workouts)
      .where(eq(workouts.id, linkedId))
      .get();
    if (!workout) fail("workoutId does not match an imported workout", 404);
    if (workout.day !== day) fail("Linked workout must be on the set's day", 400);
    workoutId = linkedId;
  }

  const now = Date.now();
  return sqlite.transaction((): StrengthSet[] => {
    const previous = sqlite
      .prepare("SELECT COALESCE(MAX(set_no), 0) AS max FROM strength_sets WHERE day = ? AND exercise = ?")
      .get(day, exercise) as { max: number };

    return sets.map((set, index) =>
      db
        .insert(strengthSets)
        .values({
          day,
          exercise,
          setNo: previous.max + index + 1,
          reps: set.reps,
          loadKg: set.loadKg,
          note,
          workoutId,
          createdAtMs: now,
        })
        .returning()
        .get()!,
    );
  })();
}

/* ---------------------------------------------------------------------------------------------
 * Reading sessions and progression
 * ------------------------------------------------------------------------------------------- */

export type StrengthSessionExercise = {
  exercise: string;
  sets: number;
  topLoadKg: number | null;
  /** Sum of the reps that were recorded; a missing rep is not counted as zero detail. */
  reps: number;
  /** How many sets recorded reps. Zero means "not recorded", not "zero reps". */
  repsRecorded: number;
  /** Sum of reps × load for sets that recorded both; detail, never an exercise-calorie claim. */
  volumeKg: number;
  /** How many sets recorded both reps and load; zero means volume is unknown, not zero. */
  weightedSets: number;
};

export type StrengthSession = {
  day: string;
  sets: StrengthSet[];
  exercises: StrengthSessionExercise[];
  workoutIds: number[];
};

function clampDays(days: unknown, fallback: number, max: number): number {
  if (days === null || days === undefined || days === "") return fallback;
  const value = Number(days);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

/** Recent sessions, newest day first, each day grouped by exercise. */
export function listStrengthSessions(days = 14): StrengthSession[] {
  const capped = clampDays(days, 14, 366);
  const end = localDay(Date.now(), getTimezone());
  const start = addDays(end, -(capped - 1));

  const rows = db
    .select()
    .from(strengthSets)
    .where(and(gte(strengthSets.day, start), lte(strengthSets.day, end)))
    .orderBy(desc(strengthSets.day), asc(strengthSets.exercise), asc(strengthSets.setNo))
    .all();

  const byDay = new Map<string, StrengthSet[]>();
  for (const row of rows) {
    const bucket = byDay.get(row.day);
    if (bucket) bucket.push(row);
    else byDay.set(row.day, [row]);
  }

  return [...byDay.entries()].map(([day, daySets]) => {
    const byExercise = new Map<string, StrengthSet[]>();
    for (const set of daySets) {
      const bucket = byExercise.get(set.exercise);
      if (bucket) bucket.push(set);
      else byExercise.set(set.exercise, [set]);
    }

    const exercises = [...byExercise.entries()].map(([exercise, exerciseSets]) => {
      const loads = exerciseSets
        .map((set) => set.loadKg)
        .filter((load): load is number => load !== null);
      return {
        exercise,
        sets: exerciseSets.length,
        topLoadKg: loads.length ? Math.max(...loads) : null,
        reps: exerciseSets.reduce((total, set) => total + (set.reps ?? 0), 0),
        repsRecorded: exerciseSets.filter((set) => set.reps !== null).length,
        volumeKg: exerciseSets.reduce(
          (total, set) => total + (set.reps !== null && set.loadKg !== null ? set.reps * set.loadKg : 0),
          0,
        ),
        weightedSets: exerciseSets.filter((set) => set.reps !== null && set.loadKg !== null).length,
      };
    });

    const workoutIds = [...new Set(daySets.map((set) => set.workoutId))].filter(
      (id): id is number => id !== null,
    );

    return { day, sets: daySets, exercises, workoutIds };
  });
}

export type ProgressionWeek = {
  weekStart: string;
  weekEnd: string;
  sets: number;
  bestLoadKg: number | null;
  repsAtBest: number | null;
  /** Canonical kg: sum of reps × load for the sets that recorded both. */
  totalVolume: number;
  /** Sets that recorded both reps and load; zero means volume is unknown, not zero. */
  weightedSets: number;
};

/**
 * Week-by-week progression for one exercise, oldest week first (chart order).
 *
 * Sunday-start weeks, matching the rest of the app. Every week in the window is present, so an
 * empty week is an explicit zero rather than a gap the reader has to infer. `bestLoadKg` is the
 * heaviest recorded load; `repsAtBest` comes from the first set that reached it (day, then set
 * number), and `totalVolume` sums reps × load only where both were recorded.
 */
export function exerciseProgression(exercise: unknown, weeks = 8): ProgressionWeek[] {
  const name = str(exercise, "exercise", { required: true, max: 120 })!;
  const capped = clampDays(weeks, 8, 52);
  const today = localDay(Date.now(), getTimezone());
  const currentStart = weekStart(today);
  const firstStart = addDays(currentStart, -(capped - 1) * 7);
  const currentEnd = addDays(currentStart, 6);

  const rows = db
    .select()
    .from(strengthSets)
    .where(
      and(
        eq(strengthSets.exercise, name),
        gte(strengthSets.day, firstStart),
        lte(strengthSets.day, currentEnd),
      ),
    )
    .orderBy(asc(strengthSets.day), asc(strengthSets.setNo))
    .all();

  return Array.from({ length: capped }, (_, index) => {
    const start = addDays(firstStart, index * 7);
    const end = addDays(start, 6);
    const weekSets = rows.filter((set) => set.day >= start && set.day <= end);
    const loads = weekSets.map((set) => set.loadKg).filter((load): load is number => load !== null);
    const bestLoadKg = loads.length ? Math.max(...loads) : null;
    const bestSet = bestLoadKg === null ? null : weekSets.find((set) => set.loadKg === bestLoadKg);

    return {
      weekStart: start,
      weekEnd: end,
      sets: weekSets.length,
      bestLoadKg,
      repsAtBest: bestSet?.reps ?? null,
      totalVolume: weekSets.reduce(
        (total, set) => total + (set.reps !== null && set.loadKg !== null ? set.reps * set.loadKg : 0),
        0,
      ),
      weightedSets: weekSets.filter((set) => set.reps !== null && set.loadKg !== null).length,
    };
  });
}

/** Distinct exercises, most recently trained first. Backs the form datalist and the context. */
export function recentExercises(limit = 20): string[] {
  const capped = clampDays(limit, 20, 100);
  const rows = sqlite
    .prepare(
      `SELECT exercise FROM strength_sets
       GROUP BY exercise
       ORDER BY MAX(day) DESC, MAX(created_at_ms) DESC, exercise ASC
       LIMIT ?`,
    )
    .all(capped) as { exercise: string }[];
  return rows.map((row) => row.exercise);
}

export type StrengthContext = {
  /** Distinct local days with at least one logged set in the current Sunday-start week. */
  sessionsThisWeek: number;
  recentExercises: string[];
};

/** Compact strength state for `healthvaultContext()`; manual detail only, no volume credit. */
export function strengthContext(): StrengthContext {
  const today = localDay(Date.now(), getTimezone());
  const start = weekStart(today);
  const end = addDays(start, 6);
  const row = sqlite
    .prepare("SELECT COUNT(DISTINCT day) AS sessions FROM strength_sets WHERE day >= ? AND day <= ?")
    .get(start, end) as { sessions: number };
  return { sessionsThisWeek: row.sessions, recentExercises: recentExercises(10) };
}
