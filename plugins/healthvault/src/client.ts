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
export type FoodState = "raw" | "cooked" | "dry" | "rehydrated" | "none";
export type WeightSource = "weighed" | "counted" | "guessed";
export type MacroSource = "label" | "usda" | "recipe" | "estimated";
export type Measure = { name: string; count: number };
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
  workSchedule: WorkSchedule;
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
  state: FoodState;
  yieldFactor: number;
  measuresJson: string | null;
  /** Effective grams per household measure (shared defaults + this food's overrides). */
  measures?: Record<string, number>;
  extraJson: string | null;
  source: string;
  /** Provenance URL for the per-100 g values (label, USDA, package, brand page, ...). */
  sourceUrl: string | null;
  /** Provenance date (YYYY-MM-DD) the values were read. */
  sourceDate: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One ingredient as it was actually logged; never re-read from the live recipe. */
export interface FoodLogIngredient {
  id: number;
  foodLogId: number;
  recipeId: number | null;
  recipeIngredientId: number | null;
  foodId: number | null;
  name: string;
  position: number;
  /** How `measureJson` is stated: "batch" (the recipe definition or a batch override) or "serving". */
  amountBasis: "batch" | "serving" | null;
  /** Amount in this logged portion. */
  grams: number;
  /** Amount in one serving; `servingFraction` edits rescale from this. */
  perServingGrams: number;
  measureJson: string | null;
  gramsAs: "raw" | "cooked" | null;
  foodState: FoodState | null;
  yieldFactor: number | null;
  rawEquivalentGrams: number | null;
  kcalPer100g: number | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  fibrePer100g: number | null;
  sodiumPer100g: number | null;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
  resolved: 0 | 1;
  macroSource: MacroSource | null;
  weightSource: WeightSource | null;
  source: string | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  createdAtMs: number;
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
  weightSource: WeightSource | null;
  macroSource: MacroSource | null;
  gramsAs: "raw" | "cooked" | null;
  rawEquivalentGrams: number | null;
  /** The food's per-100 g basis when the row was written (provenance only). */
  basisState: FoodState | null;
  basisYieldFactor: number | null;
  recipeId: number | null;
  servingNo: number | null;
  servingFraction: number | null;
  recipeServingJson: string | null;
  note: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** Present on day/entry reads: the full ingredient snapshot, oldest definition untouched. */
  ingredients?: FoodLogIngredient[];
  /** null for a plain food entry; false only for a legacy aggregate-only recipe row. */
  ingredientSnapshotComplete?: boolean | null;
}

export interface MealEntryBase {
  grams?: number;
  measure?: Measure;
  note?: string;
  estimated?: boolean;
  weightSource?: WeightSource;
  macroSource?: MacroSource;
  gramsAs?: "raw" | "cooked";
  state?: FoodState;
}

/** One of grams or a household measure is required; the server validates the pair. */
export type MealAmount = { grams: number } | { measure: Measure };

/**
 * Three ways to describe one meal item, matching the server:
 * a stored food, per-100 g values, or absolute values for the portion.
 */
export type MealEntry = MealEntryBase &
  MealAmount &
  (
    | { foodId: number }
    | { name: string; per100g: MacrosInput }
    | ({ name: string; kcal: number } & Partial<Omit<MacrosInput, "kcal">>)
  );

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

export interface MeasurementDeleteInput {
  id: number;
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
  state?: FoodState;
  yieldFactor?: number;
  measures?: Record<string, number>;
  measuresJson?: string;
  extra?: unknown;
  source?: string;
}

export interface FoodDeleteInput {
  id: number;
}

export interface FoodTemplate {
  slug: string;
  label: string;
  description: string;
  state?: FoodState;
  yieldFactor?: number;
  measures?: Record<string, number>;
}

export interface FoodTemplateListResult {
  templates: FoodTemplate[];
}

export interface FoodTemplateApplyInput {
  id: number;
  template: string;
  overwrite?: boolean;
}

export interface MealLogInput {
  day?: Day;
  meal: Meal;
  entries: MealEntry[];
  eatenAt?: number | string;
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
  day?: Day;
  eatenAt?: number | string;
  servingNo?: number;
  servingFraction?: number;
  gramsAs?: "raw" | "cooked";
  state?: FoodState;
  weightSource?: WeightSource;
  macroSource?: MacroSource;
}

export interface MealDeleteInput {
  id: number;
}

export interface MealGetInput {
  id: number;
}

export type MealGetResult = FoodEntry;

export interface FoodHistoryScopeInput {
  /** Scope by saved food ids. */
  foodIds?: number[];
  /** Scope by logged entry ids (all their ingredient snapshots are considered). */
  entryIds?: number[];
  fromDay?: Day;
  toDay?: Day;
}

export type FoodHistoryPreviewInput = FoodHistoryScopeInput;

export interface FoodHistoryChange {
  kind: "entry" | "ingredient";
  entryId: number;
  ingredientId: number | null;
  foodId: number | null;
  name: string;
  day: Day;
  meal: Meal;
  status: "changed" | "unchanged" | "skipped";
  reason: string | null;
  previous: (Macros & { grams: number; rawEquivalentGrams: number | null }) | null;
  proposed: (Macros & { grams: number; rawEquivalentGrams: number | null }) | null;
}

export interface FoodHistoryPreviewResult {
  scope: {
    foodIds: number[];
    entryIds: number[];
    fromDay: Day | null;
    toDay: Day | null;
  };
  /** Pass this exact value to food_history_refresh; a stale preview is rejected with 409. */
  previewHash: string;
  changed: number;
  unchanged: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  changes: FoodHistoryChange[];
}

export interface FoodHistoryRefreshInput extends FoodHistoryScopeInput {
  previewHash: string;
}

export interface FoodHistoryRefreshResult {
  applied: number;
  entriesTouched: number;
  revisions: number;
  skipped: number;
  previewHash: string;
}

export interface RecipeIngredientInput {
  /** Omit for a name-only ingredient: it keeps grams/measure but contributes no nutrition. */
  foodId?: number;
  name?: string;
  grams?: number;
  measure?: Measure;
}

/**
 * A per-meal quantity override. Identify the recipe ingredient by `ingredientId` (preferred) or
 * by `foodId` when that food appears only once. `amountBasis` on the log call says whether grams
 * are for the whole recipe batch or for one serving.
 */
export interface RecipeIngredientOverride {
  ingredientId?: number;
  foodId?: number;
  grams?: number;
  measure?: Measure;
  /** Say what you actually weighed; the per-100 g basis comes from the food. */
  gramsAs?: "raw" | "cooked";
}

export interface RecipeCreateInput {
  name: string;
  servings?: number;
  servingsTotal?: number;
  note?: string;
  ingredients: RecipeIngredientInput[];
}

export interface RecipeGetInput {
  id: number;
}

export interface RecipeLogInput {
  recipeId: number;
  day?: Day;
  meal: Meal;
  servingNo?: number;
  servingFraction?: number;
  eatenAt?: number | string;
  name?: string;
  note?: string;
  weightSource?: WeightSource;
  /** Requires `amountBasis`; changes this meal only, never the recipe definition. */
  ingredientOverrides?: RecipeIngredientOverride[];
  /** "batch" = whole recipe, "serving" = one serving. Required with ingredientOverrides. */
  amountBasis?: "batch" | "serving";
}

export interface RecipeUpdateInput {
  id: number;
  name?: string;
  servings?: number;
  servingsTotal?: number;
  note?: string;
  ingredients?: RecipeIngredientInput[];
}

export interface RecipeDeleteInput {
  id: number;
}

/** A recipe with logged history is archived (`archived: true`), never destroyed. */
export interface RecipeDeleteResult {
  deleted: boolean;
  archived: boolean;
  reason?: string;
  loggedEntries?: number;
  /** Historical child snapshots that still name this recipe even after a copied parent link. */
  snapshotIngredients?: number;
  archivedAtMs?: number;
}

export interface RecipeTotals {
  grams: number;
  macros: Macros;
}

export interface ResolvedRecipeIngredient {
  id: number;
  foodId: number | null;
  name: string | null;
  grams: number;
  measure: Measure | null;
  /** False for a name-only ingredient: grams are kept, macros are not invented. */
  resolved: boolean;
  per100g: Macros | null;
  state: FoodState | null;
  yieldFactor: number | null;
  brand: string | null;
  source: string | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  macros: Macros;
}

export interface LoggedServing {
  day: Day;
  meal: Meal;
  servingNo: number | null;
  servingFraction: number | null;
}

export interface RecipeDetail {
  id: number;
  name: string;
  servingsTotal: number;
  note: string | null;
  archivedAtMs: number | null;
  archivedReason: string | null;
  archived: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  ingredients: ResolvedRecipeIngredient[];
  total: RecipeTotals;
  perServing: RecipeTotals;
  complete: boolean;
  unresolvedIngredients: string[];
  remainingServings: number;
  loggedServings: LoggedServing[];
}

export interface RecipeLogResult {
  day: Day;
  meal: Meal;
  recipeId: number;
  servingNo: number;
  servingFraction: number;
  incomplete: boolean;
  unresolvedIngredients: string[];
  amountBasis: "batch" | "serving" | null;
  entry: FoodEntry;
  ingredients: FoodLogIngredient[];
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

export interface CopyDayInput {
  fromDay: Day;
  toDay: Day;
}

export interface CopyDayResult {
  copied: number;
  toDay: Day;
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
  estimatedKcal: number;
  /** Share of the day's kcal whose macros are estimated, 0..1. */
  estimatedKcalShare: number;
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

export interface SupplementHistoryInput {
  days?: number;
}

export interface SupplementHistoryItem {
  name: string;
  dose: number;
  unit: string;
  takenAtMs: number;
}

/** One day with at least one logged dose, newest day first. */
export interface SupplementHistoryDay {
  day: Day;
  taken: number;
  items: SupplementHistoryItem[];
}

export interface SupplementDeleteInput {
  id: number;
}

/** `archived` is true when intake history exists, so the row is hidden instead of deleted. */
export interface SupplementDeleteResult {
  deleted: boolean;
  archived: boolean;
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

/** One Apple record type and its raw statistics, from the type-stats query. */
export interface TypeStat {
  typeIdentifier: string;
  unit: string;
  count: number;
  firstDay: Day;
  lastDay: Day;
  sum: number;
  avg: number;
  max: number;
}

export interface RecordsRecentInput {
  type: string;
  limit?: number;
}

/** A raw Apple Health record. Rows are not de-duplicated across devices. */
export interface RecordRow {
  day: Day;
  startDate: string;
  endDate: string;
  value: number;
  unit: string;
  sourceName: string | null;
}

export interface RecordsRecentResult {
  type: string;
  rows: RecordRow[];
}

export interface UploadsRecentInput {
  limit?: number;
}

export interface UploadRow {
  filename: string;
  bytes: number;
  status: string;
  recordsInserted: number;
  recordsDuplicates: number;
  message: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
}

/** Everything `ctx` returns, typed at the level the tools are expected to use. */
export interface HealthContext {
  generatedAt: string;
  today: Day;
  timezone: string;
  profile: Profile & { age: number | null; started: boolean; workSchedule: WorkSchedule };
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
    measurementDelete: (input: MeasurementDeleteInput, signal?: AbortSignal) =>
      server.request<{ deleted: boolean }>("measurement_delete", input, signal),

    foodSearch: (input: FoodSearchInput = {}, signal?: AbortSignal) =>
      server.request<Food[]>("food_search", input, signal),
    foodAdd: (input: FoodAddInput, signal?: AbortSignal) =>
      server.request<Food>("food_add", input, signal),
    foodDelete: (input: FoodDeleteInput, signal?: AbortSignal) =>
      server.request<{ deleted: boolean }>("food_delete", input, signal),
    foodTemplateList: (signal?: AbortSignal) =>
      server.request<FoodTemplateListResult>("food_template_list", {}, signal),
    foodTemplateApply: (input: FoodTemplateApplyInput, signal?: AbortSignal) =>
      server.request<Food>("food_template_apply", input, signal),

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
    mealGet: (input: MealGetInput, signal?: AbortSignal) =>
      server.request<MealGetResult>("meal_get", input, signal),

    recipeCreate: (input: RecipeCreateInput, signal?: AbortSignal) =>
      server.request<RecipeDetail>("recipe_create", input, signal),
    recipeGet: (input: RecipeGetInput, signal?: AbortSignal) =>
      server.request<RecipeDetail>("recipe_get", input, signal),
    recipeLog: (input: RecipeLogInput, signal?: AbortSignal) =>
      server.request<RecipeLogResult>("recipe_log", input, signal),
    recipeUpdate: (input: RecipeUpdateInput, signal?: AbortSignal) =>
      server.request<RecipeDetail>("recipe_update", input, signal),
    recipeDelete: (input: RecipeDeleteInput, signal?: AbortSignal) =>
      server.request<RecipeDeleteResult>("recipe_delete", input, signal),

    foodHistoryPreview: (input: FoodHistoryPreviewInput, signal?: AbortSignal) =>
      server.request<FoodHistoryPreviewResult>("food_history_preview", input, signal),
    foodHistoryRefresh: (input: FoodHistoryRefreshInput, signal?: AbortSignal) =>
      server.request<FoodHistoryRefreshResult>("food_history_refresh", input, signal),

    nutritionDay: (input: NutritionDayInput = {}, signal?: AbortSignal) =>
      server.request<DayNutrition>("nutrition_day", input, signal),
    nutritionSummary: (input: NutritionSummaryInput = {}, signal?: AbortSignal) =>
      server.request<NutritionSummaryResult>("nutrition_summary", input, signal),
    nutritionTargetSet: (input: NutritionTargetSetInput, signal?: AbortSignal) =>
      server.request<Targets>("nutrition_target_set", input, signal),
    copyDay: (input: CopyDayInput, signal?: AbortSignal) =>
      server.request<CopyDayResult>("copy_day", input, signal),

    supplementList: (signal?: AbortSignal) =>
      server.request<SupplementListResult>("supplement_list", {}, signal),
    supplementCreate: (input: SupplementCreateInput, signal?: AbortSignal) =>
      server.request<Supplement>("supplement_create", input, signal),
    supplementUpdate: (input: SupplementUpdateInput, signal?: AbortSignal) =>
      server.request<Supplement>("supplement_update", input, signal),
    supplementLog: (input: SupplementLogInput, signal?: AbortSignal) =>
      server.request<SupplementLogResult>("supplement_log", input, signal),
    supplementHistory: (input: SupplementHistoryInput = {}, signal?: AbortSignal) =>
      server.request<SupplementHistoryDay[]>("supplement_history", input, signal),
    supplementDelete: (input: SupplementDeleteInput, signal?: AbortSignal) =>
      server.request<SupplementDeleteResult>("supplement_delete", input, signal),

    metricsSeries: (input: MetricsSeriesInput, signal?: AbortSignal) =>
      server.request<MetricsSeriesResult>("metrics_series", input, signal),
    workoutsRecent: (input: WorkoutsRecentInput = {}, signal?: AbortSignal) =>
      server.request<Workout[]>("workouts_recent", input, signal),
    recordTypes: (signal?: AbortSignal) =>
      server.request<TypeStat[]>("record_types", {}, signal),
    recordsRecent: (input: RecordsRecentInput, signal?: AbortSignal) =>
      server.request<RecordsRecentResult>("records_recent", input, signal),
    uploadsRecent: (input: UploadsRecentInput = {}, signal?: AbortSignal) =>
      server.request<UploadRow[]>("uploads_recent", input, signal),
  };
}

export type HealthVaultClient = ReturnType<typeof createClient>;
