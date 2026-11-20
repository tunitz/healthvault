import type { Statement } from "better-sqlite3";
import { addDays, localDay } from "@/lib/day";
import { getTimezone } from "@/lib/services/profile";
import { sqlite } from "@/db";

const stmtCache = new Map<string, Statement>();
function stmt(sql: string): Statement {
  let compiled = stmtCache.get(sql);
  if (!compiled) {
    compiled = sqlite.prepare(sql);
    stmtCache.set(sql, compiled);
  }
  return compiled;
}

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

let typeStatsCache: { version: string; rows: TypeStat[] } | null = null;
let allTimeStepsCache: { version: string; total: number } | null = null;
let recordsMutationSeq = 0;

/** Call after in-process bulk record writes so cached rollups invalidate immediately. */
export function invalidateRecordCaches(): void {
  recordsMutationSeq += 1;
  typeStatsCache = null;
  allTimeStepsCache = null;
}

function recordsVersion(): string {
  // O(1) B-tree seek + SQLite cross-connection data_version pragma (avoids 1M-row COUNT(*) scan).
  const dataVer = sqlite.pragma("data_version", { simple: true });
  // Separate scalar subqueries let SQLite use O(1) B-tree seeks for both MIN and MAX
  // (combining MIN(id) and MAX(id) in one SELECT forces a full index scan).
  const row = stmt(
    "SELECT COALESCE((SELECT MAX(id) FROM records), 0) AS m, COALESCE((SELECT MIN(id) FROM records), 0) AS n",
  ).get() as { m: number; n: number };
  return `${dataVer}:${recordsMutationSeq}:${row.n}:${row.m}`;
}

export function typeStats(): TypeStat[] {
  const version = recordsVersion();
  if (typeStatsCache && typeStatsCache.version === version) return typeStatsCache.rows;
  const rows = stmt(`
    SELECT type_identifier AS typeIdentifier, unit, COUNT(*) AS count,
           MIN(day) AS firstDay, MAX(day) AS lastDay,
           SUM(value) AS sum, AVG(value) AS avg, MAX(value) AS max
    FROM records GROUP BY type_identifier ORDER BY count DESC`).all() as TypeStat[];
  typeStatsCache = { version, rows };
  return rows;
}

/* `dailyTotals`/`dailyAverages` were removed: summing a quantity across devices double counts
 * phone+watch days. Use `stepsDaily`/`dailySeriesSingleSource` for anything a person reads. */

/** A sleep segment belongs to the night that started the previous evening: segments after
 * midnight are attributed back to their start day (Apple writes a night as several records).
 * InBed (1) is a superset of the asleep stages, so it is excluded everywhere it would be
 * added to a total: summing it with the asleep rows double-counts the night. */
const NIGHT = `CASE WHEN CAST(substr(start_date, 12, 2) AS INTEGER) < 12 THEN date(day, '-1 day') ELSE day END`;
const ASLEEP_STAGES = new Set([2, 4, 5, 6]);

type SleepSegmentRow = { night: string; source: string; stage: number; startMs: number; endMs: number };

function mergedDurationMs(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let curStart = intervals[0][0];
  let curEnd = intervals[0][1];
  for (let i = 1; i < intervals.length; i += 1) {
    const [s, e] = intervals[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += Math.max(0, curEnd - curStart);
      curStart = s;
      curEnd = e;
    }
  }
  total += Math.max(0, curEnd - curStart);
  return total;
}

/**
 * Deduplicate multi-source sleep records per night: pick one primary source per night
 * (preferring a stage-capable Watch source with Core/Deep/REM, then greatest asleep duration),
 * and merge overlapping `[startMs, endMs]` intervals per stage so overlapping samples never
 * double-count.
 */
function aggregateSleepNights(
  rows: SleepSegmentRow[],
): { day: string; stage: number; hours: number; source: string }[] {
  const byNight = new Map<string, Map<string, Map<number, [number, number][]>>>();
  for (const r of rows) {
    if (r.endMs <= r.startMs) continue;
    let sources = byNight.get(r.night);
    if (!sources) {
      sources = new Map();
      byNight.set(r.night, sources);
    }
    let stages = sources.get(r.source);
    if (!stages) {
      stages = new Map();
      sources.set(r.source, stages);
    }
    let list = stages.get(r.stage);
    if (!list) {
      list = [];
      stages.set(r.stage, list);
    }
    list.push([r.startMs, r.endMs]);
  }

  const out: { day: string; stage: number; hours: number; source: string }[] = [];
  const nights = [...byNight.keys()].sort();
  for (const night of nights) {
    const sources = byNight.get(night)!;
    let bestSource: string | null = null;
    let bestHasStages = false;
    let bestAsleepMs = -1;
    let bestStageMs: Map<number, number> | null = null;

    for (const [source, stages] of sources) {
      const hasStages = stages.has(4) || stages.has(5) || stages.has(6);
      const stageMs = new Map<number, number>();
      let asleepMs = 0;
      for (const [stage, intervals] of stages) {
        const ms = mergedDurationMs(intervals);
        stageMs.set(stage, ms);
        if (ASLEEP_STAGES.has(stage)) asleepMs += ms;
      }
      if (
        bestSource === null ||
        (hasStages && !bestHasStages) ||
        (hasStages === bestHasStages && asleepMs > bestAsleepMs) ||
        (hasStages === bestHasStages && asleepMs === bestAsleepMs && source < bestSource)
      ) {
        bestSource = source;
        bestHasStages = hasStages;
        bestAsleepMs = asleepMs;
        bestStageMs = stageMs;
      }
    }

    if (bestSource !== null && bestStageMs) {
      for (const [stage, ms] of bestStageMs) {
        if (ms > 0) out.push({ day: night, stage, hours: ms / 3_600_000, source: bestSource });
      }
    }
  }
  return out;
}

/** Newest `nights` nights, each with one row per stage, single-source and interval-deduped. */
export function sleepByDayStage(nights = 90) {
  const capped = Number.isFinite(nights) && nights >= 1 ? Math.trunc(nights) : 90;
  const recentNights = stmt(`
    SELECT DISTINCT ${NIGHT} AS night FROM records
    WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis' AND value IN (2, 3, 4, 5, 6)
    ORDER BY night DESC LIMIT ?`).all(capped) as { night: string }[];
  if (recentNights.length === 0) return [];
  const minNight = recentNights[recentNights.length - 1].night;
  const keep = new Set(recentNights.map((r) => r.night));
  const raw = stmt(`
    SELECT ${NIGHT} AS night, source_name AS source, value AS stage,
           start_ms AS startMs, end_ms AS endMs
    FROM records
    WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis'
      AND value IN (2, 3, 4, 5, 6)
      AND day >= ?`).all(minNight) as SleepSegmentRow[];
  return aggregateSleepNights(raw.filter((r) => keep.has(r.night))).map(({ day, stage, hours }) => ({
    day,
    stage,
    hours,
  }));
}

/** Single-source, interval-deduped asleep hours per night for `[startDay, endDay]` (inclusive). */
export function sleepDailyHours(startDay: string, endDay?: string): { day: string; value: number; source: string }[] {
  const upperDay = endDay ? addDays(endDay, 1) : null;
  const raw = (upperDay
    ? stmt(`
        SELECT ${NIGHT} AS night, source_name AS source, value AS stage,
               start_ms AS startMs, end_ms AS endMs
        FROM records
        WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis'
          AND value IN (2, 4, 5, 6)
          AND day >= ? AND day <= ?`).all(startDay, upperDay)
    : stmt(`
        SELECT ${NIGHT} AS night, source_name AS source, value AS stage,
               start_ms AS startMs, end_ms AS endMs
        FROM records
        WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis'
          AND value IN (2, 4, 5, 6)
          AND day >= ?`).all(startDay)) as SleepSegmentRow[];
  const filtered = raw.filter((r) => r.night >= startDay && (!endDay || r.night <= endDay));
  const staged = aggregateSleepNights(filtered);
  const byNight = new Map<string, { day: string; value: number; source: string }>();
  for (const row of staged) {
    if (!ASLEEP_STAGES.has(row.stage)) continue;
    const prev = byNight.get(row.day);
    if (prev) prev.value += row.hours;
    else byNight.set(row.day, { day: row.day, value: row.hours, source: row.source });
  }
  return [...byNight.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export type ActivitySeriesPoint = {
  day: string; activeEnergy: number | null; activeEnergyGoal: number | null;
  moveMinutes: number | null; exerciseTime: number | null; standHours: number | null;
};

/** Normalise Apple energy record units to kcal ("Cal" = kcal, lowercase "cal" = kcal/1000, "kJ" = *0.2390057). */
const RECORD_ENERGY_KCAL = `CASE
  WHEN trim(unit) = 'Cal' OR lower(trim(unit)) = 'kcal' THEN value
  WHEN lower(trim(unit)) = 'kj' THEN value * 0.2390057
  WHEN lower(trim(unit)) = 'cal' THEN value / 1000.0
  ELSE value
END`;

/**
 * Recent Apple exports contain the rings as ordinary quantity records but no ActivitySummary
 * elements at all. Derive the two metrics that exist in those records, using the same
 * one-source-per-day rule as every other device-overlapping series. Move and stand hours are
 * deliberately left null: AppleStandTime is elapsed minutes, not the distinct stand-hours count,
 * so inventing a value there would misrepresent the data.
 */
function activityFromRecords(days: number): ActivitySeriesPoint[] {
  const energy = dailySeriesSingleSource(
    "HKQuantityTypeIdentifierActiveEnergyBurned",
    days,
    "sum",
    RECORD_ENERGY_KCAL,
  );
  const exercise = dailySeriesSingleSource("HKQuantityTypeIdentifierAppleExerciseTime", days, "sum");
  const byDay = new Map<string, ActivitySeriesPoint>();
  for (const point of energy) {
    byDay.set(point.day, {
      day: point.day, activeEnergy: point.value, activeEnergyGoal: null,
      moveMinutes: null, exerciseTime: null, standHours: null,
    });
  }
  for (const point of exercise) {
    const row = byDay.get(point.day) ?? {
      day: point.day, activeEnergy: null, activeEnergyGoal: null,
      moveMinutes: null, exerciseTime: null, standHours: null,
    };
    row.exerciseTime = point.value;
    byDay.set(point.day, row);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Active energy per day in `[startDay, endDay]`, falling back to quantity records when ActivitySummary is absent. */
export function activeEnergyBetween(startDay: string, endDay: string): { day: string; value: number; source?: string }[] {
  const summaryRows = sqlite.prepare(`
    SELECT day, SUM(active_energy_burned) AS value
    FROM activity_summaries
    WHERE day >= ? AND day <= ?
    GROUP BY day ORDER BY day`).all(startDay, endDay) as { day: string; value: number | null }[];
  const validSummary = summaryRows.filter((r): r is { day: string; value: number } => r.value !== null);
  if (validSummary.length > 0) return validSummary;
  return sqlite.prepare(`
    WITH perSource AS (
      SELECT day, source_name AS source, SUM(${RECORD_ENERGY_KCAL}) AS value, COUNT(*) AS samples
      FROM records
      WHERE type_identifier = 'HKQuantityTypeIdentifierActiveEnergyBurned'
        AND day >= ? AND day <= ?
      GROUP BY day, source_name
    ), ranked AS (
      SELECT day, source, value,
             ROW_NUMBER() OVER (PARTITION BY day ORDER BY samples DESC, value DESC) AS rk
      FROM perSource
    )
    SELECT day, source, value FROM ranked WHERE rk = 1 ORDER BY day`).all(startDay, endDay) as DailyPoint[];
}

export function activitySummarySeries(limit = 180): ActivitySeriesPoint[] {
  const rows = sqlite.prepare(`
    SELECT day, active_energy_burned AS activeEnergy, active_energy_burned_goal AS activeEnergyGoal,
           apple_move_minutes AS moveMinutes, apple_exercise_time AS exerciseTime,
           apple_stand_hours AS standHours
    FROM activity_summaries ORDER BY day DESC LIMIT ?`).all(limit) as ActivitySeriesPoint[];
  // Summary rows stay authoritative whenever the export supplied them.
  if (rows.length) return rows.reverse();
  return activityFromRecords(limit);
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

export type WorkoutFilters = {
  type?: string;
  fromDay?: string;
  toDay?: string;
  source?: string;
  query?: string;
};

function buildWorkoutWhere(filters: WorkoutFilters = {}): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filters.type) {
    clauses.push("workout_activity_type = ?");
    args.push(filters.type);
  }
  if (filters.fromDay) {
    clauses.push("day >= ?");
    args.push(filters.fromDay);
  }
  if (filters.toDay) {
    clauses.push("day <= ?");
    args.push(filters.toDay);
  }
  if (filters.source) {
    clauses.push("source_name = ?");
    args.push(filters.source);
  }
  if (filters.query) {
    const q = `%${filters.query.trim().toLowerCase()}%`;
    clauses.push("(LOWER(workout_activity_type) LIKE ? OR LOWER(COALESCE(source_name, '')) LIKE ? OR day LIKE ?)");
    args.push(q, q, q);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", args };
}

/** One page of the deduped workout list, newest first. The page size is capped at 500. */
export function allWorkouts({
  limit = 500,
  offset = 0,
  ...filters
}: { limit?: number; offset?: number } & WorkoutFilters = {}) {
  const take = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 500) : 500;
  const skip = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
  const where = buildWorkoutWhere(filters);
  return sqlite.prepare(`
    WITH ${WORKOUT_DEDUP}
    SELECT deduped.id, workout_activity_type AS type, deduped.day, start_date AS startDate, end_date AS endDate,
           duration_seconds AS durationSeconds, total_distance AS totalDistance,
           total_distance_unit AS totalDistanceUnit, ${WORKOUT_DISTANCE_KM} AS distanceKm,
           total_energy_burned AS totalEnergyBurned,
           total_energy_burned_unit AS totalEnergyBurnedUnit, avg_hr AS avgHr, min_hr AS minHr,
           max_hr AS maxHr, source_name AS sourceName, metadata_json AS metadataJson,
           CASE WHEN ${WORKOUT_DISTANCE_KM} > 0 AND duration_seconds > 0
                THEN (duration_seconds / 60.0) / (${WORKOUT_DISTANCE_KM}) END AS paceMinPerKm,
           EXISTS(SELECT 1 FROM workout_routes r WHERE r.workout_id = deduped.id) AS hasRoute
    FROM deduped
    ${where.sql}
    ORDER BY start_ms DESC LIMIT ? OFFSET ?`).all(...where.args, take, skip) as {
      id: number; type: string; day: string; startDate: string; endDate: string;
      durationSeconds: number | null; totalDistance: number | null; totalDistanceUnit: string | null;
      distanceKm: number | null;
      totalEnergyBurned: number | null; totalEnergyBurnedUnit: string | null;
      avgHr: number | null; minHr: number | null; maxHr: number | null; paceMinPerKm: number | null;
      sourceName: string | null; metadataJson: string | null; hasRoute: number;
    }[];
}

export function countWorkouts(filters: WorkoutFilters = {}): number {
  const where = buildWorkoutWhere(filters);
  const row = sqlite
    .prepare(`WITH ${WORKOUT_DEDUP} SELECT COUNT(*) AS c FROM deduped ${where.sql}`)
    .get(...where.args) as { c: number };
  return row.c;
}

export function workoutFilterOptions(): { types: string[]; sources: string[] } {
  const types = (
    sqlite
      .prepare(`WITH ${WORKOUT_DEDUP} SELECT DISTINCT workout_activity_type AS v FROM deduped ORDER BY v`)
      .all() as { v: string }[]
  ).map((r) => r.v);
  const sources = (
    sqlite
      .prepare(`WITH ${WORKOUT_DEDUP} SELECT DISTINCT source_name AS v FROM deduped WHERE source_name IS NOT NULL AND source_name != '' ORDER BY v`)
      .all() as { v: string }[]
  ).map((r) => r.v);
  return { types, sources };
}

export type WorkoutRouteRow = {
  id: number;
  workoutId: number | null;
  filename: string;
  day: string;
  startMs: number;
  endMs: number;
  pointCount: number;
  distanceKm: number;
  elevationGainM: number;
  elevationLossM: number;
  polyline: [number, number, number?][];
  splits: { km: number; paceMinPerKm: number; eleDeltaM: number }[];
};

export function workoutDetail(id: number) {
  const workout = sqlite
    .prepare(`
      SELECT id, workout_activity_type AS type, day, start_date AS startDate, end_date AS endDate,
             start_ms AS startMs, end_ms AS endMs,
             duration_seconds AS durationSeconds, total_distance AS totalDistance,
             total_distance_unit AS totalDistanceUnit, ${WORKOUT_DISTANCE_KM} AS distanceKm,
             total_energy_burned AS totalEnergyBurned,
             total_energy_burned_unit AS totalEnergyBurnedUnit, avg_hr AS avgHr, min_hr AS minHr,
             max_hr AS maxHr, source_name AS sourceName, metadata_json AS metadataJson,
             CASE WHEN ${WORKOUT_DISTANCE_KM} > 0 AND duration_seconds > 0
                  THEN (duration_seconds / 60.0) / (${WORKOUT_DISTANCE_KM}) END AS paceMinPerKm
      FROM workouts WHERE id = ?`)
    .get(id) as
    | {
        id: number; type: string; day: string; startDate: string; endDate: string;
        startMs: number; endMs: number;
        durationSeconds: number | null; totalDistance: number | null; totalDistanceUnit: string | null;
        distanceKm: number | null; totalEnergyBurned: number | null; totalEnergyBurnedUnit: string | null;
        avgHr: number | null; minHr: number | null; maxHr: number | null; paceMinPerKm: number | null;
        sourceName: string | null; metadataJson: string | null;
      }
    | undefined;
  if (!workout) return null;

  const rawRoute = sqlite
    .prepare(`
      SELECT id, workout_id AS workoutId, filename, day, start_ms AS startMs, end_ms AS endMs,
             point_count AS pointCount, distance_km AS distanceKm,
             elevation_gain_m AS elevationGainM, elevation_loss_m AS elevationLossM,
             polyline_json AS polylineJson, splits_json AS splitsJson
      FROM workout_routes
      WHERE workout_id = ? OR (day = ? AND start_ms <= ? AND end_ms >= ?)
      ORDER BY (workout_id = ?) DESC, ABS(start_ms - ?) ASC
      LIMIT 1`)
    .get(id, workout.day, workout.endMs + 600_000, workout.startMs - 600_000, id, workout.startMs) as
    | (Omit<WorkoutRouteRow, "polyline" | "splits"> & { polylineJson: string; splitsJson: string })
    | undefined;

  let route: WorkoutRouteRow | null = null;
  if (rawRoute) {
    try {
      route = {
        id: rawRoute.id,
        workoutId: rawRoute.workoutId,
        filename: rawRoute.filename,
        day: rawRoute.day,
        startMs: rawRoute.startMs,
        endMs: rawRoute.endMs,
        pointCount: rawRoute.pointCount,
        distanceKm: rawRoute.distanceKm,
        elevationGainM: rawRoute.elevationGainM,
        elevationLossM: rawRoute.elevationLossM,
        polyline: JSON.parse(rawRoute.polylineJson) as [number, number, number?][],
        splits: JSON.parse(rawRoute.splitsJson) as { km: number; paceMinPerKm: number; eleDeltaM: number }[],
      };
    } catch {
      route = null;
    }
  }

  const strengthSets = sqlite
    .prepare(`
      SELECT id, day, exercise, set_no AS setNo, reps, load_kg AS loadKg, note
      FROM strength_sets
      WHERE workout_id = ?
      ORDER BY exercise, set_no`)
    .all(id) as {
      id: number; day: string; exercise: string; setNo: number;
      reps: number | null; loadKg: number | null; note: string | null;
    }[];

  const plannedSession = sqlite
    .prepare(`
      SELECT id, day, kind, intent, title, status, week_no AS weekNo, block_start AS blockStart
      FROM planned_sessions
      WHERE workout_id = ?
      LIMIT 1`)
    .get(id) as
    | {
        id: number; day: string; kind: string; intent: string | null;
        title: string; status: string; weekNo: number | null; blockStart: string | null;
      }
    | undefined;

  return { workout, route, strengthSets, plannedSession: plannedSession ?? null };
}

export type EcgRecordingRow = {
  id: number;
  filename: string;
  recordedAt: string;
  recordedAtMs: number;
  day: string;
  classification: string;
  avgHr: number | null;
  samplingHz: number;
  unit: string;
  sampleCount: number;
  samples: number[];
  symptoms: string | null;
  device: string | null;
};

export function listEcgRecordings(): EcgRecordingRow[] {
  const rows = sqlite
    .prepare(`
      SELECT id, filename, recorded_at AS recordedAt, recorded_at_ms AS recordedAtMs,
             day, classification, avg_hr AS avgHr, sampling_hz AS samplingHz,
             unit, sample_count AS sampleCount, samples_json AS samplesJson,
             symptoms, device
      FROM ecg_recordings
      ORDER BY recorded_at_ms DESC`)
    .all() as (Omit<EcgRecordingRow, "samples"> & { samplesJson: string })[];
  return rows.map((row) => {
    let samples: number[] = [];
    try {
      samples = JSON.parse(row.samplesJson) as number[];
    } catch {
      samples = [];
    }
    return {
      id: row.id,
      filename: row.filename,
      recordedAt: row.recordedAt,
      recordedAtMs: row.recordedAtMs,
      day: row.day,
      classification: row.classification,
      avgHr: row.avgHr,
      samplingHz: row.samplingHz,
      unit: row.unit,
      sampleCount: row.sampleCount,
      samples,
      symptoms: row.symptoms,
      device: row.device,
    };
  });
}

/** Newest local day with a deduped workout session; null when the table is empty. */
export function lastWorkoutDay(): string | null {
  const row = sqlite
    .prepare(`WITH ${WORKOUT_DEDUP} SELECT MAX(day) AS day FROM deduped`)
    .get() as { day: string | null };
  return row.day;
}

export type RecordFilters = {
  fromDay?: string;
  toDay?: string;
  source?: string;
};

export function recordsForType(typeIdentifier: string, limit = 200, filters: RecordFilters = {}) {
  const clauses = ["type_identifier = ?"];
  const args: unknown[] = [typeIdentifier];
  if (filters.fromDay) {
    clauses.push("day >= ?");
    args.push(filters.fromDay);
  }
  if (filters.toDay) {
    clauses.push("day <= ?");
    args.push(filters.toDay);
  }
  if (filters.source) {
    clauses.push("source_name = ?");
    args.push(filters.source);
  }
  const capped = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 2000) : 200;
  return sqlite.prepare(`
    SELECT day, start_date AS startDate, end_date AS endDate, value, unit, source_name AS sourceName
    FROM records WHERE ${clauses.join(" AND ")} ORDER BY start_ms DESC LIMIT ?`)
    .all(...args, capped) as {
      day: string; startDate: string; endDate: string; value: number; unit: string; sourceName: string;
    }[];
}

const CUMULATIVE_HINT = /(Count|Distance|EnergyBurned|Time|FlightsClimbed|Dietary|Water|Minutes)/i;

/** Single-source-per-day trend series for any numeric Apple Health record type in Explorer. */
export function explorerDailyTrend(
  typeIdentifier: string,
  filters: RecordFilters = {},
  maxDays = 180,
): { day: string; value: number; source: string }[] {
  if (typeIdentifier.startsWith("HKCategoryTypeIdentifier")) return [];
  const agg = CUMULATIVE_HINT.test(typeIdentifier) ? "SUM" : "AVG";
  const clauses = ["type_identifier = ?"];
  const args: unknown[] = [typeIdentifier];
  if (filters.fromDay) {
    clauses.push("day >= ?");
    args.push(filters.fromDay);
  }
  if (filters.toDay) {
    clauses.push("day <= ?");
    args.push(filters.toDay);
  }
  if (filters.source) {
    clauses.push("source_name = ?");
    args.push(filters.source);
  }
  const rows = sqlite
    .prepare(`
      WITH perSource AS (
        SELECT day, source_name AS source, ${agg}(value) AS val, COUNT(*) AS samples
        FROM records
        WHERE ${clauses.join(" AND ")}
        GROUP BY day, source_name
      ), ranked AS (
        SELECT day, source, val,
               ROW_NUMBER() OVER (PARTITION BY day ORDER BY samples DESC, val DESC) AS rk
        FROM perSource
      )
      SELECT day, ROUND(val, 2) AS value, source
      FROM ranked
      WHERE rk = 1
      ORDER BY day DESC
      LIMIT ?`)
    .all(...args, maxDays) as { day: string; value: number; source: string }[];
  return rows.reverse();
}

export function explorerSources(typeIdentifier: string): string[] {
  const rows = sqlite
    .prepare(`
      SELECT DISTINCT source_name AS source
      FROM records
      WHERE type_identifier = ? AND source_name != ''
      ORDER BY source_name`)
    .all(typeIdentifier) as { source: string }[];
  return rows.map((r) => r.source);
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
  const version = recordsVersion();
  let allTimeTotal: number;
  if (allTimeStepsCache && allTimeStepsCache.version === version) {
    allTimeTotal = allTimeStepsCache.total;
  } else {
    const allTime = stmt(`
      WITH perSource AS (
        SELECT day, source_name AS source, SUM(value) AS total, COUNT(*) AS samples
        FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierStepCount'
        GROUP BY day, source_name
      ), ranked AS (
        SELECT day, total, ROW_NUMBER() OVER (PARTITION BY day ORDER BY samples DESC, total DESC) AS rk
        FROM perSource
      )
      SELECT SUM(total) AS total FROM ranked WHERE rk = 1`).get() as { total: number | null };
    allTimeTotal = allTime.total ?? 0;
    allTimeStepsCache = { version, total: allTimeTotal };
  }
  return {
    windowDays: days,
    days: daily.length,
    totalInWindow: total,
    avgPerDay: daily.length ? total / daily.length : 0,
    allTimeSteps: allTimeTotal,
  };
}

export function sleepSummary(days = 30) {
  const nights = sleepDailyHours(windowStart(days));
  const hours = nights.reduce((sum, n) => sum + n.value, 0);
  return {
    windowDays: days,
    nights: nights.length,
    totalHours: hours,
    avgPerNight: nights.length ? hours / nights.length : 0,
  };
}

export function activitySummaryTotals(days = 30) {
  const row = sqlite.prepare(`
    SELECT SUM(active_energy_burned) AS energy, SUM(apple_exercise_time) AS exercise,
           SUM(apple_move_minutes) AS move, COUNT(*) AS days
    FROM activity_summaries WHERE day >= ?`).get(windowStart(days)) as {
      energy: number | null; exercise: number | null; move: number | null; days: number };
  if (row.days > 0) {
    return { windowDays: days, energy: row.energy ?? 0, exerciseMinutes: row.exercise ?? 0, moveMinutes: row.move ?? 0, days: row.days };
  }
  // No ActivitySummary rows in this export: derive from the underlying quantity records so the
  // dashboard does not report a permanent zero while the energy/exercise data is present.
  const derived = activityFromRecords(days);
  return {
    windowDays: days,
    energy: derived.reduce((sum, day) => sum + (day.activeEnergy ?? 0), 0),
    exerciseMinutes: derived.reduce((sum, day) => sum + (day.exerciseTime ?? 0), 0),
    moveMinutes: 0,
    days: derived.length,
  };
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

export function dailySeriesSingleSource(
  typeIdentifier: string,
  days = 90,
  agg: "sum" | "avg" = "sum",
  valueExpr = "value",
): DailyPoint[] {
  const fn = agg === "sum" ? `SUM(${valueExpr})` : `AVG(${valueExpr})`;
  return stmt(`
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
/** Pick the best qualifying 5K attempt from an already-fetched attempts array. */
export function pickBestFiveK(attempts: readonly FiveKAttempt[]): FiveKAttempt | null {
  let best: FiveKAttempt | null = null;
  for (const attempt of attempts) {
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

export function fiveKBest(days = 365): FiveKAttempt | null {
  return pickBestFiveK(fiveKAttempts(days));
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
