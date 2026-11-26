import { desc } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { uploads } from "@/db/schema";
import { addDays, localDay, localDayStartMs } from "@/lib/day";
import {
  activeEnergyBetween,
  counts,
  sleepDailyHours,
  sleepSummary,
  stepsSummary,
  workoutHistory,
} from "@/db/queries";
import { dayNutrition, type DayNutrition } from "@/lib/services/nutrition";
import { latestMeasurement, weightTrend, type Point } from "@/lib/services/measurements";
import { ageOf, getProfile, getTimezone, isProfileStarted, parseWheyLink, trainingGoal, workSchedule, type Profile } from "@/lib/services/profile";
import { nextSupplement, todayChecklist } from "@/lib/services/supplements";
import { strengthContext } from "@/lib/services/strength";
import { weeklySummary } from "@/lib/services/training";
import { currentBlock, sessionTarget, type SessionTarget } from "@/lib/services/training-plan";
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
    return { metric: name, unit: "h", points: sleepDailyHours(start, end) };
  }

  if (name === "active_energy") {
    return { metric: name, unit: "kcal", points: activeEnergyBetween(start, end) };
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
    /** Parsed 5K goal with the sub-30:00 default; `configured` says whether it was saved. */
    goal: ReturnType<typeof trainingGoal>;
    /** Parsed one-tap whey target, null until configured. */
    wheyLink: ReturnType<typeof parseWheyLink>;
  };
  nutrition: DayNutrition;
  weight: { latest: Point | null; goalKg: number | null; change7dKg: number | null; points: Point[] };
  supplements: ReturnType<typeof todayChecklist>;
  nextSupplement: ReturnType<typeof nextSupplement>;
  /** Manual set detail: never a workout, distance or calorie credit. */
  strength: ReturnType<typeof strengthContext>;
  training: {
    workouts: ReturnType<typeof workoutHistory>;
    steps: ReturnType<typeof stepsSummary>;
    sleep: ReturnType<typeof sleepSummary>;
    /** Compact current-week summary; no readiness score and no nutrition coupling. */
    weekly: ReturnType<typeof weeklySummary>;
    /** Active 16-week 5K training block summary, or null when no block is active. */
    activeBlock: {
      blockStart: string;
      currentWeekNo: number;
      totalWeeks: number;
      finished: boolean;
      thisWeek: {
        id: number;
        day: string;
        kind: string;
        intent: string | null;
        title: string;
        status: string;
        workoutId: number | null;
        target: SessionTarget | null;
      }[];
    } | null;
  };
  data: {
    counts: ReturnType<typeof counts>;
    lastUpload: { filename: string; status: string; finishedAtMs: number | null; inserted: number } | null;
    lastRecordDay: string | null;
    lastWorkoutDay: string | null;
  };
};

/** Selectable parts of the context blob. `strength` rides with `training`; `nextSupplement`
 * rides with `supplements`; `generatedAt`/`timezone` ride with `today`. */
export const CONTEXT_SECTIONS = [
  "today",
  "profile",
  "nutrition",
  "weight",
  "supplements",
  "training",
  "data",
] as const;
export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

const SECTION_KEYS: Record<ContextSection, readonly (keyof HealthContext)[]> = {
  today: ["generatedAt", "today", "timezone"],
  profile: ["profile"],
  nutrition: ["nutrition"],
  weight: ["weight"],
  supplements: ["supplements", "nextSupplement"],
  training: ["training", "strength"],
  data: ["data"],
};

/**
 * Restrict a full context to the requested sections. Omitted/empty sections, or a list with no
 * recognised names, return the full context unchanged. Unknown names are otherwise ignored.
 */
export function selectContextSections(
  full: HealthContext,
  sections: readonly unknown[] | undefined,
): Partial<HealthContext> {
  if (!sections || sections.length === 0) return full;
  const keys = new Set<keyof HealthContext>();
  for (const section of sections) {
    const mapped = SECTION_KEYS[section as ContextSection];
    if (mapped) for (const key of mapped) keys.add(key);
  }
  if (keys.size === 0) return full;
  const result: Partial<HealthContext> = {};
  for (const key of keys) {
    (result as Record<string, unknown>)[key] = full[key];
  }
  return result;
}

/** The newest local day present in each Apple import table, without loading the full context. */
export function dataFreshness(): { lastRecordDay: string | null; lastWorkoutDay: string | null } {
  const lastRecord = sqlite
    .prepare("SELECT MAX(day) AS day FROM records")
    .get() as { day: string | null };
  const lastWorkout = sqlite
    .prepare("SELECT MAX(day) AS day FROM workouts")
    .get() as { day: string | null };
  return { lastRecordDay: lastRecord?.day ?? null, lastWorkoutDay: lastWorkout?.day ?? null };
}

function resolveRequestedSections(sections?: readonly unknown[]): Set<ContextSection> {
  if (!sections || sections.length === 0) return new Set(CONTEXT_SECTIONS);
  const requested = new Set<ContextSection>();
  for (const section of sections) {
    if ((CONTEXT_SECTIONS as readonly unknown[]).includes(section)) {
      requested.add(section as ContextSection);
    }
  }
  return requested.size === 0 ? new Set(CONTEXT_SECTIONS) : requested;
}

/** Everything an agent should know before answering, so it never asks for stored facts.
 * Pass `sections` to return only those parts; omitting it keeps the full contract. */
export function healthvaultContext(): HealthContext;
export function healthvaultContext(sections: readonly unknown[] | undefined): Partial<HealthContext>;
export function healthvaultContext(sections?: readonly unknown[]): Partial<HealthContext> {
  const requested = resolveRequestedSections(sections);
  const needsProfile =
    requested.has("today") ||
    requested.has("profile") ||
    requested.has("nutrition") ||
    requested.has("weight") ||
    requested.has("supplements") ||
    requested.has("training");
  const profile = needsProfile ? getProfile() : null;
  const tz = profile ? profile.timezone : getTimezone();
  const today = localDay(Date.now(), tz);

  let freshCache: { lastRecordDay: string | null; lastWorkoutDay: string | null } | null = null;
  const getFresh = () => (freshCache ??= dataFreshness());

  const result: Partial<HealthContext> = {};

  if (requested.has("today")) {
    result.generatedAt = new Date().toISOString();
    result.today = today;
    result.timezone = tz;
  }

  if (requested.has("profile") && profile) {
    result.profile = {
      ...profile,
      workSchedule: workSchedule(profile),
      goal: trainingGoal(profile),
      wheyLink: parseWheyLink(profile),
      age: ageOf(profile, today),
      started: isProfileStarted(profile),
    };
  }

  if (requested.has("nutrition")) {
    result.nutrition = dayNutrition(today);
  }

  if (requested.has("weight") && profile) {
    const weight7 = weightTrend(7);
    result.weight = {
      latest: latestMeasurement("weight"),
      goalKg: profile.goalWeightKg,
      change7dKg: weight7.changeKg,
      points: weight7.points,
    };
  }

  if (requested.has("supplements")) {
    const checklist = todayChecklist(today);
    result.supplements = checklist;
    result.nextSupplement = nextSupplement(today, Date.now(), checklist);
  }

  if (requested.has("training")) {
    result.strength = strengthContext();
    const block = currentBlock();
    result.training = {
      workouts: workoutHistory(10),
      steps: stepsSummary(30),
      sleep: sleepSummary(30),
      weekly: weeklySummary(0, getFresh()),
      activeBlock: block
        ? {
            blockStart: block.blockStart,
            currentWeekNo: block.currentWeekNo,
            totalWeeks: block.totalWeeks,
            finished: block.finished,
            thisWeek: block.thisWeek.map((s) => ({
              id: s.id,
              day: s.day,
              kind: s.kind,
              intent: s.intent,
              title: s.title,
              status: s.status,
              workoutId: s.workoutId,
              target: sessionTarget(s),
            })),
          }
        : null,
    };
  }

  if (requested.has("data")) {
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
    const fresh = getFresh();
    result.data = {
      counts: counts(),
      lastUpload: latestUpload ?? null,
      lastRecordDay: fresh.lastRecordDay,
      lastWorkoutDay: fresh.lastWorkoutDay,
    };
  }

  return result;
}
