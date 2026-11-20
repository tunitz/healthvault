import {
  activitySummarySeries,
  activitySummaryTotals,
  sleepByDayStage,
  stepsDaily,
  workoutTotals,
  workoutTypeBreakdown,
  recentUploads,
} from "@/db/queries";
import { latestMeasurement, weightTrend, type Point } from "@/lib/services/measurements";
import { weeklyAdherence } from "@/lib/services/supplements";
import type { HealthContext } from "@/lib/services/context";
import type { WidgetRange } from "@/lib/services/settings";
import { RANGE_DAYS, type WidgetId, type WidgetPreference } from "./registry";
import { asleepHoursByNight, lastSuccessfulUpload, type UploadAttempt } from "./data";

export { asleepHoursByNight };

export type RangeData = {
  days: number;
  activity: ReturnType<typeof activitySummaryTotals>;
  steps: ReturnType<typeof stepsDaily>;
  activitySeries: ReturnType<typeof activitySummarySeries>;
  sleepRows: ReturnType<typeof sleepByDayStage>;
  sleepDuration: { day: string; value: number }[];
  weight: ReturnType<typeof weightTrend>;
  measurements: Point[];
  workoutTotals: ReturnType<typeof workoutTotals>;
  workoutTypes: ReturnType<typeof workoutTypeBreakdown>;
  adherence: ReturnType<typeof weeklyAdherence>;
};

export type DashboardData = {
  byRange: Record<string, RangeData>;
  attempts: UploadAttempt[];
  lastSuccess: UploadAttempt | null;
  measurements: {
    today: string;
    timezone: string;
    latestWeight: Point | null;
    latestBodyFat: Point | null;
    latestWaist: Point | null;
  };
};

const EMPTY_ACTIVITY_TOTALS = (days: number) => ({
  windowDays: days,
  energy: 0,
  exerciseMinutes: 0,
  moveMinutes: 0,
  days: 0,
});
const EMPTY_WORKOUT_TOTALS = (days: number) => ({
  windowDays: days,
  sessions: 0,
  minutes: null as number | null,
  km: null as number | null,
  kcal: null as number | null,
  avgHr: null as number | null,
  maxHr: null as number | null,
});

/**
 * Read every visible widget's data once from the same queries used elsewhere in the app.
 * Hidden widgets (`visible: false`) and already-loaded context fields are never re-queried.
 */
export function loadDashboardData(
  context: HealthContext,
  visibleWidgets: readonly { id: WidgetId; pref: WidgetPreference }[],
): DashboardData {
  const byRange: Record<string, RangeData> = {};
  const widgetsByRange = new Map<WidgetRange, Set<WidgetId>>();
  const visibleIds = new Set<WidgetId>();
  for (const { id, pref } of visibleWidgets) {
    visibleIds.add(id);
    const set = widgetsByRange.get(pref.range) ?? new Set<WidgetId>();
    set.add(id);
    widgetsByRange.set(pref.range, set);
  }

  for (const [range, ids] of widgetsByRange) {
    const days = RANGE_DAYS[range];
    const needActivity = ids.has("activity");
    const needSleep = ids.has("sleep");
    const needWeight = ids.has("weight") || ids.has("measurements");
    const needWorkouts = ids.has("workouts");
    const needSupplements = ids.has("supplements");

    const sleepRows = needSleep ? sleepByDayStage(days) : [];
    const weight = needWeight
      ? days === 7
        ? {
            points: context.weight.points,
            changeKg: context.weight.change7dKg,
            avgKg: context.weight.points.length
              ? context.weight.points.reduce((a, p) => a + p.value, 0) / context.weight.points.length
              : null,
          }
        : weightTrend(days)
      : { points: [], changeKg: null, avgKg: null };

    byRange[range] = {
      days,
      activity: needActivity ? activitySummaryTotals(days) : EMPTY_ACTIVITY_TOTALS(days),
      steps: needActivity ? stepsDaily(days) : [],
      activitySeries: needActivity ? activitySummarySeries(days) : [],
      sleepRows,
      sleepDuration: needSleep ? asleepHoursByNight(sleepRows) : [],
      weight,
      // `weightTrend(days).points` is already `dailySeries("weight", days)`; reuse it.
      measurements: weight.points,
      workoutTotals: needWorkouts ? workoutTotals(days) : EMPTY_WORKOUT_TOTALS(days),
      workoutTypes: needWorkouts ? workoutTypeBreakdown(days) : [],
      adherence: needSupplements ? weeklyAdherence(Math.max(1, Math.min(52, Math.round(days / 7)))) : [],
    };
  }

  const attempts: UploadAttempt[] = visibleIds.has("imports")
    ? recentUploads(20).map((row) => ({
        status: row.status,
        filename: row.filename,
        finishedAtMs: row.finishedAtMs,
        inserted: row.recordsInserted,
        createdAtMs: row.createdAtMs,
      }))
    : [];
  const needMeasurements = visibleIds.has("measurements");
  return {
    byRange,
    attempts,
    lastSuccess: lastSuccessfulUpload(attempts),
    measurements: {
      today: context.today,
      timezone: context.timezone,
      latestWeight: context.weight.latest,
      latestBodyFat: needMeasurements ? latestMeasurement("bodyFat") : null,
      latestWaist: needMeasurements ? latestMeasurement("waist") : null,
    },
  };
}

/** Context-only inputs for the empty-state decision (defect 2). */
export function dashboardContentInput(context: HealthContext) {
  return {
    records: context.data.counts.records,
    nutritionEntries: context.nutrition.entries.length,
    latestMeasurement:
      context.weight.latest !== null ||
      context.data.counts.workouts > 0,
    supplementLogs: context.supplements.taken,
    supplementsScheduled: context.supplements.total,
    uploads: context.data.counts.uploads,
  };
}
