/**
 * Weekly training and recovery summary.
 *
 * One Sunday-start week (the same boundary as `weeklyTraining()` in `@/db/queries`), read from
 * the deduped workout set and the existing single-source-per-day series. Deliberately no
 * readiness score and no coupling to the nutrition budget: exercise calories never change a
 * food target, and every number below stays traceable to its own section.
 */
import { sqlite } from "@/db";
import {
  lastWorkoutDay,
  restingHeartRateDaily,
  sleepDailyHours,
  stepsDaily,
  workoutsBetween,
} from "@/db/queries";
import { addDays, localDay, weekStart } from "@/lib/day";
import { weightTrend } from "@/lib/services/measurements";
import { getTimezone } from "@/lib/services/profile";

/** The UI offers the current week and eight weeks back. */
export const MAX_WEEK_OFFSET = 8;

/** Same match as `workoutTrend`: any Apple activity whose identifier names Running. */
const RUNNING = "running";
/** Apple writes strength work as Functional/TraditionalStrengthTraining. */
const STRENGTH = "strength";

export type WeeklySummary = {
  weekStart: string;
  weekEnd: string;
  runs: { count: number; km: number; minutes: number; bestPaceMinPerKm: number | null };
  strength: { appleSessions: number; loggedSets: number; exercises: number };
  steps: { avgPerDay: number; daysWithData: number };
  sleep: { avgPerNight: number; nights: number };
  restingHr: { avg: number | null; latest: number | null; latestDay: string | null };
  weight: { avgKg: number | null; readings: number; changeKg: number | null; sparse: boolean };
  freshness: { lastRecordDay: string | null; lastWorkoutDay: string | null; stale: boolean };
  timezone: string;
};

function normalizeOffset(weekOffset: number): number {
  if (!Number.isFinite(weekOffset)) return 0;
  return Math.min(Math.max(0, Math.trunc(weekOffset)), MAX_WEEK_OFFSET);
}

/** Sum only the values that are known: an unknown distance stays out of the total rather than
 * being counted as zero kilometres. */
function sumKnown(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => (value === null ? total : total + value), 0);
}

export function weeklySummary(
  weekOffset = 0,
  prefetchedFreshness?: { lastRecordDay: string | null; lastWorkoutDay: string | null },
): WeeklySummary {
  const offset = normalizeOffset(weekOffset);
  const timezone = getTimezone();
  const today = localDay(Date.now(), timezone);
  const start = addDays(weekStart(today), -offset * 7);
  const end = addDays(start, 6);
  // Covers the whole displayed week plus the offset, using the existing rolling-window helpers.
  const spanDays = offset * 7 + 7;

  const workouts = workoutsBetween(start, end);
  const runRows = workouts.filter((w) => w.type.toLowerCase().includes(RUNNING));
  const paces = runRows.map((w) => w.paceMinPerKm).filter((v): v is number => v !== null);
  const strengthRows = workouts.filter((w) => w.type.toLowerCase().includes(STRENGTH));

  const logged = sqlite
    .prepare(
      `SELECT COUNT(*) AS sets, COUNT(DISTINCT exercise) AS exercises
       FROM strength_sets WHERE day >= ? AND day <= ?`,
    )
    .get(start, end) as { sets: number; exercises: number };

  const stepRows = stepsDaily(spanDays).filter((p) => p.day >= start && p.day <= end);
  const stepTotal = stepRows.reduce((total, p) => total + p.value, 0);

  const sleepRows = sleepDailyHours(start, end);
  const sleepTotal = sleepRows.reduce((total, row) => total + row.value, 0);

  const restingRows = restingHeartRateDaily(spanDays).filter((p) => p.day >= start && p.day <= end);
  const restingTotal = restingRows.reduce((total, p) => total + p.value, 0);

  // weightTrend is one reading per day, newest last, so the first/last pair is the week change.
  const weightPoints = weightTrend(spanDays).points.filter((p) => p.day >= start && p.day <= end);
  const weightTotal = weightPoints.reduce((total, p) => total + p.value, 0);
  const readings = weightPoints.length;

  // `stale` means the imported record data ends before the displayed week: a quiet week and a
  // missing export must not look the same. A missing record day counts as stale.
  const lastRecordDay = prefetchedFreshness
    ? prefetchedFreshness.lastRecordDay
    : ((sqlite.prepare("SELECT MAX(day) AS day FROM records").get() as { day: string | null }).day);
  const latestWorkoutDay = prefetchedFreshness ? prefetchedFreshness.lastWorkoutDay : lastWorkoutDay();

  return {
    weekStart: start,
    weekEnd: end,
    runs: {
      count: runRows.length,
      km: sumKnown(runRows.map((w) => w.km)),
      minutes: sumKnown(runRows.map((w) => w.minutes)),
      bestPaceMinPerKm: paces.length ? Math.min(...paces) : null,
    },
    strength: {
      appleSessions: strengthRows.length,
      loggedSets: logged.sets,
      exercises: logged.exercises,
    },
    steps: {
      avgPerDay: stepRows.length ? stepTotal / stepRows.length : 0,
      daysWithData: stepRows.length,
    },
    sleep: {
      avgPerNight: sleepRows.length ? sleepTotal / sleepRows.length : 0,
      nights: sleepRows.length,
    },
    restingHr: {
      avg: restingRows.length ? restingTotal / restingRows.length : null,
      latest: restingRows.at(-1)?.value ?? null,
      latestDay: restingRows.at(-1)?.day ?? null,
    },
    weight: {
      avgKg: readings ? weightTotal / readings : null,
      readings,
      changeKg: readings > 1 ? weightPoints[readings - 1].value - weightPoints[0].value : null,
      sparse: readings < 2,
    },
    freshness: {
      lastRecordDay,
      lastWorkoutDay: latestWorkoutDay,
      stale: lastRecordDay === null || lastRecordDay < start,
    },
    timezone,
  };
}
