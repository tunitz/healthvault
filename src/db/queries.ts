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

export function sleepByDayStage(limit = 90) {
  return (sqlite.prepare(`
    SELECT day, value AS stage, SUM((end_ms - start_ms) / 3600000.0) AS hours
    FROM records
    WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND value > 0
    GROUP BY day, value ORDER BY day DESC LIMIT ?`)
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
           total_energy_burned_unit AS totalEnergyBurnedUnit, source_name AS sourceName,
           metadata_json AS metadataJson
    FROM workouts ORDER BY start_ms DESC LIMIT ?`).all(limit) as {
      type: string; day: string; startDate: string; endDate: string;
      durationSeconds: number | null; totalDistance: number | null; totalDistanceUnit: string | null;
      totalEnergyBurned: number | null; totalEnergyBurnedUnit: string | null;
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
    SELECT SUM((end_ms - start_ms) / 3600000.0) AS hours, COUNT(DISTINCT day) AS nights
    FROM records
    WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND value > 0
      AND day >= date('now', ?)`).get(`-${days} days`) as { hours: number | null; nights: number };
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
