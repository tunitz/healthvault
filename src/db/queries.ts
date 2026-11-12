import { addDays, localDay } from "@/lib/day";
import { getTimezone } from "@/lib/services/profile";
import { sqlite } from "@/db";

/** The local day `days - 1` before today, so a "last N days" window is exactly N days
 * inclusive of today (the old `-days` bound made every window one day too long). */
function windowStart(days: number): string {
  const n = Number.isFinite(days) && days >= 1 ? Math.trunc(days) : 1;
  return addDays(localDay(Date.now(), getTimezone()), -(n - 1));
}

export type TypeStat = {
  typeIdentifier: string; unit: string; count: number;
  firstDay: string; lastDay: string; sum: number; avg: number; max: number;
};

export function typeStats(): TypeStat[] {
  return sqlite.prepare(`
    SELECT type_identifier AS typeIdentifier, unit, COUNT(*) AS count,
           MIN(day) AS firstDay, MAX(day) AS lastDay,
           SUM(value) AS sum, AVG(value) AS avg, MAX(value) AS max
    FROM records GROUP BY type_identifier ORDER BY count DESC`).all() as TypeStat[];
}

/* `dailyTotals`/`dailyAverages` were removed: summing a quantity across devices double counts
 * phone+watch days. Use `stepsDaily`/`dailySeriesSingleSource` for anything a person reads. */

/** A sleep segment belongs to the night that started the previous evening: segments after
 * midnight are attributed back to their start day (Apple writes a night as several records).
 * InBed (1) is a superset of the asleep stages, so it is excluded everywhere it would be
 * added to a total: summing it with the asleep rows double-counts the night. */
const NIGHT = `CASE WHEN CAST(substr(start_date, 12, 2) AS INTEGER) < 12 THEN date(day, '-1 day') ELSE day END`;
const ASLEEP = "(value IN (2, 4, 5, 6))"; // Asleep*, Core, Deep, REM — InBed(1)/Awake(3) excluded

/** Newest `nights` nights, each with one row per stage. The LIMIT is on nights, not on
 * (night, stage) rows — the old query showed ~25 nights when 90 were asked for.
 *
 * The computed column is deliberately called `night`, not `day`: when an alias collides with
 * a real column, SQLite resolves GROUP BY/ORDER BY to the column, which split every
 * midnight-crossing night by calendar day. */
export function sleepByDayStage(nights = 90) {
  const capped = Number.isFinite(nights) && nights >= 1 ? Math.trunc(nights) : 90;
  return (sqlite.prepare(`
    WITH recent AS (
      SELECT ${NIGHT} AS night FROM records
      WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND value IN (2, 3, 4, 5, 6)
      GROUP BY night ORDER BY night DESC LIMIT ?
    ), staged AS (
      SELECT ${NIGHT} AS night, value AS stage, SUM((end_ms - start_ms) / 3600000.0) AS hours
      FROM records
      WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND value IN (2, 3, 4, 5, 6)
      GROUP BY night, value
    )
    SELECT staged.night AS day, staged.stage, staged.hours
    FROM staged JOIN recent ON recent.night = staged.night
    ORDER BY staged.night`)
    .all(capped) as { day: string; stage: number; hours: number }[]);
}

export function activitySummarySeries(limit = 180) {
  return (sqlite.prepare(`
    SELECT day, active_energy_burned AS activeEnergy, active_energy_burned_goal AS activeEnergyGoal,
           apple_move_minutes AS moveMinutes, apple_exercise_time AS exerciseTime,
           apple_stand_hours AS standHours
    FROM activity_summaries ORDER BY day DESC LIMIT ?`).all(limit) as {
      day: string; activeEnergy: number | null; activeEnergyGoal: number | null;
      moveMinutes: number | null; exerciseTime: number | null; standHours: number | null;
    }[]).reverse();
}

/** Any real Move-minute value at all. The metric is null in 776 of 777 real summaries, so the
 * dashboard must not render a permanent 0 for it. */
export function hasMoveMinutes(): boolean {
  return Boolean(
    sqlite.prepare("SELECT 1 AS x FROM activity_summaries WHERE apple_move_minutes IS NOT NULL LIMIT 1").get(),
  );
}

/**
 * Stored workout distance normalised to km, or NULL when the unit is not understood.
 *
 * `src/lib/xml.ts` converts supported units on ingest (`toKm`) and preserves unsupported units
 * as exported. NULL and blank units are also unknown: the session is still counted, but its
 * distance is NULL rather than being silently added as if it were kilometres.
 */
export const WORKOUT_DISTANCE_KM = `CASE
  WHEN total_distance IS NULL THEN NULL
  WHEN lower(trim(total_distance_unit)) = 'km' THEN total_distance
  WHEN lower(trim(total_distance_unit)) = 'mi' THEN total_distance * 1.609344
  WHEN lower(trim(total_distance_unit)) = 'm' THEN total_distance / 1000.0
  WHEN lower(trim(total_distance_unit)) = 'yd' THEN total_distance * 0.0009144
  WHEN lower(trim(total_distance_unit)) = 'ft' THEN total_distance * 0.0003048
  ELSE NULL
END`;

/* ---------------------------------------------------------------------------------------------
 * Workout reconciliation
 *
 * A workout can arrive once per recording device: an iPhone and an Apple Watch write the same
 * session as two rows with the same activity type and exact start/end timestamps. Apple's
 * per-source unique index keeps both, so every read below must reconcile them first.
 *
 * THE RULE: one row per `(workout_activity_type, start_date, end_date)`, choosing the most
 * complete row — a row with a normalised distance beats one without, then a row with a duration,
 * then the lowest id (stable across runs). This is the only reconciliation rule in the codebase;
 * changing it changes every workout surface, so it lives here once and nothing re-implements it.
 * ------------------------------------------------------------------------------------------- */

/**
 * CTE fragment: `WITH ${WORKOUT_DEDUP} SELECT … FROM deduped`.
 *
 * The alias `deduped` is part of the contract, and `rn` exists only to filter the chosen row.
 */
export const WORKOUT_DEDUP = `
  deduped AS (
    SELECT * FROM (
      SELECT w.*,
             ROW_NUMBER() OVER (
               PARTITION BY w.workout_activity_type, w.start_date, w.end_date
               ORDER BY ((${WORKOUT_DISTANCE_KM}) IS NOT NULL) DESC,
                        (w.duration_seconds IS NOT NULL) DESC,
                        w.id ASC
             ) AS rn
      FROM workouts w
    )
    WHERE rn = 1
  )`;

/** One page of the deduped workout list, newest first. The page size is capped at 500. */
export function allWorkouts({ limit = 500, offset = 0 }: { limit?: number; offset?: number } = {}) {
  const take = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 500) : 500;
  const skip = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT workout_activity_type AS type, day, start_date AS startDate, end_date AS endDate,
           duration_seconds AS durationSeconds, total_distance AS totalDistance,
           total_distance_unit AS totalDistanceUnit, ${WORKOUT_DISTANCE_KM} AS distanceKm,
           total_energy_burned AS totalEnergyBurned,
           total_energy_burned_unit AS totalEnergyBurnedUnit, avg_hr AS avgHr, min_hr AS minHr,
           max_hr AS maxHr, source_name AS sourceName, metadata_json AS metadataJson,
           CASE WHEN ${WORKOUT_DISTANCE_KM} > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / (${WORKOUT_DISTANCE_KM}) END AS paceMinPerKm
    FROM deduped ORDER BY start_ms DESC LIMIT ? OFFSET ?`).all(take, skip) as {
      type: string; day: string; startDate: string; endDate: string;
      durationSeconds: number | null; totalDistance: number | null; totalDistanceUnit: string | null;
      distanceKm: number | null;
      totalEnergyBurned: number | null; totalEnergyBurnedUnit: string | null;
      avgHr: number | null; minHr: number | null; maxHr: number | null; paceMinPerKm: number | null;
      sourceName: string | null; metadataJson: string | null;
    }[];
}

/** Newest local day with a deduped workout session; null when the table is empty. */
export function lastWorkoutDay(): string | null {
  const row = sqlite
    .prepare(`WITH ${WORKOUT_DEDUP} SELECT MAX(day) AS day FROM deduped`)
    .get() as { day: string | null };
  return row.day;
}

export function recordsForType(typeIdentifier: string, limit = 200) {
  return sqlite.prepare(`
    SELECT day, start_date AS startDate, end_date AS endDate, value, unit, source_name AS sourceName
    FROM records WHERE type_identifier = ? ORDER BY start_ms DESC LIMIT ?`)
    .all(typeIdentifier, limit) as {
      day: string; startDate: string; endDate: string; value: number; unit: string; sourceName: string;
    }[];
}

export function recentUploads(limit = 50) {
  return sqlite.prepare(`
    SELECT filename, bytes, status, records_inserted AS recordsInserted,
           records_duplicates AS recordsDuplicates, message,
           created_at_ms AS createdAtMs, finished_at_ms AS finishedAtMs
    FROM uploads ORDER BY created_at_ms DESC LIMIT ?`).all(limit) as {
      filename: string; bytes: number; status: string; recordsInserted: number;
      recordsDuplicates: number; message: string | null;
      createdAtMs: number; finishedAtMs: number | null;
    }[];
}

export function counts() {
  const one = (t: string) =>
    (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  // A "workout" here is a session, not an imported row: phone + watch duplicates must not make
  // the dashboard disagree with /workouts and the training totals.
  const workouts = sqlite
    .prepare(`WITH ${WORKOUT_DEDUP} SELECT COUNT(*) AS c, MAX(day) AS lastDay FROM deduped`)
    .get() as { c: number; lastDay: string | null };
  return {
    records: one("records"),
    workouts: workouts.c,
    summaries: one("activity_summaries"),
    uploads: one("uploads"),
    lastWorkoutDay: workouts.lastDay,
  };
}

export function stepsSummary(days = 30) {
  // `stepsDaily` already picks one source per day; summing `records.value` here was the
  // +42.7% inflation the audit found.
  const daily = stepsDaily(days);
  const total = daily.reduce((a, d) => a + d.value, 0);
  const allTime = sqlite.prepare(`
    WITH perSource AS (
      SELECT day, source_name AS source, SUM(value) AS total, COUNT(*) AS samples
      FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierStepCount'
      GROUP BY day, source_name
    ), ranked AS (
      SELECT day, total, ROW_NUMBER() OVER (PARTITION BY day ORDER BY samples DESC, total DESC) AS rk
      FROM perSource
    )
    SELECT SUM(total) AS total FROM ranked WHERE rk = 1`).get() as { total: number | null };
  return {
    windowDays: days,
    days: daily.length,
    totalInWindow: total,
    avgPerDay: daily.length ? total / daily.length : 0,
    allTimeSteps: allTime.total ?? 0,
  };
}

export function sleepSummary(days = 30) {
  const row = sqlite.prepare(`
    SELECT SUM((end_ms - start_ms) / 3600000.0) AS hours, COUNT(DISTINCT ${NIGHT}) AS nights
    FROM records
    WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND ${ASLEEP}
      AND ${NIGHT} >= ?`).get(windowStart(days)) as { hours: number | null; nights: number };
  const hours = row.hours ?? 0;
  return { windowDays: days, nights: row.nights, totalHours: hours, avgPerNight: row.nights ? hours / row.nights : 0 };
}

export function activitySummaryTotals(days = 30) {
  const row = sqlite.prepare(`
    SELECT SUM(active_energy_burned) AS energy, SUM(apple_exercise_time) AS exercise,
           SUM(apple_move_minutes) AS move, COUNT(*) AS days
    FROM activity_summaries WHERE day >= ?`).get(windowStart(days)) as {
      energy: number | null; exercise: number | null; move: number | null; days: number };
  return { windowDays: days, energy: row.energy ?? 0, exerciseMinutes: row.exercise ?? 0, moveMinutes: row.move ?? 0, days: row.days };
}

/* ---------------------------------------------------------------------------------------------
 * Training analytics
 *
 * Every quantity below is recorded by more than one device (phone + watch overlap in time), so
 * summing `value` across all records double counts. Each day is therefore read from ONE source:
 * the source with the most samples that day. The chosen source is returned so the UI can show
 * where a number came from instead of hiding it.
 * ------------------------------------------------------------------------------------------- */

export type DailyPoint = { day: string; value: number; source: string };

export function dailySeriesSingleSource(typeIdentifier: string, days = 90, agg: "sum" | "avg" = "sum"): DailyPoint[] {
  const fn = agg === "sum" ? "SUM(value)" : "AVG(value)";
  return sqlite.prepare(`
    WITH perSource AS (
      SELECT day, source_name AS source, ${fn} AS value, COUNT(*) AS samples
      FROM records WHERE type_identifier = ? AND day >= ?
      GROUP BY day, source_name
    ), ranked AS (
      SELECT day, source, value,
             ROW_NUMBER() OVER (PARTITION BY day ORDER BY samples DESC, value DESC) AS rk
      FROM perSource
    )
    SELECT day, source, value FROM ranked WHERE rk = 1 ORDER BY day`).all(typeIdentifier, windowStart(days)) as DailyPoint[];
}

export function stepsDaily(days = 90) {
  return dailySeriesSingleSource("HKQuantityTypeIdentifierStepCount", days, "sum");
}
export function heartRateDaily(days = 90) {
  return dailySeriesSingleSource("HKQuantityTypeIdentifierHeartRate", days, "avg");
}
export function restingHeartRateDaily(days = 180) {
  return dailySeriesSingleSource("HKQuantityTypeIdentifierRestingHeartRate", days, "avg");
}
export function vo2MaxDaily(days = 365) {
  return dailySeriesSingleSource("HKQuantityTypeIdentifierVO2Max", days, "avg");
}
export function walkingHrDaily(days = 180) {
  return dailySeriesSingleSource("HKQuantityTypeIdentifierWalkingHeartRateAverage", days, "avg");
}

/** Which devices contributed a type, so a suspicious number can be traced. */
export function sourceBreakdown(typeIdentifier: string) {
  return sqlite.prepare(`
    SELECT source_name AS source, COUNT(*) AS records, SUM(value) AS total, MIN(day) AS firstDay, MAX(day) AS lastDay
    FROM records WHERE type_identifier = ? GROUP BY source_name ORDER BY records DESC`)
    .all(typeIdentifier) as { source: string; records: number; total: number; firstDay: string; lastDay: string }[];
}

export type WorkoutRow = {
  day: string; startDate: string; type: string;
  minutes: number | null; km: number | null; kcal: number | null;
  paceMinPerKm: number | null; speedKmh: number | null;
  avgHr: number | null; minHr: number | null; maxHr: number | null;
  sourceName: string | null;
};

/** Newest first, with pace derived where a distance exists. Reads the deduped session set. */
export function workoutHistory(limit = 200): WorkoutRow[] {
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT day, start_date AS startDate, workout_activity_type AS type,
           duration_seconds / 60.0 AS minutes, ${WORKOUT_DISTANCE_KM} AS km,
           total_energy_burned AS kcal,
           CASE WHEN ${WORKOUT_DISTANCE_KM} > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / (${WORKOUT_DISTANCE_KM}) END AS paceMinPerKm,
           CASE WHEN ${WORKOUT_DISTANCE_KM} > 0 AND duration_seconds > 0
                THEN (${WORKOUT_DISTANCE_KM}) / (duration_seconds / 3600.0) END AS speedKmh,
           avg_hr AS avgHr, min_hr AS minHr, max_hr AS maxHr, source_name AS sourceName
    FROM deduped ORDER BY start_ms DESC LIMIT ?`).all(limit) as WorkoutRow[];
}

/** Per-workout intensity over time — the "am I getting fitter" line (same pace, lower HR). */
export function workoutTrend(days = 180) {
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT day, ${WORKOUT_DISTANCE_KM} AS km, duration_seconds / 60.0 AS minutes,
           avg_hr AS avgHr, max_hr AS maxHr,
           CASE WHEN ${WORKOUT_DISTANCE_KM} > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / (${WORKOUT_DISTANCE_KM}) END AS paceMinPerKm
    FROM deduped
    WHERE day >= ? AND workout_activity_type LIKE '%Running%'
    ORDER BY start_ms`).all(windowStart(days)) as {
      day: string; km: number | null; minutes: number; avgHr: number | null;
      maxHr: number | null; paceMinPerKm: number | null;
    }[];
}

/* ---------------------------------------------------------------------------------------------
 * 5K attempts
 *
 * Distances are the normalised `WORKOUT_DISTANCE_KM`, so a mile or metre row is compared in
 * kilometres and an unknown unit is excluded (NULL never passes BETWEEN). A 5K attempt is a
 * deduped running session between 4.9 and 5.5 km: shorter rows are time trials of another
 * distance, longer ones are not a 5K effort.
 * ------------------------------------------------------------------------------------------- */

/** Inclusive window that counts as a 5K attempt. */
export const FIVE_K_MIN_KM = 4.9;
export const FIVE_K_MAX_KM = 5.5;
/** A "best 5K" must be at least this long, so a fast 4.9 km row cannot win. */
export const FIVE_K_BEST_MIN_KM = 4.95;

export type FiveKAttempt = {
  day: string;
  km: number;
  seconds: number;
  paceMinPerKm: number;
};

/** Deduped running attempts in the last `days`, oldest first (chart order). */
export function fiveKAttempts(days = 365): FiveKAttempt[] {
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT day, ${WORKOUT_DISTANCE_KM} AS km, duration_seconds AS seconds,
           (duration_seconds / 60.0) / (${WORKOUT_DISTANCE_KM}) AS paceMinPerKm
    FROM deduped
    WHERE day >= ?
      AND workout_activity_type LIKE '%Running%'
      AND duration_seconds > 0
      AND ${WORKOUT_DISTANCE_KM} BETWEEN ${FIVE_K_MIN_KM} AND ${FIVE_K_MAX_KM}
    ORDER BY day, start_ms`).all(windowStart(days)) as FiveKAttempt[];
}

/**
 * The best attempt, or null when none qualifies.
 *
 * Rule: fastest pace wins; a tie on pace goes to the shorter duration (the row that spent less
 * time running the same pace), then the earlier day for a stable result. Attempts shorter than
 * `FIVE_K_BEST_MIN_KM` cannot be the best 5K even if their pace is faster.
 */
export function fiveKBest(days = 365): FiveKAttempt | null {
  let best: FiveKAttempt | null = null;
  for (const attempt of fiveKAttempts(days)) {
    if (attempt.km < FIVE_K_BEST_MIN_KM) continue;
    if (
      best === null ||
      attempt.paceMinPerKm < best.paceMinPerKm - 1e-9 ||
      (Math.abs(attempt.paceMinPerKm - best.paceMinPerKm) <= 1e-9 && attempt.seconds < best.seconds)
    ) {
      best = attempt;
    }
  }
  return best;
}

/** Week-by-week volume: sessions, minutes, distance, average HR. */
export function weeklyTraining(weeks = 26) {
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT date(day, '-' || CAST(strftime('%w', day) AS INTEGER) || ' days') AS weekStart,
           date(day, '-' || CAST(strftime('%w', day) AS INTEGER) || ' days', '+6 days') AS weekEnd,
           COUNT(*) AS sessions,
           SUM(duration_seconds) / 60.0 AS minutes,
           SUM(${WORKOUT_DISTANCE_KM}) AS km,
           AVG(avg_hr) AS avgHr
    FROM deduped
    WHERE day >= ?
    GROUP BY weekStart ORDER BY weekStart`).all(windowStart(weeks * 7)) as {
      weekStart: string; weekEnd: string; sessions: number; minutes: number | null;
      km: number | null; avgHr: number | null;
    }[];
}

export type DatedWorkout = {
  id: number; day: string; type: string; minutes: number | null; km: number | null; paceMinPerKm: number | null;
};

/** Deduped sessions whose start day falls in `[startDay, endDay]` (inclusive). The weekly
 * summary uses this instead of a rolling window so an arbitrary past week can be read. */
export function workoutsBetween(startDay: string, endDay: string): DatedWorkout[] {
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT id, day, workout_activity_type AS type, duration_seconds / 60.0 AS minutes,
           ${WORKOUT_DISTANCE_KM} AS km,
           CASE WHEN ${WORKOUT_DISTANCE_KM} > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / (${WORKOUT_DISTANCE_KM}) END AS paceMinPerKm
    FROM deduped
    WHERE day >= ? AND day <= ?
    ORDER BY day, start_ms`).all(startDay, endDay) as DatedWorkout[];
}

export function workoutTotals(days = 30) {
  const row = sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT COUNT(*) AS sessions, SUM(duration_seconds) / 60.0 AS minutes,
           SUM(${WORKOUT_DISTANCE_KM}) AS km,
           SUM(total_energy_burned) AS kcal, AVG(avg_hr) AS avgHr, MAX(max_hr) AS maxHr
    FROM deduped WHERE day >= ?`).get(windowStart(days)) as {
      sessions: number; minutes: number | null; km: number | null; kcal: number | null;
      avgHr: number | null; maxHr: number | null };
  return { windowDays: days, ...row };
}

/** Honest totals for the whole table, used by /workouts (which previously summed only the
 * 500 newest rows and counted phone/watch duplicates twice). */
export function workoutTotalsAll() {
  const row = sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT COUNT(*) AS sessions, SUM(duration_seconds) AS seconds,
           SUM(${WORKOUT_DISTANCE_KM}) AS km,
           SUM(total_energy_burned) AS kcal
    FROM deduped`).get() as { sessions: number; seconds: number | null; km: number | null; kcal: number | null };
  return { sessions: row.sessions, seconds: row.seconds ?? 0, km: row.km ?? 0, kcal: row.kcal ?? 0 };
}

export function workoutTypeBreakdown(days = 180) {
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT workout_activity_type AS type, COUNT(*) AS sessions,
           SUM(duration_seconds) / 60.0 AS minutes,
           SUM(${WORKOUT_DISTANCE_KM}) AS km
    FROM deduped WHERE day >= ?
    GROUP BY type ORDER BY sessions DESC`).all(windowStart(days)) as {
      type: string; sessions: number; minutes: number | null; km: number | null }[];
}

/** Change between the last 30 days and the 30 before it — direction of travel, not a snapshot. */
export function trendDelta(days = 30) {
  const end = localDay(Date.now(), getTimezone());
  const half = (offset: number) => {
    const stop = addDays(end, -offset);
    const start = addDays(stop, -(days - 1));
    return sqlite.prepare(`
      WITH ${WORKOUT_DEDUP}
      SELECT COUNT(*) AS sessions, SUM(${WORKOUT_DISTANCE_KM}) AS km, AVG(avg_hr) AS avgHr,
             SUM(duration_seconds) / 60.0 AS minutes
      FROM deduped WHERE day >= ? AND day <= ?`)
      .get(start, stop) as {
        sessions: number; km: number | null; avgHr: number | null; minutes: number | null };
  };
  const now = half(0);
  const before = half(days);
  const pct = (a: number | null, b: number | null) =>
    a === null || b === null || b === 0 ? null : ((a - b) / b) * 100;
  return {
    windowDays: days,
    thisPeriod: now,
    lastPeriod: before,
    kmChangePct: pct(now.km, before.km),
    minutesChangePct: pct(now.minutes, before.minutes),
    avgHrChange: now.avgHr !== null && before.avgHr !== null ? now.avgHr - before.avgHr : null,
  };
}
