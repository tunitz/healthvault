import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { foodLog, foodRevisions, foods, nutritionTargets } from "@/db/schema";
import { addDays, formatClockSeconds, isDay, localDay, localTimeMs } from "@/lib/day";
import { latestMeasurement } from "@/lib/services/measurements";
import {
  effectiveMeasures,
  measureDefaults,
  measuresMap,
  resolveMeasureGrams,
} from "@/lib/services/measures";
import { getProfile, getTimezone, suggestedTargets } from "@/lib/services/profile";
import { applyTemplateDefaults, findFoodTemplate, templateChangesBasis } from "@/lib/services/food-templates";
import {
  copyIngredientSnapshots,
  deleteEntrySnapshotRows,
  entryJson,
  ingredientsForEntry,
  insertIngredientSnapshots,
  rescaleIngredientSnapshots,
  totalsFromIngredients,
  withIngredientSnapshots,
  writeRevision,
  type IngredientSnapshotInput,
  type LoggedIngredient,
  type LoggedIngredientEntry,
} from "@/lib/services/food-log-snapshots";
import { recipeTotals } from "@/lib/services/recipes";
import { dayField, enumField, fail, idField, numField, str } from "@/lib/validate";

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type Meal = (typeof MEALS)[number];

/** The state a food's per-100 g values describe, and the state a user weighed. */
export const FOOD_STATES = ["raw", "cooked", "dry", "rehydrated", "none"] as const;
export type FoodState = (typeof FOOD_STATES)[number];
export const WEIGHED_STATES = ["raw", "cooked"] as const;
export type WeighedState = (typeof WEIGHED_STATES)[number];
export const WEIGHT_SOURCES = ["weighed", "counted", "guessed"] as const;
export type WeightSource = (typeof WEIGHT_SOURCES)[number];
export const MACRO_SOURCES = ["label", "usda", "recipe", "estimated"] as const;
export type MacroSource = (typeof MACRO_SOURCES)[number];

export type Macros = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
};

export type Targets = Macros & { effectiveFrom: string; source: "manual" | "suggested" };
export type Food = typeof foods.$inferSelect;
export type FoodEntry = typeof foodLog.$inferSelect;

const EMPTY: Macros = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, sodiumMg: 0 };

export function sumMacros(rows: Macros[]): Macros {
  return rows.reduce<Macros>(
    (a, r) => ({
      kcal: a.kcal + r.kcal,
      proteinG: a.proteinG + r.proteinG,
      carbsG: a.carbsG + r.carbsG,
      fatG: a.fatG + r.fatG,
      fibreG: a.fibreG + r.fibreG,
      sodiumMg: a.sodiumMg + r.sodiumMg,
    }),
    { ...EMPTY },
  );
}

/** Accepts the common aliases an agent or a form may send. */
function macrosOf(input: Record<string, unknown>, { required = false } = {}): Macros {
  const pick = (...names: string[]) => {
    for (const n of names) if (input[n] !== undefined && input[n] !== null && input[n] !== "") return input[n];
    return undefined;
  };
  const value = (names: string[], label: string, min = 0, max = 100_000) =>
    numField(pick(...names) ?? 0, label, { min, max }) ?? 0;
  const kcal = numField(pick("kcal", "calories"), "kcal", { required, min: 0, max: 100_000 }) ?? 0;
  return {
    kcal,
    proteinG: value(["proteinG", "protein"], "proteinG"),
    carbsG: value(["carbsG", "carbs", "carbohydrateG"], "carbsG"),
    fatG: value(["fatG", "fat"], "fatG"),
    fibreG: value(["fibreG", "fiberG", "fibre", "fiber"], "fibreG"),
    sodiumMg: value(["sodiumMg", "sodium"], "sodiumMg"),
  };
}

/** Only the fields the caller actually sent — a partial target update must not zero the rest. */
function providedMacros(input: Record<string, unknown>): Partial<Macros> {
  const fields: [keyof Macros, string[], number][] = [
    ["kcal", ["kcal", "calories"], 0],
    ["proteinG", ["proteinG", "protein"], 0],
    ["carbsG", ["carbsG", "carbs", "carbohydrateG"], 0],
    ["fatG", ["fatG", "fat"], 0],
    ["fibreG", ["fibreG", "fiberG", "fibre", "fiber"], 0],
    ["sodiumMg", ["sodiumMg", "sodium"], 0],
  ];
  const out: Partial<Macros> = {};
  for (const [key, names, min] of fields) {
    const name = names.find((n) => n in input && input[n] !== undefined && input[n] !== null && input[n] !== "");
    if (name !== undefined) {
      const value = numField(input[name], names[0], { min, max: 100_000 });
      if (value !== null) out[key] = value;
    }
  }
  return out;
}

function per100Macros(input: Record<string, unknown>): Macros {
  const nested = (input.per100g ?? input.per100 ?? {}) as Record<string, unknown>;
  return macrosOf({ ...input, ...nested }, { required: true });
}

/* ---------------------------------------------------------------------------------------------
 * Targets
 * ------------------------------------------------------------------------------------------- */

export function resolveTargets(day: string = localDay(Date.now(), getTimezone())): Targets {
  const rows = db
    .select()
    .from(nutritionTargets)
    .where(sql`${nutritionTargets.effectiveFrom} <= ${day}`)
    .orderBy(desc(nutritionTargets.effectiveFrom))
    .all();
  const profile = getProfile();
  const weight = latestMeasurement("weight")?.value ?? 75;
  const suggested = suggestedTargets(profile, weight);
  const newest = rows[0];

  // Effective-dated rows inherit any field they leave NULL from the newest earlier row that
  // has it, and then from the suggestion. A partial update therefore never zeroes the plan.
  const pick = (key: keyof Macros): number => {
    for (const row of rows) {
      const value = row[key];
      if (typeof value === "number") return value;
    }
    return suggested[key];
  };

  if (!newest) {
    return { ...suggested, effectiveFrom: day, source: "suggested" };
  }
  return {
    effectiveFrom: newest.effectiveFrom,
    source: "manual",
    kcal: pick("kcal"),
    proteinG: pick("proteinG"),
    carbsG: pick("carbsG"),
    fatG: pick("fatG"),
    fibreG: pick("fibreG"),
    sodiumMg: pick("sodiumMg"),
  };
}

export function setTargets(input: Record<string, unknown>): Targets {
  const day =
    input.effectiveFrom === undefined || input.effectiveFrom === null || input.effectiveFrom === ""
      ? localDay(Date.now(), getTimezone())
      : dayField(input.effectiveFrom, "effectiveFrom");
  const patch = providedMacros(input);
  if (Object.keys(patch).length === 0) fail("at least one target value is required (e.g. kcal)");

  const existing = db
    .select()
    .from(nutritionTargets)
    .where(eq(nutritionTargets.effectiveFrom, day))
    .get();
  const now = Date.now();

  if (existing) {
    db.update(nutritionTargets).set({ ...patch, updatedAtMs: now }).where(eq(nutritionTargets.id, existing.id)).run();
  } else {
    db.insert(nutritionTargets)
      .values({ effectiveFrom: day, ...patch, createdAtMs: now, updatedAtMs: now })
      .run();
  }
  return resolveTargets(day);
}

export function targetHistory(limit = 24) {
  return db
    .select()
    .from(nutritionTargets)
    .orderBy(desc(nutritionTargets.effectiveFrom))
    .limit(limit)
    .all();
}

/* ---------------------------------------------------------------------------------------------
 * Foods
 * ------------------------------------------------------------------------------------------- */

export type FoodWithMeasures = Food & { measures: Record<string, number> };

/** A food as the agent sees it: raw row plus the effective grams per household measure. */
function foodWithMeasures(food: Food, defaults = measureDefaults()): FoodWithMeasures {
  return { ...food, measures: effectiveMeasures(food.measuresJson, defaults) };
}

function measuresJsonFromInput(
  input: Record<string, unknown>,
  existing: Food | undefined,
): string | null {
  if (input.measures === undefined && input.measuresJson === undefined) {
    return existing?.measuresJson ?? null;
  }
  const map = measuresMap(input.measures !== undefined ? input.measures : input.measuresJson);
  return map === null ? null : JSON.stringify(map);
}

export function searchFoods(query: unknown, limit = 20): FoodWithMeasures[] {
  const q = str(query, "query", { max: 120 });
  const capped = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 100) : 20;
  const defaults = measureDefaults();
  const rows = !q
    ? db.select().from(foods).orderBy(desc(foods.updatedAtMs)).limit(capped).all()
    : db
        .select()
        .from(foods)
        .where(or(like(foods.name, `%${q.replace(/[%_]/g, "")}%`), like(foods.brand, `%${q.replace(/[%_]/g, "")}%`)))
        .orderBy(desc(foods.updatedAtMs))
        .limit(capped)
        .all();
  return rows.map((row) => foodWithMeasures(row, defaults));
}

export function getFood(id: unknown): Food {
  const row = db.select().from(foods).where(eq(foods.id, idField(id))).get();
  if (!row) fail("food not found", 404);
  return row;
}

/** The stored definition a food revision compares; never the derived measures map. */
function foodRevisionJson(food: Food): string {
  return JSON.stringify({
    name: food.name,
    brand: food.brand,
    barcode: food.barcode,
    servingGrams: food.servingGrams,
    kcalPer100g: food.kcalPer100g,
    proteinPer100g: food.proteinPer100g,
    carbsPer100g: food.carbsPer100g,
    fatPer100g: food.fatPer100g,
    fibrePer100g: food.fibrePer100g,
    sodiumPer100g: food.sodiumPer100g,
    state: food.state,
    yieldFactor: food.yieldFactor,
    measuresJson: food.measuresJson,
    source: food.source,
    sourceUrl: food.sourceUrl,
    sourceDate: food.sourceDate,
    extraJson: food.extraJson,
  });
}

/** Record a food definition change so a later history refresh can be audited. */
function recordFoodRevision(previous: Food, current: Food, now: number): void {
  const before = foodRevisionJson(previous);
  const after = foodRevisionJson(current);
  if (before === after) return;
  db.insert(foodRevisions)
    .values({
      foodId: current.id,
      reason: "food_definition_update",
      previousJson: before,
      currentJson: after,
      createdAtMs: now,
    })
    .run();
}

function sourceDateField(value: unknown, existing?: string | null): string | null {
  if (value === undefined) return existing ?? null;
  if (value === null || value === "") return null;
  return dayField(value, "sourceDate");
}

export function addFood(input: Record<string, unknown>): FoodWithMeasures {
  const name = str(input.name, "name", { required: true, max: 200 })!;
  const brand = str(input.brand, "brand", { max: 200 });
  const m = per100Macros(input);
  const servingGrams = numField(input.servingGrams ?? 100, "servingGrams", { min: 1, max: 10_000 }) ?? 100;
  const now = Date.now();
  const existing = db
    .select()
    .from(foods)
    .where(and(eq(foods.name, name), brand === null ? sql`${foods.brand} IS NULL` : eq(foods.brand, brand)))
    .get();

  const state =
    input.state === undefined || input.state === null || input.state === ""
      ? existing?.state ?? "raw"
      : enumField(input.state, "state", FOOD_STATES)!;
  const yieldFactor =
    input.yieldFactor === undefined || input.yieldFactor === null || input.yieldFactor === ""
      ? existing?.yieldFactor ?? 1
      : numField(input.yieldFactor, "yieldFactor", { required: true, min: 0.01, max: 10 })!;
  const measuresJson = measuresJsonFromInput(input, existing);

  if (existing) {
    const row = db
      .update(foods)
      .set({
        servingGrams,
        kcalPer100g: m.kcal,
        proteinPer100g: m.proteinG,
        carbsPer100g: m.carbsG,
        fatPer100g: m.fatG,
        fibrePer100g: m.fibreG,
        sodiumPer100g: m.sodiumMg,
        state,
        yieldFactor,
        measuresJson,
        barcode: input.barcode === undefined ? existing.barcode : str(input.barcode, "barcode", { max: 64 }),
        extraJson: input.extra === undefined ? existing.extraJson : JSON.stringify(input.extra),
        source: typeof input.source === "string" ? input.source : existing.source,
        sourceUrl:
          input.sourceUrl === undefined ? existing.sourceUrl : str(input.sourceUrl, "sourceUrl", { max: 500 }),
        sourceDate: sourceDateField(input.sourceDate, existing.sourceDate),
        updatedAtMs: now,
      })
      .where(eq(foods.id, existing.id))
      .returning()
      .get()!;
    recordFoodRevision(existing, row, now);
    return foodWithMeasures(row);
  }

  const row = db
    .insert(foods)
    .values({
      name,
      brand,
      barcode: str(input.barcode, "barcode", { max: 64 }),
      servingGrams,
      kcalPer100g: m.kcal,
      proteinPer100g: m.proteinG,
      carbsPer100g: m.carbsG,
      fatPer100g: m.fatG,
      fibrePer100g: m.fibreG,
      sodiumPer100g: m.sodiumMg,
      state,
      yieldFactor,
      measuresJson,
      extraJson: input.extra === undefined ? null : JSON.stringify(input.extra),
      source: typeof input.source === "string" ? input.source : "manual",
      sourceUrl: str(input.sourceUrl, "sourceUrl", { max: 500 }),
      sourceDate: sourceDateField(input.sourceDate),
      createdAtMs: now,
      updatedAtMs: now,
    })
    .returning()
    .get()!;
  return foodWithMeasures(row);
}

export function deleteFood(id: unknown): { deleted: boolean } {
  const foodId = idField(id);
  const used = sqlite.prepare("SELECT COUNT(*) AS c FROM food_log WHERE food_id = ?").get(foodId) as { c: number };
  if (used.c > 0) fail("food is used by logged meals; it cannot be deleted", 409);
  const loggedIngredient = sqlite
    .prepare("SELECT COUNT(*) AS c FROM food_log_ingredients WHERE food_id = ?")
    .get(foodId) as { c: number };
  if (loggedIngredient.c > 0) {
    fail("food is referenced by logged recipe ingredients; it cannot be deleted", 409);
  }
  const inRecipe = sqlite
    .prepare("SELECT COUNT(*) AS c FROM recipe_ingredients WHERE food_id = ?")
    .get(foodId) as { c: number };
  if (inRecipe.c > 0) fail("food is used by a recipe; it cannot be deleted", 409);
  const row = db.delete(foods).where(eq(foods.id, foodId)).returning().get();
  return { deleted: Boolean(row) };
}

/**
 * Apply one explicit, named template to a food id: household-measure grams and/or a state and
 * yield factor. Never name-inferred, and never touches the food's macros.
 *
 * Existing per-unit overrides and a custom state/yield are kept unless `overwrite` is true.
 */
export function applyFoodTemplate(
  id: unknown,
  template: unknown,
  options: { overwrite?: boolean } = {},
): FoodWithMeasures {
  const foodId = idField(id);
  const existing = getFood(foodId);
  const found = findFoodTemplate(template);
  if (templateChangesBasis(existing, found) && options.overwrite !== true) {
    fail(
      `template "${found.slug}" changes this food's per-100 g basis from ${existing.state} to ${found.state}; pass overwrite: true to confirm the nutrition values are on the ${found.state} basis`,
      409,
    );
  }
  const defaults = applyTemplateDefaults(existing, found, options.overwrite === true);
  const measuresJson = Object.keys(defaults.measures).length ? JSON.stringify(defaults.measures) : null;
  const now = Date.now();
  const row = db
    .update(foods)
    .set({
      state: defaults.state,
      yieldFactor: defaults.yieldFactor,
      measuresJson,
      updatedAtMs: now,
    })
    .where(eq(foods.id, foodId))
    .returning()
    .get()!;
  recordFoodRevision(existing, row, now);
  return foodWithMeasures(row);
}

/**
 * Convert a weighed amount to the food's macro basis. `yieldFactor` is cooked g per raw g for a
 * raw-basis food (0.75 chicken breast) and cooked g per dry g for a dry-basis food (2.3 rice).
 * A factor of 1.0 means the food never declared a conversion, so a mismatched state is an error
 * rather than a silently 30%-wrong entry.
 */
function basisGrams(
  grams: number,
  weighedAs: FoodState,
  basisState: FoodState,
  yieldFactor: number,
  label: string,
): number {
  if (weighedAs === basisState || basisState === "none") return grams;
  const factor = Number.isFinite(yieldFactor) && yieldFactor > 0 ? yieldFactor : 1;
  if (factor === 1) {
    fail(
      `${label}: cannot convert ${weighedAs} grams to the food's ${basisState} basis because yieldFactor is 1.0; set yieldFactor on the food or send gramsAs ${basisState}`,
    );
  }
  if (basisState === "raw" && weighedAs === "cooked") return grams / factor;
  if (basisState === "cooked" && weighedAs === "raw") return grams * factor;
  if (basisState === "dry" && (weighedAs === "cooked" || weighedAs === "rehydrated")) return grams / factor;
  if (basisState === "rehydrated" && weighedAs === "dry") return grams * factor;
  fail(`${label}: cannot convert ${weighedAs} grams to a ${basisState} basis with yieldFactor ${factor}`);
}

/**
 * ISO timestamp or epoch milliseconds -> epoch ms.
 *
 * A timestamp *without* an offset ("2026-11-10T08:00:00", seconds optional) is a wall-clock time
 * in the profile timezone, not the server's: the same log must mean 08:00 for the user wherever
 * the process runs. An explicit offset (`+08:00`, `Z`) and epoch milliseconds are taken as-is.
 */
function instantField(value: unknown, name: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) fail(`${name} must be an ISO timestamp or epoch milliseconds`);
    return Math.trunc(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} must be an ISO timestamp or epoch milliseconds`);
  }

  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fail(`${name} must include a time (ISO timestamp or epoch milliseconds), not just a date`);
  }

  // Explicit offset/UTC: Date.parse is unambiguous, so keep the previous behaviour.
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) fail(`${name} must be an ISO timestamp or epoch milliseconds`);
    return ms;
  }

  // Naive ISO wall-clock: resolve it in the profile timezone.
  const naive = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/,
  );
  if (!naive) fail(`${name} must be an ISO timestamp or epoch milliseconds`);
  const [, year, month, dayText, hourText, minuteText, secondText, fraction] = naive;
  const day = `${year}-${month}-${dayText}`;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? "0");
  if (!isDay(day) || hour > 23 || minute > 59 || second > 59) {
    fail(`${name} must be a valid local date and time`);
  }
  const millis = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;
  return localTimeMs(day, `${hourText}:${minuteText}:${String(second).padStart(2, "0")}`, getTimezone()) + millis;
}

/** The provenance a legacy `estimated`-only row implies. New rows always store a source. */
export function effectiveMacroSource(row: {
  macroSource?: string | null;
  estimated?: number | boolean | null;
}): MacroSource {
  const source = row.macroSource;
  if (source === "label" || source === "usda" || source === "recipe" || source === "estimated") {
    return source;
  }
  return row.estimated ? "estimated" : "label";
}

type EntryComputation = {
  name: string;
  grams: number;
  foodId: number | null;
  weightSource: WeightSource;
  macroSource: MacroSource;
  gramsAs: FoodState;
  rawEquivalentGrams: number;
  basisState: FoodState;
  basisYieldFactor: number;
  macros: Macros;
};

function entryMacros(entry: Record<string, unknown>): EntryComputation {
  const foodId =
    entry.foodId === undefined || entry.foodId === null || entry.foodId === ""
      ? null
      : idField(entry.foodId, "foodId");
  const food = foodId === null ? null : getFood(foodId);

  const gramsInput = numField(entry.grams, "grams", { min: 0.1, max: 20_000 });
  const measure =
    entry.measure === undefined || entry.measure === null
      ? null
      : resolveMeasureGrams(entry.measure, food?.measuresJson ?? null, "measure");
  const weighed = gramsInput ?? measure?.grams ?? null;
  if (weighed === null) fail("each entry needs grams or measure");

  const weightSourceInput =
    entry.weightSource === undefined || entry.weightSource === null
      ? null
      : enumField(entry.weightSource, "weightSource", WEIGHT_SOURCES)!;
  const weightSource: WeightSource =
    weightSourceInput ?? (measure !== null && gramsInput === null ? "counted" : "weighed");
  const macroSourceInput =
    entry.macroSource === undefined || entry.macroSource === null
      ? null
      : enumField(entry.macroSource, "macroSource", MACRO_SOURCES)!;
  const estimatedFlag = entry.estimated === true || entry.estimated === 1;

  const explicitState =
    entry.state === undefined || entry.state === null
      ? null
      : enumField(entry.state, "state", FOOD_STATES)!;
  // `state` only declares an inline entry's per-100 g basis. For a saved food the basis is the
  // food's own state; overriding it here would silently reinterpret its nutrition, so a caller
  // who weighed a different state must say so with gramsAs instead.
  if (food && explicitState !== null && explicitState !== food.state) {
    fail(
      `state must match the food's ${food.state} basis; send gramsAs (raw or cooked) to say what you weighed`,
    );
  }
  const basisState: FoodState = explicitState ?? (food ? (food.state as FoodState) : "raw");
  const weighedAs: FoodState =
    entry.gramsAs === undefined || entry.gramsAs === null
      ? basisState
      : (enumField(entry.gramsAs, "gramsAs", WEIGHED_STATES)! as FoodState);
  const basis = basisGrams(weighed, weighedAs, basisState, food?.yieldFactor ?? 1, "entry");

  if (food) {
    const factor = basis / 100;
    return {
      name: food.name,
      grams: weighed,
      foodId,
      weightSource,
      macroSource: macroSourceInput ?? (estimatedFlag ? "estimated" : "label"),
      gramsAs: weighedAs,
      rawEquivalentGrams: basis,
      basisState,
      basisYieldFactor: food.yieldFactor,
      macros: {
        kcal: food.kcalPer100g * factor,
        proteinG: food.proteinPer100g * factor,
        carbsG: food.carbsPer100g * factor,
        fatG: food.fatPer100g * factor,
        fibreG: food.fibrePer100g * factor,
        sodiumMg: food.sodiumPer100g * factor,
      },
    };
  }

  const name = str(entry.name, "name", { required: true, max: 200 })!;
  // Hand-entered per-100 g values and absolute macros are estimates unless stated, matching the
  // legacy `estimated` default that the UI and the 27 existing tools rely on.
  const macroSource: MacroSource = macroSourceInput ?? (entry.estimated === false ? "label" : "estimated");
  const hasPer100 = entry.per100g !== undefined || entry.per100 !== undefined;
  if (hasPer100) {
    const per100 = per100Macros(entry);
    const factor = basis / 100;
    return {
      name,
      grams: weighed,
      foodId: null,
      weightSource,
      macroSource,
      gramsAs: weighedAs,
      rawEquivalentGrams: basis,
      basisState,
      basisYieldFactor: 1,
      macros: {
        kcal: per100.kcal * factor,
        proteinG: per100.proteinG * factor,
        carbsG: per100.carbsG * factor,
        fatG: per100.fatG * factor,
        fibreG: per100.fibreG * factor,
        sodiumMg: per100.sodiumMg * factor,
      },
    };
  }
  return {
    name,
    grams: weighed,
    foodId: null,
    weightSource,
    macroSource,
    gramsAs: weighedAs,
    // Absolute macros describe the portion as eaten, so they are never rescaled by state.
    rawEquivalentGrams: basis,
    basisState,
    basisYieldFactor: 1,
    macros: macrosOf(entry, { required: true }),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Food log
 * ------------------------------------------------------------------------------------------- */

/** Insert one snapshot, nudging the eaten-at millisecond when the unique key already exists. */
function insertEntry(value: typeof foodLog.$inferInsert): FoodEntry {
  let attempt = 0;
  for (;;) {
    try {
      const row = db
        .insert(foodLog)
        .values({ ...value, eatenAtMs: value.eatenAtMs + attempt * 1000 })
        .returning()
        .get();
      if (!row) fail("meal entry was not written", 500);
      return row;
    } catch (e) {
      const unique = e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
      if (!unique || attempt >= 5) throw e;
      attempt += 1;
    }
  }
}

export function logMeal(input: Record<string, unknown>): { day: string; meal: Meal; entries: FoodEntry[] } {
  const tz = getTimezone();
  const today = localDay(Date.now(), tz);
  const now = Date.now();
  const at =
    input.eatenAt === undefined || input.eatenAt === null || input.eatenAt === ""
      ? null
      : instantField(input.eatenAt, "eatenAt");
  const day =
    input.day === undefined || input.day === null || input.day === ""
      ? null
      : dayField(input.day, "day");
  const dayOfEatenAt = at === null ? null : localDay(at, tz);
  if (day !== null && dayOfEatenAt !== null && day !== dayOfEatenAt) {
    fail(`eatenAt falls on ${dayOfEatenAt} in ${tz}, not ${day}`);
  }
  const entryDay = day ?? dayOfEatenAt ?? today;
  const meal = enumField(input.meal, "meal", MEALS)!;
  const rawEntries = input.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) fail("entries must be a non-empty array");
  if (rawEntries.length > 100) fail("at most 100 entries per call");

  const baseTime = at ?? (entryDay === today ? now : localTimeMs(entryDay, "12:00", tz));
  const values = rawEntries.map((raw, i) => {
    if (!raw || typeof raw !== "object") fail("each entry must be an object");
    const entry = raw as Record<string, unknown>;
    const computed = entryMacros(entry);
    return {
      day: entryDay,
      meal,
      eatenAtMs: baseTime + i,
      foodId: computed.foodId,
      name: computed.name,
      grams: computed.grams,
      ...computed.macros,
      estimated: computed.macroSource === "estimated" ? 1 : 0,
      weightSource: computed.weightSource,
      macroSource: computed.macroSource,
      gramsAs: computed.gramsAs,
      rawEquivalentGrams: computed.rawEquivalentGrams,
      basisState: computed.basisState,
      basisYieldFactor: computed.basisYieldFactor,
      recipeId: null,
      servingNo: null,
      servingFraction: null,
      recipeServingJson: null,
      note: str(entry.note, "note", { max: 1000 }),
      createdAtMs: now,
      updatedAtMs: now,
    } satisfies typeof foodLog.$inferInsert;
  });

  // One transaction: a partially inserted meal must never be committed (an agent retry would
  // duplicate the rows that did land).
  const insertAll = sqlite.transaction((rows: (typeof values)[number][]) =>
    rows.map((value) => insertEntry(value)),
  );

  return { day: entryDay, meal, entries: insertAll(values) };
}

export type RecipeLogResult = {
  day: string;
  meal: Meal;
  recipeId: number;
  servingNo: number;
  servingFraction: number;
  /** True when at least one ingredient had no food-resolved nutrition. */
  incomplete: boolean;
  unresolvedIngredients: string[];
  /** How `ingredientOverrides` amounts were interpreted; null when no override was sent. */
  amountBasis: "batch" | "serving" | null;
  entry: FoodEntry;
  ingredients: LoggedIngredient[];
};

type ParsedOverride = {
  ingredientId: number | null;
  foodId: number | null;
  grams: number | null;
  /** Raw measure input; resolved against the matched food's own measures later. */
  measureInput: unknown;
  gramsAs: FoodState | null;
};

/**
 * Parse `ingredientOverrides` before touching the database.
 *
 * `amountBasis` is required whenever overrides are sent: `batch` means the grams are for the
 * whole recipe (divided by servings), `serving` means the grams are already one serving. Making
 * the caller state it prevents an ambiguous 2x/0.5x interpretation of the same number.
 */
function parseOverrides(raw: unknown, amountBasis: "batch" | "serving" | null): ParsedOverride[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("ingredientOverrides must be an array");
  if (raw.length === 0) return [];
  if (raw.length > 100) fail("at most 100 ingredient overrides per log");
  if (amountBasis === null) {
    fail("amountBasis is required with ingredientOverrides: use 'batch' (whole recipe) or 'serving' (one serving)");
  }
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`ingredientOverrides[${index}] must be an object`);
    }
    const input = value as Record<string, unknown>;
    const hasIngredientId =
      input.ingredientId !== undefined && input.ingredientId !== null && input.ingredientId !== "";
    const hasFoodId = input.foodId !== undefined && input.foodId !== null && input.foodId !== "";
    if (!hasIngredientId && !hasFoodId) {
      fail(`ingredientOverrides[${index}] needs ingredientId or foodId`);
    }
    const ingredientId = hasIngredientId
      ? idField(input.ingredientId, `ingredientOverrides[${index}].ingredientId`)
      : null;
    const foodId = hasFoodId ? idField(input.foodId, `ingredientOverrides[${index}].foodId`) : null;
    const grams = numField(input.grams, `ingredientOverrides[${index}].grams`, {
      min: 0.1,
      max: 20_000,
    });
    const measureInput =
      input.measure === undefined || input.measure === null ? null : input.measure;
    if (grams === null && measureInput === null) {
      fail(`ingredientOverrides[${index}] needs grams or measure`);
    }
    if (grams !== null && measureInput !== null) {
      fail(`ingredientOverrides[${index}] must use grams or measure, not both`);
    }
    const gramsAs =
      input.gramsAs === undefined || input.gramsAs === null || input.gramsAs === ""
        ? null
        : (enumField(input.gramsAs, `ingredientOverrides[${index}].gramsAs`, WEIGHED_STATES)! as FoodState);
    return { ingredientId, foodId, grams, measureInput, gramsAs };
  });
}

/** Map overrides onto the recipe's ingredient list, rejecting duplicates and ambiguity. */
function matchOverrides(
  overrides: ParsedOverride[],
  ingredients: ReturnType<typeof recipeTotals>["ingredients"],
): Map<number, ParsedOverride> {
  const matched = new Map<number, ParsedOverride>();
  for (const [index, override] of overrides.entries()) {
    const candidates = ingredients.filter((ingredient) => {
      if (override.ingredientId !== null) return ingredient.id === override.ingredientId;
      return override.foodId !== null && ingredient.foodId === override.foodId;
    });
    if (candidates.length === 0) {
      fail(
        override.ingredientId !== null
          ? `ingredientOverrides[${index}]: ingredient ${override.ingredientId} is not in this recipe`
          : `ingredientOverrides[${index}]: food ${override.foodId} is not in this recipe`,
        404,
      );
    }
    if (candidates.length > 1) {
      fail(
        `ingredientOverrides[${index}]: food ${override.foodId} appears more than once; use ingredientId to choose one`,
      );
    }
    const ingredient = candidates[0];
    if (override.ingredientId !== null && override.foodId !== null && ingredient.foodId !== override.foodId) {
      fail(
        `ingredientOverrides[${index}]: ingredient ${override.ingredientId} is not food ${override.foodId}`,
      );
    }
    if (matched.has(ingredient.id)) {
      fail(`ingredientOverrides[${index}]: ingredient ${ingredient.id} is overridden more than once`);
    }
    matched.set(ingredient.id, override);
  }
  return matched;
}

/**
 * Log one serving of a recipe as an immutable `food_log` snapshot plus one
 * `food_log_ingredients` row per ingredient.
 *
 * `ingredientOverrides` changes quantities for this meal only (the recipe definition is never
 * edited). The per-serving values are stored on the row and on every child, so a later recipe
 * edit, archive or delete cannot move what was already eaten, and `meal_update` resizes from
 * that stored snapshot.
 */
export function logRecipe(input: Record<string, unknown>): RecipeLogResult {
  const recipeId = idField(input.recipeId ?? input.id, "recipeId");
  const { recipe, ingredients, unresolved, ingredientCount } = recipeTotals(recipeId);
  if (recipe.archivedAtMs !== null) {
    fail(`recipe "${recipe.name}" is archived; archived recipes cannot be logged`, 409);
  }
  if (unresolved.length > 0 && unresolved.length === ingredientCount) {
    fail(`recipe "${recipe.name}" has no food-resolved ingredients; add a foodId before logging`);
  }
  const incomplete = unresolved.length > 0;
  const tz = getTimezone();
  const now = Date.now();
  const today = localDay(now, tz);
  const at =
    input.eatenAt === undefined || input.eatenAt === null || input.eatenAt === ""
      ? null
      : instantField(input.eatenAt, "eatenAt");
  const day =
    input.day === undefined || input.day === null || input.day === ""
      ? null
      : dayField(input.day, "day");
  const dayOfEatenAt = at === null ? null : localDay(at, tz);
  if (day !== null && dayOfEatenAt !== null && day !== dayOfEatenAt) {
    fail(`eatenAt falls on ${dayOfEatenAt} in ${tz}, not ${day}`);
  }
  const entryDay = day ?? dayOfEatenAt ?? today;
  const meal = enumField(input.meal, "meal", MEALS)!;

  const used = new Set(
    db
      .select({ servingNo: foodLog.servingNo })
      .from(foodLog)
      .where(eq(foodLog.recipeId, recipeId))
      .all()
      .map((row) => row.servingNo)
      .filter((value): value is number => typeof value === "number"),
  );
  const requested =
    input.servingNo === undefined || input.servingNo === null || input.servingNo === ""
      ? null
      : numField(input.servingNo, "servingNo", { required: true, integer: true, min: 1, max: 1000 })!;
  if (requested !== null) {
    if (requested > recipe.servingsTotal) {
      fail(`servingNo must be between 1 and ${recipe.servingsTotal} for "${recipe.name}"`);
    }
    if (used.has(requested)) {
      fail(`serving ${requested} of "${recipe.name}" is already logged`, 409);
    }
  }
  let servingNo = requested;
  if (servingNo === null) {
    for (let n = 1; n <= recipe.servingsTotal; n += 1) {
      if (!used.has(n)) {
        servingNo = n;
        break;
      }
    }
    if (servingNo === null) {
      fail(`all ${recipe.servingsTotal} servings of "${recipe.name}" are already logged`);
    }
  }

  const fraction =
    input.servingFraction === undefined || input.servingFraction === null || input.servingFraction === ""
      ? 1
      : numField(input.servingFraction, "servingFraction", { required: true, min: 0.01, max: 100 })!;
  const weightSource =
    input.weightSource === undefined || input.weightSource === null
      ? "counted"
      : (enumField(input.weightSource, "weightSource", WEIGHT_SOURCES) as WeightSource);
  const eatenAtMs = at ?? (entryDay === today ? now : localTimeMs(entryDay, "12:00", tz));
  const name = str(input.name, "name", { max: 200 }) ?? recipe.name;

  const rawBasis = input.amountBasis;
  const amountBasis: "batch" | "serving" | null =
    rawBasis === undefined || rawBasis === null || rawBasis === ""
      ? null
      : (enumField(rawBasis, "amountBasis", ["batch", "serving"] as const) as "batch" | "serving");
  const overrides = parseOverrides(input.ingredientOverrides, amountBasis);
  if (overrides.length > 0 && amountBasis === null) {
    // parseOverrides already fails, but keep the invariant local for TypeScript.
    fail("amountBasis is required with ingredientOverrides");
  }
  if (overrides.length === 0 && amountBasis !== null) {
    fail("amountBasis only applies with ingredientOverrides");
  }
  const effectiveBasis = overrides.length > 0 ? amountBasis : null;
  const matched = matchOverrides(overrides, ingredients);
  const divisor = recipe.servingsTotal > 0 ? recipe.servingsTotal : 1;

  const snapshots: IngredientSnapshotInput[] = ingredients.map((ingredient, index) => {
    const override = matched.get(ingredient.id);
    let overrideGrams = override?.grams ?? null;
    let overrideMeasure: { name: string; count: number } | null = null;
    if (override && override.measureInput !== null) {
      const food = ingredient.foodId === null ? null : getFood(ingredient.foodId);
      const resolved = resolveMeasureGrams(
        override.measureInput,
        food?.measuresJson ?? null,
        `ingredientOverrides for ingredient ${ingredient.id}`,
      );
      overrideGrams = resolved.grams;
      overrideMeasure = { name: resolved.name, count: resolved.count };
    }
    let perServingGrams = ingredient.grams / divisor;
    if (overrideGrams !== null) {
      perServingGrams = effectiveBasis === "batch" ? overrideGrams / divisor : overrideGrams;
    }
    const gramsAs = override?.gramsAs ?? ((ingredient.state as FoodState | null) ?? "raw");
    const basisState = (ingredient.state as FoodState | null) ?? "raw";
    const yieldFactor = ingredient.yieldFactor ?? 1;
    // Resolve the per-serving amount on the food's macro basis, then apply the serving fraction.
    const perServingBasis = ingredient.resolved
      ? basisGrams(perServingGrams, gramsAs, basisState, yieldFactor, `ingredient "${ingredient.name ?? ingredient.id}"`)
      : perServingGrams;
    const perServingMacros: Macros =
      ingredient.per100g === null
        ? { ...EMPTY }
        : {
            kcal: (ingredient.per100g.kcal * perServingBasis) / 100,
            proteinG: (ingredient.per100g.proteinG * perServingBasis) / 100,
            carbsG: (ingredient.per100g.carbsG * perServingBasis) / 100,
            fatG: (ingredient.per100g.fatG * perServingBasis) / 100,
            fibreG: (ingredient.per100g.fibreG * perServingBasis) / 100,
            sodiumMg: (ingredient.per100g.sodiumMg * perServingBasis) / 100,
          };
    return {
      recipeId,
      recipeIngredientId: ingredient.id,
      // A dangling food reference is not written to the child FK; the name/grams are kept and
      // the ingredient is marked unresolved instead of failing the whole log.
      foodId: ingredient.resolved ? ingredient.foodId : null,
      name: ingredient.name ?? `ingredient ${ingredient.id}`,
      position: index,
      amountBasis: overrideGrams !== null ? effectiveBasis : "batch",
      grams: perServingGrams * fraction,
      perServingGrams,
      measure: overrideMeasure ?? ingredient.measure,
      gramsAs,
      foodState: ingredient.state,
      yieldFactor: ingredient.yieldFactor,
      rawEquivalentGrams: perServingBasis * fraction,
      per100g: ingredient.per100g,
      macros: {
        kcal: perServingMacros.kcal * fraction,
        proteinG: perServingMacros.proteinG * fraction,
        carbsG: perServingMacros.carbsG * fraction,
        fatG: perServingMacros.fatG * fraction,
        fibreG: perServingMacros.fibreG * fraction,
        sodiumMg: perServingMacros.sodiumMg * fraction,
      },
      resolved: ingredient.resolved,
      macroSource: ingredient.resolved ? (ingredient.source === "usda" ? "usda" : "label") : "estimated",
      weightSource,
      source: ingredient.source,
      sourceUrl: ingredient.sourceUrl,
      sourceDate: ingredient.sourceDate,
    };
  });

  const totalGrams = snapshots.reduce((sum, snapshot) => sum + snapshot.grams, 0);
  const totalBasis = snapshots.reduce((sum, snapshot) => sum + snapshot.rawEquivalentGrams, 0);
  const totalMacros = snapshots.reduce<Macros>(
    (acc, snapshot) => ({
      kcal: acc.kcal + snapshot.macros.kcal,
      proteinG: acc.proteinG + snapshot.macros.proteinG,
      carbsG: acc.carbsG + snapshot.macros.carbsG,
      fatG: acc.fatG + snapshot.macros.fatG,
      fibreG: acc.fibreG + snapshot.macros.fibreG,
      sodiumMg: acc.sodiumMg + snapshot.macros.sodiumMg,
    }),
    { ...EMPTY },
  );
  const perServingSnapshot = {
    grams: snapshots.reduce((sum, snapshot) => sum + snapshot.perServingGrams, 0),
    kcal: totalMacros.kcal / fraction,
    proteinG: totalMacros.proteinG / fraction,
    carbsG: totalMacros.carbsG / fraction,
    fatG: totalMacros.fatG / fraction,
    fibreG: totalMacros.fibreG / fraction,
    sodiumMg: totalMacros.sodiumMg / fraction,
    estimated: incomplete,
    snapshotVersion: 2,
    ingredientCount: snapshots.length,
  };

  const entry = sqlite.transaction(() => {
    const row = insertEntry({
      day: entryDay,
      meal,
      eatenAtMs,
      foodId: null,
      name,
      grams: totalGrams,
      kcal: totalMacros.kcal,
      proteinG: totalMacros.proteinG,
      carbsG: totalMacros.carbsG,
      fatG: totalMacros.fatG,
      fibreG: totalMacros.fibreG,
      sodiumMg: totalMacros.sodiumMg,
      estimated: incomplete ? 1 : 0,
      weightSource,
      macroSource: incomplete ? "estimated" : "recipe",
      // A composite does not have one weighed state; each child snapshot carries its own.
      gramsAs: null,
      rawEquivalentGrams: totalBasis,
      basisState: null,
      basisYieldFactor: null,
      recipeId,
      servingNo,
      servingFraction: fraction,
      recipeServingJson: JSON.stringify(perServingSnapshot),
      note: str(input.note, "note", { max: 1000 }),
      createdAtMs: now,
      updatedAtMs: now,
    });
    insertIngredientSnapshots(row.id, snapshots, now);
    return row;
  })();

  return {
    day: entryDay,
    meal,
    recipeId,
    servingNo,
    servingFraction: fraction,
    incomplete,
    unresolvedIngredients: unresolved.map(
      (ingredient) => ingredient.name ?? `ingredient ${ingredient.id}`,
    ),
    amountBasis: effectiveBasis,
    entry,
    ingredients: ingredientsForEntry(entry.id),
  };
}

/** Per-one-serving values captured when a recipe row was logged. */
type ServingSnapshot = { grams: number; macros: Macros; estimated: boolean };

function parseServingSnapshot(json: string | null): ServingSnapshot | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.grams !== "number" || typeof raw.kcal !== "number") return null;
    const num = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
    return {
      grams: raw.grams,
      macros: {
        kcal: raw.kcal,
        proteinG: num("proteinG"),
        carbsG: num("carbsG"),
        fatG: num("fatG"),
        fibreG: num("fibreG"),
        sodiumMg: num("sodiumMg"),
      },
      estimated: raw.estimated === true,
    };
  } catch {
    return null;
  }
}

/**
 * The snapshot wins. A row written before the per-serving snapshot existed has no recorded
 * arithmetic; rescaling it from the *current* recipe would silently rewrite history after an
 * ingredient edit, so it is refused with a clear reason instead. Its day/meal read still labels
 * `ingredientSnapshotComplete: false`, and explicit grams/macros edits remain possible.
 */
function servingSnapshotFor(row: FoodEntry): ServingSnapshot {
  const stored = parseServingSnapshot(row.recipeServingJson);
  if (stored) return stored;
  fail(
    "this recipe entry predates the per-serving snapshot; its historical values were never recorded. Edit grams/macros explicitly, or log the serving again from the recipe.",
    409,
  );
}

export function updateEntry(id: unknown, input: Record<string, unknown>): FoodEntry {
  const entryId = idField(id);
  const existing = db.select().from(foodLog).where(eq(foodLog.id, entryId)).get();
  if (!existing) fail("meal entry not found", 404);

  const tz = getTimezone();
  const patch: Partial<typeof foodLog.$inferInsert> = { updatedAtMs: Date.now() };
  if ("meal" in input) patch.meal = enumField(input.meal, "meal", MEALS)!;
  if ("name" in input) patch.name = str(input.name, "name", { required: true, max: 200 })!;
  if ("note" in input) patch.note = str(input.note, "note", { max: 1000 });

  const hasEatenAt = "eatenAt" in input && input.eatenAt !== null && input.eatenAt !== undefined && input.eatenAt !== "";
  const hasDay = "day" in input && input.day !== null && input.day !== undefined && input.day !== "";
  const at = hasEatenAt ? instantField(input.eatenAt, "eatenAt") : null;
  const explicitDay = hasDay ? dayField(input.day, "day") : null;
  if (at !== null && explicitDay !== null && localDay(at, tz) !== explicitDay) {
    fail(`eatenAt falls on ${localDay(at, tz)} in ${tz}, not ${explicitDay}`);
  }
  if (at !== null) {
    patch.eatenAtMs = at;
    patch.day = explicitDay ?? localDay(at, tz);
  } else if (explicitDay !== null) {
    // Moving an entry to another day keeps its wall-clock time (including seconds) on that day.
    patch.day = explicitDay;
    patch.eatenAtMs = localTimeMs(explicitDay, formatClockSeconds(existing.eatenAtMs, tz), tz);
  }

  const hasServingNo = "servingNo" in input && input.servingNo !== null && input.servingNo !== undefined && input.servingNo !== "";
  const hasServingFraction =
    "servingFraction" in input &&
    input.servingFraction !== null &&
    input.servingFraction !== undefined &&
    input.servingFraction !== "";
  if (existing.recipeId !== null || existing.recipeServingJson !== null) {
    if (hasServingFraction && "grams" in input) {
      fail("pass servingFraction or grams, not both");
    }
    if (hasServingNo) {
      if (existing.recipeId === null) {
        fail("this entry is a copied recipe snapshot, not a live recipe; servingNo cannot be changed");
      }
      const requested = numField(input.servingNo, "servingNo", {
        required: true,
        integer: true,
        min: 1,
        max: 1000,
      })!;
      const { recipe } = recipeTotals(existing.recipeId);
      if (requested > recipe.servingsTotal) {
        fail(`servingNo must be between 1 and ${recipe.servingsTotal} for "${recipe.name}"`);
      }
      const clash = db
        .select({ id: foodLog.id })
        .from(foodLog)
        .where(
          and(
            eq(foodLog.recipeId, existing.recipeId),
            eq(foodLog.servingNo, requested),
            sql`${foodLog.id} <> ${entryId}`,
          ),
        )
        .get();
      if (clash) fail(`serving ${requested} of "${recipe.name}" is already logged`, 409);
      patch.servingNo = requested;
    }
    if (hasServingFraction) {
      patch.servingFraction = numField(input.servingFraction, "servingFraction", {
        required: true,
        min: 0.01,
        max: 100,
      })!;
    }
  } else if (hasServingFraction || hasServingNo) {
    fail("servingFraction and servingNo only apply to entries logged from a recipe");
  }

  const hasMacros = [
    "kcal",
    "calories",
    "proteinG",
    "protein",
    "carbsG",
    "carbs",
    "fatG",
    "fat",
    "fibreG",
    "fiberG",
    "fibre",
    "fiber",
    "sodiumMg",
    "sodium",
  ].some((key) => key in input);
  const wantsReshape = "grams" in input || "gramsAs" in input || "state" in input;
  const isRecipeEntry = existing.recipeId !== null || existing.recipeServingJson !== null;
  const childRows = isRecipeEntry ? ingredientsForEntry(entryId) : [];
  if (hasMacros && isRecipeEntry) {
    if (hasServingFraction || hasServingNo) {
      fail("pass servingFraction/servingNo or macros, not both", 400);
    }
    if (childRows.length > 0) {
      fail(
        "recipe entry macros are derived from its recorded ingredients; edit servingFraction/grams or use food_history_refresh instead",
        409,
      );
    }
  }
  const wantsRecipeRescale =
    isRecipeEntry && !hasMacros && (wantsReshape || hasServingFraction);
  /** Set when a recipe entry is resized: child snapshots are rescaled in the same transaction. */
  let rescaleTo: number | null = null;

  if (hasMacros) {
    const grams = numField(input.grams ?? existing.grams, "grams", { required: true, min: 0.1, max: 20_000 })!;
    const pick = (names: string[], fallback: number) => {
      const key = names.find((n) => n in input);
      return key === undefined ? fallback : numField(input[key], names[0], { min: 0 }) ?? fallback;
    };
    patch.grams = grams;
    patch.kcal = pick(["kcal", "calories"], existing.kcal);
    patch.proteinG = pick(["proteinG", "protein"], existing.proteinG);
    patch.carbsG = pick(["carbsG", "carbs"], existing.carbsG);
    patch.fatG = pick(["fatG", "fat"], existing.fatG);
    patch.fibreG = pick(["fibreG", "fiberG", "fibre", "fiber"], existing.fibreG);
    patch.sodiumMg = pick(["sodiumMg", "sodium"], existing.sodiumMg);

    // An explicit macro edit still has to keep the weight provenance truthful: refresh the
    // food basis with the saved yield factor instead of leaving rawEquivalent stale or using 1.
    if (wantsReshape) {
      const food = existing.foodId === null ? null : getFood(existing.foodId);
      const explicitState =
        "state" in input && input.state != null
          ? (enumField(input.state, "state", FOOD_STATES) as FoodState)
          : null;
      if (food && explicitState !== null && explicitState !== food.state) {
        fail(
          `state must match the food's ${food.state} basis; send gramsAs (raw or cooked) to say what you weighed`,
        );
      }
      const state =
        explicitState ??
        (food ? (food.state as FoodState) : ((existing.gramsAs as FoodState | null) ?? "raw"));
      const weighedAs =
        "gramsAs" in input && input.gramsAs != null
          ? (enumField(input.gramsAs, "gramsAs", WEIGHED_STATES) as FoodState)
          : ((existing.gramsAs as FoodState | null) ?? state);
      patch.gramsAs = weighedAs;
      patch.rawEquivalentGrams = basisGrams(grams, weighedAs, state, food?.yieldFactor ?? 1, "meal_update");
      patch.basisState = state;
      patch.basisYieldFactor = food?.yieldFactor ?? 1;
    }
  } else if (wantsRecipeRescale) {
    if (
      ("gramsAs" in input && input.gramsAs != null && input.gramsAs !== "raw") ||
      ("state" in input && input.state != null && input.state !== "raw")
    ) {
      fail("recipe servings are stored on the recipe's raw/as-stated basis; edit servingFraction or grams instead");
    }
    // Always from the stored per-serving snapshot: repeated edits do not drift, and a later
    // recipe edit cannot rewrite what was already logged.
    const snapshot = servingSnapshotFor(existing);
    const fraction = hasServingFraction
      ? numField(input.servingFraction, "servingFraction", { required: true, min: 0.01, max: 100 })!
      : "grams" in input
        ? snapshot.grams > 0
          ? numField(input.grams, "grams", { required: true, min: 0.1, max: 20_000 })! / snapshot.grams
          : fail("recipe serving has zero grams; pass servingFraction instead")
        : existing.servingFraction ?? 1;
    const grams = snapshot.grams * fraction;
    rescaleTo = fraction;
    patch.grams = grams;
    patch.servingFraction = fraction;
    patch.gramsAs = null;
    patch.rawEquivalentGrams = grams;
    patch.kcal = snapshot.macros.kcal * fraction;
    patch.proteinG = snapshot.macros.proteinG * fraction;
    patch.carbsG = snapshot.macros.carbsG * fraction;
    patch.fatG = snapshot.macros.fatG * fraction;
    patch.fibreG = snapshot.macros.fibreG * fraction;
    patch.sodiumMg = snapshot.macros.sodiumMg * fraction;
    patch.macroSource = snapshot.estimated ? "estimated" : "recipe";
    patch.estimated = snapshot.estimated ? 1 : 0;
  } else if (wantsReshape) {
    const grams = numField(input.grams ?? existing.grams, "grams", { required: true, min: 0.1, max: 20_000 })!;
    if (existing.foodId !== null) {
      // Recompute from the food each time instead of compounding a ratio onto the previous row.
      const food = getFood(existing.foodId);
      const explicitState =
        "state" in input && input.state != null
          ? (enumField(input.state, "state", FOOD_STATES) as FoodState)
          : null;
      if (explicitState !== null && explicitState !== food.state) {
        fail(
          `state must match the food's ${food.state} basis; send gramsAs (raw or cooked) to say what you weighed`,
        );
      }
      const state = explicitState ?? (food.state as FoodState);
      const weighedAs =
        "gramsAs" in input && input.gramsAs != null
          ? (enumField(input.gramsAs, "gramsAs", WEIGHED_STATES) as FoodState)
          : ((existing.gramsAs as FoodState | null) ?? state);
      const basis = basisGrams(grams, weighedAs, state, food.yieldFactor, "meal_update");
      const factor = basis / 100;
      patch.grams = grams;
      patch.gramsAs = weighedAs;
      patch.rawEquivalentGrams = basis;
      patch.basisState = state;
      patch.basisYieldFactor = food.yieldFactor;
      patch.kcal = food.kcalPer100g * factor;
      patch.proteinG = food.proteinPer100g * factor;
      patch.carbsG = food.carbsPer100g * factor;
      patch.fatG = food.fatPer100g * factor;
      patch.fibreG = food.fibrePer100g * factor;
      patch.sodiumMg = food.sodiumPer100g * factor;
    } else {
      // An inline entry has no source table to read; scale its own immutable basis once.
      const oldBasis = existing.rawEquivalentGrams ?? existing.grams;
      const factor = oldBasis > 0 ? grams / oldBasis : 1;
      patch.grams = grams;
      patch.rawEquivalentGrams = grams;
      patch.basisState = (existing.basisState as FoodState | null) ?? (existing.gramsAs as FoodState | null) ?? "raw";
      patch.basisYieldFactor = 1;
      patch.kcal = existing.kcal * factor;
      patch.proteinG = existing.proteinG * factor;
      patch.carbsG = existing.carbsG * factor;
      patch.fatG = existing.fatG * factor;
      patch.fibreG = existing.fibreG * factor;
      patch.sodiumMg = existing.sodiumMg * factor;
    }
  }

  if ("weightSource" in input) {
    patch.weightSource = enumField(input.weightSource, "weightSource", WEIGHT_SOURCES) as WeightSource;
  }
  if ("macroSource" in input) {
    const source = enumField(input.macroSource, "macroSource", MACRO_SOURCES) as MacroSource;
    patch.macroSource = source;
    patch.estimated = source === "estimated" ? 1 : 0;
  } else if ("estimated" in input) {
    const flag = input.estimated === true || input.estimated === 1;
    const current = (patch.macroSource as MacroSource | undefined) ?? effectiveMacroSource(existing);
    patch.macroSource = flag ? "estimated" : current === "estimated" ? "label" : current;
    patch.estimated = flag ? 1 : 0;
  }

  const now = Date.now();
  try {
    return sqlite.transaction(() => {
      if (rescaleTo !== null) {
        // Child snapshots are rescaled from their own per-serving amounts. If there are no
        // children (an aggregate-only legacy row) nothing is invented; the parent still
        // rescales from its stored JSON and the day view labels the snapshot incomplete.
        const children = rescaleIngredientSnapshots(existing, rescaleTo, now);
        if (children.length > 0) {
          const totals = totalsFromIngredients(children);
          patch.grams = totals.grams;
          patch.rawEquivalentGrams = totals.rawEquivalentGrams;
          patch.kcal = totals.macros.kcal;
          patch.proteinG = totals.macros.proteinG;
          patch.carbsG = totals.macros.carbsG;
          patch.fatG = totals.macros.fatG;
          patch.fibreG = totals.macros.fibreG;
          patch.sodiumMg = totals.macros.sodiumMg;
          patch.estimated = totals.estimated ? 1 : 0;
          patch.macroSource = totals.estimated ? "estimated" : "recipe";
        }
      }
      const row = db.update(foodLog).set(patch).where(eq(foodLog.id, entryId)).returning().get()!;
      if (rescaleTo !== null) {
        writeRevision({
          foodLogId: entryId,
          reason: "serving_rescale",
          previousJson: entryJson(existing),
          newJson: entryJson(row),
          createdAtMs: now,
        });
      }
      return row;
    })();
  } catch (e) {
    // The unique key is (day, meal, eaten_at_ms, name). A move onto an occupied slot is a
    // caller-visible conflict, not a 500.
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      fail("another entry already has that day, meal, time and name; choose a different time", 409);
    }
    throw e;
  }
}

export type MealEntryDetail = LoggedIngredientEntry;

/** One logged entry with its full per-ingredient snapshot (or an honest `incomplete` label). */
export function getEntry(id: unknown): MealEntryDetail {
  const row = db.select().from(foodLog).where(eq(foodLog.id, idField(id))).get();
  if (!row) fail("meal entry not found", 404);
  return withIngredientSnapshots([row])[0];
}

export function deleteEntry(id: unknown): { deleted: boolean } {
  const entryId = idField(id);
  const row = sqlite.transaction(() => {
    deleteEntrySnapshotRows(entryId);
    return db.delete(foodLog).where(eq(foodLog.id, entryId)).returning().get();
  })();
  if (!row) fail("meal entry not found", 404);
  return { deleted: true };
}

export type DayNutrition = {
  day: string;
  timezone: string;
  targets: Targets;
  entries: LoggedIngredientEntry[];
  meals: Record<Meal, LoggedIngredientEntry[]>;
  totals: Macros;
  remaining: Macros;
  progress: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  estimatedEntries: number;
  estimatedKcal: number;
  /** Share of the day's kcal whose macros are estimated, 0..1. */
  estimatedKcalShare: number;
};

export function dayNutrition(day: string = localDay(Date.now(), getTimezone())): DayNutrition {
  const tz = getTimezone();
  if (!isDay(day)) fail("day must be YYYY-MM-DD");
  const entries = withIngredientSnapshots(
    db
      .select()
      .from(foodLog)
      .where(eq(foodLog.day, day))
      .orderBy(foodLog.eatenAtMs)
      .all(),
  );
  const targets = resolveTargets(day);
  const totals = sumMacros(entries);
  const meals = {
    breakfast: entries.filter((e) => e.meal === "breakfast"),
    lunch: entries.filter((e) => e.meal === "lunch"),
    dinner: entries.filter((e) => e.meal === "dinner"),
    snack: entries.filter((e) => e.meal === "snack"),
  };
  const pct = (value: number, target: number) => (target > 0 ? (value / target) * 100 : 0);
  const estimated = entries.filter((entry) => effectiveMacroSource(entry) === "estimated");
  const estimatedKcal = estimated.reduce((sum, entry) => sum + entry.kcal, 0);
  return {
    day,
    timezone: tz,
    targets,
    entries,
    meals,
    totals,
    remaining: {
      kcal: Math.round((targets.kcal - totals.kcal) * 100) / 100,
      proteinG: Math.round((targets.proteinG - totals.proteinG) * 100) / 100,
      carbsG: Math.round((targets.carbsG - totals.carbsG) * 100) / 100,
      fatG: Math.round((targets.fatG - totals.fatG) * 100) / 100,
      fibreG: Math.round((targets.fibreG - totals.fibreG) * 100) / 100,
      sodiumMg: Math.round((targets.sodiumMg - totals.sodiumMg) * 100) / 100,
    },
    progress: {
      kcal: pct(totals.kcal, targets.kcal),
      proteinG: pct(totals.proteinG, targets.proteinG),
      carbsG: pct(totals.carbsG, targets.carbsG),
      fatG: pct(totals.fatG, targets.fatG),
    },
    estimatedEntries: estimated.length,
    estimatedKcal,
    estimatedKcalShare: totals.kcal > 0 ? Math.round((estimatedKcal / totals.kcal) * 10_000) / 10_000 : 0,
  };
}

export type NutritionDayTotals = Macros & {
  day: string;
  entries: number;
  targetKcal: number;
};

export function nutritionRange(days = 7, endDay?: string): NutritionDayTotals[] {
  const tz = getTimezone();
  const end = endDay === undefined || endDay === "" ? localDay(Date.now(), tz) : dayField(endDay, "endDay");
  const capped = Number.isFinite(days) && days >= 1 ? Math.min(Math.trunc(days), 366) : 7;
  const start = addDays(end, -(capped - 1));
  const rows = sqlite
    .prepare(
      `SELECT day, COUNT(*) AS entries, SUM(kcal) AS kcal, SUM(protein_g) AS proteinG,
              SUM(carbs_g) AS carbsG, SUM(fat_g) AS fatG, SUM(fibre_g) AS fibreG, SUM(sodium_mg) AS sodiumMg
       FROM food_log WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`,
    )
    .all(start, end) as (Macros & { day: string; entries: number })[];
  return rows.map((r) => ({ ...r, targetKcal: resolveTargets(r.day).kcal }));
}

/** Recent distinct foods eaten, for the quick-add list. */
export function recentFoods(limit = 12): { name: string; foodId: number | null; grams: number; kcal: number }[] {
  const capped = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 50) : 12;
  return sqlite
    .prepare(
      `SELECT name, food_id AS foodId, grams, kcal FROM food_log
       WHERE id IN (SELECT MAX(id) FROM food_log GROUP BY name)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(capped) as { name: string; foodId: number | null; grams: number; kcal: number }[];
}

/** Duplicate a day's entries onto `toDay`; existing rows are left alone. */
export function copyDay(fromDay: string, toDay: string): { copied: number; toDay: string } {
  if (!isDay(fromDay) || !isDay(toDay)) fail("fromDay and toDay must be YYYY-MM-DD");
  if (fromDay === toDay) fail("fromDay and toDay must differ");
  const tz = getTimezone();
  const source = db.select().from(foodLog).where(eq(foodLog.day, fromDay)).orderBy(foodLog.eatenAtMs).all();
  if (source.length === 0) fail(`no food logged on ${fromDay}`, 404);

  const now = Date.now();
  const insertAll = sqlite.transaction(() => {
    let copied = 0;
    for (const [index, entry] of source.entries()) {
      // Keep the wall-clock time of the source entry but move it to the target day. The
      // millisecond offset keeps same-minute entries distinct under the unique key.
      const hh = formatClockSeconds(entry.eatenAtMs, tz);
      const eatenAtMs = localTimeMs(toDay, hh, tz) + index;
      try {
        // The snapshot values are copied as-is, including the full per-ingredient child rows.
        // Recipe linkage is cleared so the copy is a separate eat, not a re-use of the same
        // `serving_no` (which would corrupt the remaining-servings count). The stored
        // per-serving JSON and fraction stay, so the copied entry is still rescalable.
        const copiedRow = db
          .insert(foodLog)
          .values({
            day: toDay,
            meal: entry.meal,
            eatenAtMs,
            foodId: entry.foodId,
            name: entry.name,
            grams: entry.grams,
            kcal: entry.kcal,
            proteinG: entry.proteinG,
            carbsG: entry.carbsG,
            fatG: entry.fatG,
            fibreG: entry.fibreG,
            sodiumMg: entry.sodiumMg,
            estimated: entry.estimated,
            weightSource: entry.weightSource,
            macroSource: entry.macroSource,
            gramsAs: entry.gramsAs,
            rawEquivalentGrams: entry.rawEquivalentGrams,
            basisState: entry.basisState,
            basisYieldFactor: entry.basisYieldFactor,
            recipeId: null,
            servingNo: null,
            servingFraction: entry.servingFraction,
            recipeServingJson: entry.recipeServingJson,
            note: entry.note,
            createdAtMs: now,
            updatedAtMs: now,
          })
          .returning({ id: foodLog.id })
          .get()!;
        copyIngredientSnapshots(entry.id, copiedRow.id, now);
        copied += 1;
      } catch (e) {
        // Only "already copied" is expected. Anything else must abort the whole copy.
        if (!(e instanceof Error) || !/UNIQUE constraint failed/i.test(e.message)) throw e;
      }
    }
    return copied;
  });

  return { copied: insertAll(), toDay };
}
