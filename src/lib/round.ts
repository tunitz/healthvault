/**
 * Consistent numeric rounding for agent-facing responses and computed aggregates.
 *
 * Prevents 15-digit IEEE-754 mantissas (e.g. `72.30000000000001` or `18.333333333333332`)
 * while matching the documented contract: whole kcal/sodium/steps where appropriate,
 * 1 decimal for kg/km/hours/percent, and never more than 2 decimals on computed floats.
 */

export function round0(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function round1(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundNullable(value: number | null, decimals: 0 | 1 | 2 = 1): number | null {
  if (value === null) return null;
  return decimals === 0 ? round0(value) : decimals === 2 ? round2(value) : round1(value);
}

const WHOLE_KEYS = new Set([
  "kcal",
  "targetKcal",
  "estimatedKcal",
  "sodiumMg",
  "avgPerDay",
  "avg",
  "avgHr",
  "minHr",
  "maxHr",
  "latest",
]);

const ONE_DEC_KEYS = new Set([
  "grams",
  "rawEquivalentGrams",
  "proteinG",
  "carbsG",
  "fatG",
  "fibreG",
  "km",
  "distanceKm",
  "minutes",
  "avgPerNight",
  "avgKg",
  "changeKg",
  "change7dKg",
  "goalKg",
  "goalWeightKg",
  "heightCm",
  "hours",
  "pct",
  "elapsedPct",
  "speedKmh",
  "asleepHours",
  "remHours",
  "deepHours",
  "coreHours",
  "awakeHours",
  "inBedHours",
]);

const TWO_DEC_KEYS = new Set([
  "paceMinPerKm",
  "bestPaceMinPerKm",
  "targetPaceMinPerKm",
  "servingFraction",
  "yieldFactor",
  "estimatedKcalShare",
  "loadKg",
  "topLoadKg",
  "bestLoadKg",
  "volumeKg",
  "totalVolume",
  "estimated1RmKg",
]);

const EXACT_KEYS = new Set([
  "id",
  "foodId",
  "recipeId",
  "recipeIngredientId",
  "foodLogId",
  "supplementId",
  "workoutId",
  "createdAtMs",
  "updatedAtMs",
  "eatenAtMs",
  "takenAtMs",
  "finishedAtMs",
  "archivedAtMs",
  "dueAtMs",
  "startMs",
  "endMs",
  "bytes",
  "count",
  "records",
  "workouts",
  "summaries",
  "days",
  "daysWithData",
  "nights",
  "readings",
  "sets",
  "reps",
  "setNo",
  "servingNo",
  "servingsTotal",
  "remainingServings",
  "taken",
  "total",
  "limit",
  "offset",
  "weekday",
  "weekNo",
  "totalWeeks",
  "currentWeekNo",
  "targetSeconds",
  "recordsInserted",
  "recordsDuplicates",
  "inserted",
  "unresolvedCount",
  "estimatedEntries",
  "sessionsThisWeek",
  "appleSessions",
  "loggedSets",
  "exercises",
  "scheduledDays",
  "takenDays",
  "elapsedScheduledDays",
  "elapsedTakenDays",
  "lat",
  "lon",
]);

/**
 * Recursively round floating-point noise in agent-facing JSON payloads without altering
 * IDs, timestamps, counts, or coordinates.
 */
export function sanitizeAgentNumbers<T>(value: T, key?: string): T {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    if (key && EXACT_KEYS.has(key)) return value;
    if (key && WHOLE_KEYS.has(key)) return round0(value) as T;
    if (key && ONE_DEC_KEYS.has(key)) return round1(value) as T;
    if (key && TWO_DEC_KEYS.has(key)) return round2(value) as T;
    return round2(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAgentNumbers(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = sanitizeAgentNumbers(v, k);
    }
    return out as T;
  }
  return value;
}
