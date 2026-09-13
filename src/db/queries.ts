import { sqlite } from "@/db";

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

export function dailyTotals(typeIdentifier: string, limit = 365) {
  return (sqlite.prepare(`
    SELECT day, SUM(value) AS total FROM records
    WHERE type_identifier = ? GROUP BY day ORDER BY day DESC LIMIT ?`)
    .all(typeIdentifier, limit) as { day: string; total: number }[]).reverse();
}

export function dailyAverages(typeIdentifier: string, limit = 365) {
  return (sqlite.prepare(`
    SELECT day, AVG(value) AS avg, COUNT(*) AS n FROM records
    WHERE type_identifier = ? GROUP BY day ORDER BY day DESC LIMIT ?`)
    .all(typeIdentifier, limit) as { day: string; avg: number; n: number }[]).reverse();
}

/** A sleep segment belongs to the night that started the previous evening: segments after
 * midnight are attributed back to their start day (Apple writes a night as several records).
 * InBed (1) is a superset of the asleep stages, so it is excluded everywhere it would be
 * added to a total: summing it with the asleep rows double-counts the night. */
const NIGHT = `CASE WHEN CAST(substr(start_date, 12, 2) AS INTEGER) < 12 THEN date(day, '-1 day') ELSE day END`;
const ASLEEP = "(value IN (2, 4, 5, 6))"; // Asleep*, Core, Deep, REM — InBed(1)/Awake(3) excluded

export function sleepByDayStage(limit = 90) {
  return (sqlite.prepare(`
    SELECT ${NIGHT} AS day, value AS stage, SUM((end_ms - start_ms) / 3600000.0) AS hours
    FROM records
    WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND value IN (2, 3, 4, 5, 6)
    GROUP BY ${NIGHT}, value ORDER BY day DESC LIMIT ?`)
    .all(limit) as { day: string; stage: number; hours: number }[]).reverse();
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

export function allWorkouts(limit = 500) {
  return sqlite.prepare(`
    SELECT workout_activity_type AS type, day, start_date AS startDate, end_date AS endDate,
           duration_seconds AS durationSeconds, total_distance AS totalDistance,
           total_distance_unit AS totalDistanceUnit, total_energy_burned AS totalEnergyBurned,
           total_energy_burned_unit AS totalEnergyBurnedUnit, avg_hr AS avgHr, min_hr AS minHr,
           max_hr AS maxHr, source_name AS sourceName, metadata_json AS metadataJson,
           CASE WHEN total_distance > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / total_distance END AS paceMinPerKm
    FROM workouts ORDER BY start_ms DESC LIMIT ?`).all(limit) as {
      type: string; day: string; startDate: string; endDate: string;
      durationSeconds: number | null; totalDistance: number | null; totalDistanceUnit: string | null;
      totalEnergyBurned: number | null; totalEnergyBurnedUnit: string | null;
      avgHr: number | null; minHr: number | null; maxHr: number | null; paceMinPerKm: number | null;
      sourceName: string | null; metadataJson: string | null;
    }[];
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
  return { records: one("records"), workouts: one("workouts"), summaries: one("activity_summaries"), uploads: one("uploads") };
}

export function stepsSummary(days = 30) {
  const row = sqlite.prepare(`
    SELECT COUNT(DISTINCT day) AS days, SUM(value) AS total, AVG(value) AS perRecord
    FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierStepCount'
      AND day >= date('now', ?)`).get(`-${days} days`) as { days: number; total: number | null; perRecord: number | null };
  const daily = dailyTotals("HKQuantityTypeIdentifierStepCount", days);
  const allTime = sqlite.prepare(`
    SELECT SUM(value) AS total FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierStepCount'`)
    .get() as { total: number | null };
  const avgPerDay = daily.length ? daily.reduce((a, d) => a + d.total, 0) / daily.length : 0;
  return { windowDays: days, days: row.days, totalInWindow: row.total ?? 0, avgPerDay, allTimeSteps: allTime.total ?? 0 };
}

export function sleepSummary(days = 30) {
  const row = sqlite.prepare(`
    SELECT SUM((end_ms - start_ms) / 3600000.0) AS hours, COUNT(DISTINCT ${NIGHT}) AS nights
    FROM records
    WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND ${ASLEEP}
      AND ${NIGHT} >= date('now', ?)`).get(`-${days} days`) as { hours: number | null; nights: number };
  const hours = row.hours ?? 0;
  return { windowDays: days, nights: row.nights, totalHours: hours, avgPerNight: row.nights ? hours / row.nights : 0 };
}

export function activitySummaryTotals(days = 30) {
  const row = sqlite.prepare(`
    SELECT SUM(active_energy_burned) AS energy, SUM(apple_exercise_time) AS exercise,
           SUM(apple_move_minutes) AS move, COUNT(*) AS days
    FROM activity_summaries WHERE day >= date('now', ?)`).get(`-${days} days`) as {
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
      FROM records WHERE type_identifier = ? AND day >= date('now', ?)
      GROUP BY day, source_name
    ), ranked AS (
      SELECT day, source, value,
             ROW_NUMBER() OVER (PARTITION BY day ORDER BY samples DESC, value DESC) AS rk
      FROM perSource
    )
    SELECT day, source, value FROM ranked WHERE rk = 1 ORDER BY day`).all(typeIdentifier, `-${days} days`) as DailyPoint[];
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

/** Newest first, with pace derived where a distance exists. */
export function workoutHistory(limit = 200): WorkoutRow[] {
  return sqlite.prepare(`
    SELECT day, start_date AS startDate, workout_activity_type AS type,
           duration_seconds / 60.0 AS minutes, total_distance AS km, total_energy_burned AS kcal,
           CASE WHEN total_distance > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / total_distance END AS paceMinPerKm,
           CASE WHEN total_distance > 0 AND duration_seconds > 0
                THEN total_distance / (duration_seconds / 3600.0) END AS speedKmh,
           avg_hr AS avgHr, min_hr AS minHr, max_hr AS maxHr, source_name AS sourceName
    FROM workouts ORDER BY start_ms DESC LIMIT ?`).all(limit) as WorkoutRow[];
}

/** Per-workout intensity over time — the "am I getting fitter" line (same pace, lower HR). */
export function workoutTrend(days = 180) {
  return sqlite.prepare(`
    SELECT day, total_distance AS km, duration_seconds / 60.0 AS minutes,
           avg_hr AS avgHr, max_hr AS maxHr,
           CASE WHEN total_distance > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / total_distance END AS paceMinPerKm
    FROM workouts
    WHERE day >= date('now', ?) AND workout_activity_type LIKE '%Running%'
    ORDER BY start_ms`).all(`-${days} days`) as {
      day: string; km: number | null; minutes: number; avgHr: number | null;
      maxHr: number | null; paceMinPerKm: number | null;
    }[];
}

/** Week-by-week volume: sessions, minutes, distance, average HR. */
export function weeklyTraining(weeks = 26) {
  return sqlite.prepare(`
    SELECT date(day, '-' || CAST(strftime('%w', day) AS INTEGER) || ' days') AS weekStart,
           date(day, '-' || CAST(strftime('%w', day) AS INTEGER) || ' days', '+6 days') AS weekEnd,
           COUNT(*) AS sessions,
           SUM(duration_seconds) / 60.0 AS minutes,
           SUM(total_distance) AS km,
           AVG(avg_hr) AS avgHr
    FROM workouts
    WHERE day >= date('now', ?)
    GROUP BY weekStart ORDER BY weekStart`).all(`-${weeks * 7} days`) as {
      weekStart: string; weekEnd: string; sessions: number; minutes: number | null;
      km: number | null; avgHr: number | null;
    }[];
}

export function workoutTotals(days = 30) {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS sessions, SUM(duration_seconds) / 60.0 AS minutes, SUM(total_distance) AS km,
           SUM(total_energy_burned) AS kcal, AVG(avg_hr) AS avgHr, MAX(max_hr) AS maxHr
    FROM workouts WHERE day >= date('now', ?)`).get(`-${days} days`) as {
      sessions: number; minutes: number | null; km: number | null; kcal: number | null;
      avgHr: number | null; maxHr: number | null };
  return { windowDays: days, ...row };
}

export function workoutTypeBreakdown(days = 180) {
  return sqlite.prepare(`
    SELECT workout_activity_type AS type, COUNT(*) AS sessions, SUM(duration_seconds) / 60.0 AS minutes,
           SUM(total_distance) AS km
    FROM workouts WHERE day >= date('now', ?)
    GROUP BY type ORDER BY sessions DESC`).all(`-${days} days`) as {
      type: string; sessions: number; minutes: number | null; km: number | null }[];
}

/** Change between the last 30 days and the 30 before it — direction of travel, not a snapshot. */
export function trendDelta(days = 30) {
  const half = (offset: number) =>
    sqlite.prepare(`
      SELECT COUNT(*) AS sessions, SUM(total_distance) AS km, AVG(avg_hr) AS avgHr,
             SUM(duration_seconds) / 60.0 AS minutes
      FROM workouts WHERE day >= date('now', ?) AND day < date('now', ?)`)
      .get(`-${offset + days} days`, `-${offset} days`) as {
        sessions: number; km: number | null; avgHr: number | null; minutes: number | null };
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
