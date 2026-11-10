/**
 * Typed one-function-per-tool client for the HealthVault agent API.
 *
 * Input shapes mirror `src/lib/services/*` and the request handler in
 * `src/app/api/agent/[tool]/route.ts`; results mirror the service return values.
 */

import { createServer, type ServerOptions } from "./server";

export type Day = string; // YYYY-MM-DD in the profile timezone
export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
export type Sex = "male" | "female" | "other";
export type Units = "metric" | "imperial";
export type MeasurementKind = "weight" | "bodyFat" | "waist";
export type MetricsName =
  | "steps"
  | "heart_rate"
  | "resting_heart_rate"
  | "vo2max"
  | "weight"
  | "sleep"
  | "active_energy";

export interface Macros {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
}

export interface MacrosInput {
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fibreG?: number;
  sodiumMg?: number;
}

export interface Targets extends Macros {
  effectiveFrom: Day;
  source: "manual" | "suggested";
}

export interface WorkSchedule {
  days: { weekday: number; start: string; end: string }[];
  note?: string;
}

export interface Profile {
  id: number;
  name: string | null;
  birthDate: string | null;
  sex: Sex | null;
  heightCm: number | null;
  timezone: string;
  units: Units;
  workScheduleJson: string | null;
  goalWeightKg: number | null;
  goalsNote: string | null;
  dietNote: string | null;
  activityNote: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type SuggestedTargets = Macros;

export interface ProfileResult {
  profile: Profile;
  age: number | null;
  suggestedTargets: SuggestedTargets;
}

export interface MeasurementRow {
  id: number;
  day: Day;
  takenAtMs: number;
  kind: MeasurementKind;
  value: number;
  unit: "kg" | "%" | "cm";
  note: string | null;
  createdAtMs: number;
}

export interface MeasurementPoint {
  id: number | null;
  day: Day;
  takenAtMs: number;
  value: number;
  unit: "kg" | "%" | "cm";
  source: "manual" | "apple";
  note: string | null;
}

export interface Food {
  id: number;
  name: string;
  brand: string | null;
  barcode: string | null;
  servingGrams: number;
  kcalPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  fibrePer100g: number;
  sodiumPer100g: number;
  extraJson: string | null;
  source: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface FoodEntry {
  id: number;
  day: Day;
  meal: Meal;
  eatenAtMs: number;
  foodId: number | null;
  name: string;
  grams: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
  estimated: 0 | 1;
  note: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MealEntryBase {
  grams: number;
  note?: string;
  estimated?: boolean;
}

/**
 * Three ways to describe one meal item, matching the server:
 * a stored food, per-100 g values, or absolute values for the portion.
 */
export type MealEntry =
  | (MealEntryBase & { foodId: number })
  | (MealEntryBase & { name: string; per100g: MacrosInput })
  | (MealEntryBase & { name: string; kcal: number } & Partial<Omit<MacrosInput, "kcal">>);

export interface ProfileUpdateInput {
  name?: string | null;
  birthDate?: string | null;
  sex?: Sex | null;
  heightCm?: number | null;
  timezone?: string;
  units?: Units;
  workSchedule?: WorkSchedule | null;
  goalWeightKg?: number | null;
  goalsNote?: string | null;
  dietNote?: string | null;
  activityNote?: string | null;
}

export interface MeasurementAddInput {
  kind: MeasurementKind;
  value: number;
  unit?: string;
  day?: Day;
  takenAt?: number | string;
  note?: string;
}

export interface MeasurementHistoryInput {
  kind?: MeasurementKind;
  days?: number;
}

export interface FoodSearchInput {
  query?: string;
  limit?: number;
}

export interface FoodAddInput {
  name: string;
  brand?: string;
  barcode?: string;
  servingGrams?: number;
  per100g: MacrosInput;
  extra?: unknown;
  source?: string;
}

export interface MealLogInput {
  day?: Day;
  meal: Meal;
  entries: MealEntry[];
}

export interface MealUpdateInput {
  id: number;
  meal?: Meal;
  name?: string;
  grams?: number;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fibreG?: number;
  sodiumMg?: number;
  estimated?: boolean;
  note?: string | null;
}

export interface MealDeleteInput {
  id: number;
}

export interface NutritionDayInput {
  day?: Day;
}

export interface NutritionSummaryInput {
  days?: number;
  endDay?: Day;
}

export interface NutritionTargetSetInput {
  effectiveFrom?: Day;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fibreG?: number;
  sodiumMg?: number;
}

export interface NutritionDayTotals extends Macros {
  day: Day;
  entries: number;
  targetKcal: number;
}

export interface DayNutrition {
  day: Day;
  timezone: string;
  targets: Targets;
  entries: FoodEntry[];
  meals: Record<Meal, FoodEntry[]>;
  totals: Macros;
  remaining: Macros;
  progress: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  estimatedEntries: number;
}

export interface NutritionSummaryResult {
  days: number;
  targets: Targets;
  perDay: NutritionDayTotals[];
}

export interface Schedule {
  time: string | null;
  days: number[] | null;
  note?: string;
}

export interface Supplement {
  id: number;
  name: string;
  dose: number;
  unit: string;
  scheduleJson: string | null;
  nutrientsJson: string | null;
  notes: string | null;
  active: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SupplementLog {
  id: number;
  supplementId: number;
  day: Day;
  takenAtMs: number;
  dose: number;
  unit: string;
  note: string | null;
  createdAtMs: number;
}

export interface ChecklistItem {
  supplement: Supplement;
  schedule: Schedule;
  logged: boolean;
  log: SupplementLog | null;
}

export interface Checklist {
  day: Day;
  items: ChecklistItem[];
  taken: number;
  total: number;
}

export interface SupplementListResult {
  supplements: Supplement[];
  checklist: Checklist;
}

export interface SupplementCreateInput {
  name: string;
  dose?: number;
  unit?: string;
  schedule?: Schedule | null;
  nutrients?: unknown;
  notes?: string;
  active?: boolean;
}

export interface SupplementUpdateInput {
  supplementId: number;
  name?: string;
  dose?: number;
  unit?: string;
  schedule?: Schedule | null;
  nutrients?: unknown;
  notes?: string;
  active?: boolean;
}

export interface SupplementLogInput {
  supplementId: number;
  day?: Day;
  taken?: boolean;
  dose?: number;
  unit?: string;
  takenAt?: number | string;
  note?: string;
}

export interface SupplementLogResult {
  logged: boolean;
  log: SupplementLog | null;
  supplement: Supplement;
}

export interface MetricsSeriesInput {
  metric: MetricsName;
  days?: number;
}

export interface MetricPoint {
  day: Day;
  value: number;
  source?: string;
}

export interface MetricsSeriesResult {
  metric: MetricsName;
  unit: string;
  points: MetricPoint[];
}

export interface Workout {
  day: Day;
  startDate: string;
  type: string;
  minutes: number | null;
  km: number | null;
  kcal: number | null;
  paceMinPerKm: number | null;
  speedKmh: number | null;
  avgHr: number | null;
  minHr: number | null;
  maxHr: number | null;
  sourceName: string | null;
}

export interface WorkoutsRecentInput {
  limit?: number;
}

/** Everything `ctx` returns, typed at the level the tools are expected to use. */
export interface HealthContext {
  generatedAt: string;
  today: Day;
  timezone: string;
  profile: Profile & { age: number | null; started: boolean };
  nutrition: DayNutrition;
  weight: {
    latest: MeasurementPoint | null;
    goalKg: number | null;
    change7dKg: number | null;
    points: MeasurementPoint[];
  };
  supplements: Checklist;
  nextSupplement: ChecklistItem | null;
  training: {
    workouts: Workout[];
    steps: unknown;
    sleep: unknown;
  };
  data: {
    counts: unknown;
    lastUpload: {
      filename: string;
      status: string;
      finishedAtMs: number | null;
      inserted: number;
    } | null;
    lastRecordDay: Day | null;
  };
}

export type HealthVaultClientOptions = ServerOptions;

export function createClient(options: ServerOptions = {}) {
  const server = createServer(options);

  return {
    baseUrl: server.baseUrl,
    timeoutMs: server.timeoutMs,

    healthvaultContext: (signal?: AbortSignal) =>
      server.request<HealthContext>("healthvault_context", {}, signal),

    profileGet: (signal?: AbortSignal) =>
      server.request<ProfileResult>("profile_get", {}, signal),
    profileUpdate: (input: ProfileUpdateInput, signal?: AbortSignal) =>
      server.request<Profile>("profile_update", input, signal),

    measurementAdd: (input: MeasurementAddInput, signal?: AbortSignal) =>
      server.request<MeasurementRow>("measurement_add", input, signal),
    measurementHistory: (input: MeasurementHistoryInput = {}, signal?: AbortSignal) =>
      server.request<MeasurementPoint[]>("measurement_history", input, signal),

    foodSearch: (input: FoodSearchInput = {}, signal?: AbortSignal) =>
      server.request<Food[]>("food_search", input, signal),
    foodAdd: (input: FoodAddInput, signal?: AbortSignal) =>
      server.request<Food>("food_add", input, signal),

    mealLog: (input: MealLogInput, signal?: AbortSignal) =>
      server.request<{ day: Day; meal: Meal; entries: FoodEntry[] }>(
        "meal_log",
        input,
        signal,
      ),
    mealUpdate: (input: MealUpdateInput, signal?: AbortSignal) =>
      server.request<FoodEntry>("meal_update", input, signal),
    mealDelete: (input: MealDeleteInput, signal?: AbortSignal) =>
      server.request<{ deleted: boolean }>("meal_delete", input, signal),

    nutritionDay: (input: NutritionDayInput = {}, signal?: AbortSignal) =>
      server.request<DayNutrition>("nutrition_day", input, signal),
    nutritionSummary: (input: NutritionSummaryInput = {}, signal?: AbortSignal) =>
      server.request<NutritionSummaryResult>("nutrition_summary", input, signal),
    nutritionTargetSet: (input: NutritionTargetSetInput, signal?: AbortSignal) =>
      server.request<Targets>("nutrition_target_set", input, signal),

    supplementList: (signal?: AbortSignal) =>
      server.request<SupplementListResult>("supplement_list", {}, signal),
    supplementCreate: (input: SupplementCreateInput, signal?: AbortSignal) =>
      server.request<Supplement>("supplement_create", input, signal),
    supplementUpdate: (input: SupplementUpdateInput, signal?: AbortSignal) =>
      server.request<Supplement>("supplement_update", input, signal),
    supplementLog: (input: SupplementLogInput, signal?: AbortSignal) =>
      server.request<SupplementLogResult>("supplement_log", input, signal),

    metricsSeries: (input: MetricsSeriesInput, signal?: AbortSignal) =>
      server.request<MetricsSeriesResult>("metrics_series", input, signal),
    workoutsRecent: (input: WorkoutsRecentInput = {}, signal?: AbortSignal) =>
      server.request<Workout[]>("workouts_recent", input, signal),
  };
}

export type HealthVaultClient = ReturnType<typeof createClient>;
