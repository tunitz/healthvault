import {
  activitySummarySeries,
  activitySummaryTotals,
  sleepByDayStage,
  stepsDaily,
  workoutTotals,
  workoutTypeBreakdown,
  recentUploads,
} from "@/db/queries";
import { dailySeries, measurementSummary, weightTrend } from "@/lib/services/measurements";
import { weeklyAdherence } from "@/lib/services/supplements";
import type { HealthContext } from "@/lib/services/context";
import type { WidgetRange } from "@/lib/services/settings";
import { RANGE_DAYS } from "./registry";
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
  measurements: ReturnType<typeof dailySeries>;
  workoutTotals: ReturnType<typeof workoutTotals>;
  workoutTypes: ReturnType<typeof workoutTypeBreakdown>;
  adherence: ReturnType<typeof weeklyAdherence>;
};

export type DashboardData = {
  byRange: Record<string, RangeData>;
  attempts: UploadAttempt[];
  lastSuccess: UploadAttempt | null;
  measurements: ReturnType<typeof measurementSummary>;
};

/**
 * Read every widget's data once from the same queries used elsewhere in the app. The chosen
 * display never influences which data is read or how it is formatted.
 */
export function loadDashboardData(context: HealthContext, ranges: readonly WidgetRange[]): DashboardData {
  const byRange: Record<string, RangeData> = {};
  for (const range of [...new Set(ranges)]) {
    const days = RANGE_DAYS[range];
    const sleepRows = sleepByDayStage(days);
    byRange[range] = {
      days,
      activity: activitySummaryTotals(days),
      steps: stepsDaily(days),
      activitySeries: activitySummarySeries(days),
      sleepRows,
      sleepDuration: asleepHoursByNight(sleepRows),
      weight: weightTrend(days),
      measurements: dailySeries("weight", days),
      workoutTotals: workoutTotals(days),
      workoutTypes: workoutTypeBreakdown(days),
      adherence: weeklyAdherence(Math.max(1, Math.min(52, Math.round(days / 7)))),
    };
  }
  const attempts: UploadAttempt[] = recentUploads(20).map((row) => ({
    status: row.status,
    filename: row.filename,
    finishedAtMs: row.finishedAtMs,
    inserted: row.recordsInserted,
    createdAtMs: row.createdAtMs,
  }));
  return {
    byRange,
    attempts,
    lastSuccess: lastSuccessfulUpload(attempts),
    measurements: measurementSummary(),
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
