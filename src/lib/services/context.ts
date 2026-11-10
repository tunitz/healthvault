import { desc } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { uploads } from "@/db/schema";
import { addDays, localDay, localDayStartMs } from "@/lib/day";
import { counts, sleepSummary, stepsSummary, workoutHistory } from "@/db/queries";
import { dayNutrition, type DayNutrition } from "@/lib/services/nutrition";
import { latestMeasurement, weightTrend, type Point } from "@/lib/services/measurements";
import { ageOf, getProfile, getTimezone, isProfileStarted, workSchedule, type Profile } from "@/lib/services/profile";
import { nextSupplement, todayChecklist } from "@/lib/services/supplements";
import { fail } from "@/lib/validate";

export function currentDay(): string {
  return localDay(Date.now(), getTimezone());
}

export type MetricsName =
  | "steps"
  | "heart_rate"
  | "resting_heart_rate"
  | "vo2max"
  | "weight"
  | "sleep"
  | "active_energy";

const METRIC_TYPE: Record<Exclude<MetricsName, "weight" | "sleep" | "active_energy">, string> = {
  steps: "HKQuantityTypeIdentifierStepCount",
  heart_rate: "HKQuantityTypeIdentifierHeartRate",
  resting_heart_rate: "HKQuantityTypeIdentifierRestingHeartRate",
  vo2max: "HKQuantityTypeIdentifierVO2Max",
};

/**
 * Time-series for agents. Values are already single-source per day for the Apple metrics
 * (phone + watch overlap), and sleep is hours per night.
 */
export function metricsSeries(metric: unknown, days = 30): {
  metric: MetricsName;
  unit: string;
  points: { day: string; value: number; source?: string }[];
} {
  const name = String(metric ?? "") as MetricsName;
  const capped = Math.min(Math.max(1, Math.trunc(Number(days) || 30)), 730);
  const tz = getTimezone();
  const end = currentDay();
  const start = addDays(end, -(capped - 1));
  const startMs = localDayStartMs(start, tz);

  if (name === "weight") {
    return { metric: name, unit: "kg", points: weightTrend(capped).points.map((p) => ({ day: p.day, value: p.value, source: p.source })) };
  }

  if (name === "sleep") {
    const rows = sqlite
      .prepare(
        `WITH segments AS (
           SELECT CASE WHEN CAST(substr(start_date, 12, 2) AS INTEGER) < 12
                       THEN date(day, '-1 day') ELSE day END AS night,
                  SUM((end_ms - start_ms) / 3600000.0) AS hours
           FROM records
           WHERE type_identifier = 'HKCategoryTypeIdentifierSleepAnalysis'
             AND value IN (2, 4, 5, 6) AND start_ms >= ?
           GROUP BY night
         ) SELECT night AS day, hours AS value FROM segments WHERE night >= ? ORDER BY night`,
      )
      .all(startMs, start) as { day: string; value: number }[];
    return { metric: name, unit: "h", points: rows };
  }

  if (name === "active_energy") {
    const rows = sqlite
      .prepare(
        `SELECT day, SUM(active_energy_burned) AS value FROM activity_summaries
         WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`,
      )
      .all(start, end) as { day: string; value: number }[];
    return { metric: name, unit: "kcal", points: rows.filter((r) => r.value !== null) };
  }

  const typeIdentifier = METRIC_TYPE[name as keyof typeof METRIC_TYPE];
  if (!typeIdentifier) {
    fail(`metric must be one of: steps, heart_rate, resting_heart_rate, vo2max, weight, sleep, active_energy`);
  }
  // Same single-source-per-day rule as the Training page: never add phone and watch together.
  const rows = sqlite
    .prepare(
      `WITH perSource AS (
         SELECT day, source_name AS source, SUM(value) AS total, AVG(value) AS mean, COUNT(*) AS samples
         FROM records
         WHERE type_identifier = ? AND start_ms >= ?
         GROUP BY day, source_name
       ), ranked AS (
         SELECT day, source, total, mean, samples,
                ROW_NUMBER() OVER (PARTITION BY day ORDER BY samples DESC, total DESC) AS rk
         FROM perSource
       ) SELECT day, CASE WHEN ? = 'heart_rate' OR ? = 'resting_heart_rate' OR ? = 'vo2max' THEN mean ELSE total END AS value,
                source
         FROM ranked WHERE rk = 1 ORDER BY day`,
    )
    .all(typeIdentifier, startMs, name, name, name) as { day: string; value: number; source: string }[];
  const unit = name === "steps" ? "count" : name === "vo2max" ? "mL/min·kg" : "bpm";
  return { metric: name, unit, points: rows };
}

export type HealthContext = {
  generatedAt: string;
  today: string;
  timezone: string;
  profile: Profile & {
    age: number | null;
    started: boolean;
    workSchedule: ReturnType<typeof workSchedule>;
  };
  nutrition: DayNutrition;
  weight: { latest: Point | null; goalKg: number | null; change7dKg: number | null; points: Point[] };
  supplements: ReturnType<typeof todayChecklist>;
  nextSupplement: ReturnType<typeof nextSupplement>;
  training: {
    workouts: ReturnType<typeof workoutHistory>;
    steps: ReturnType<typeof stepsSummary>;
    sleep: ReturnType<typeof sleepSummary>;
  };
  data: {
    counts: ReturnType<typeof counts>;
    lastUpload: { filename: string; status: string; finishedAtMs: number | null; inserted: number } | null;
    lastRecordDay: string | null;
  };
};

/** Everything an agent should know before answering, so it never asks for stored facts. */
export function healthvaultContext(): HealthContext {
  const profile = getProfile();
  const tz = profile.timezone;
  const today = currentDay();
  const weight7 = weightTrend(7);
  const latestUpload = db
    .select({
      filename: uploads.filename,
      status: uploads.status,
      finishedAtMs: uploads.finishedAtMs,
      inserted: uploads.recordsInserted,
    })
    .from(uploads)
    .orderBy(desc(uploads.createdAtMs))
    .limit(1)
    .get();
  const lastRecord = sqlite
    .prepare("SELECT MAX(day) AS day FROM records")
    .get() as { day: string | null };

  return {
    generatedAt: new Date().toISOString(),
    today,
    timezone: tz,
    profile: {
      ...profile,
      workSchedule: workSchedule(profile),
      age: ageOf(profile, today),
      started: isProfileStarted(profile),
    },
    nutrition: dayNutrition(today),
    weight: {
      latest: latestMeasurement("weight"),
      goalKg: profile.goalWeightKg,
      change7dKg: weight7.changeKg,
      points: weight7.points,
    },
    supplements: todayChecklist(today),
    nextSupplement: nextSupplement(today),
    training: {
      workouts: workoutHistory(10),
      steps: stepsSummary(30),
      sleep: sleepSummary(30),
    },
    data: {
      counts: counts(),
      lastUpload: latestUpload ?? null,
      lastRecordDay: lastRecord?.day ?? null,
    },
  };
}
