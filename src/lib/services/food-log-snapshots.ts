import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { foodLogIngredients, foodLogRevisions } from "@/db/schema";
import type { FoodEntry, Macros } from "@/lib/services/nutrition";

/**
 * Per-ingredient snapshots and their audit trail.
 *
 * A `food_log` row is an immutable snapshot of what was eaten. For a recipe, the aggregate row
 * is not enough to answer "which food, how much, measured how, and on what basis" after the
 * recipe is edited or archived, so every logged ingredient is copied into
 * `food_log_ingredients`. Nothing here reads the live recipe when writing history.
 */

export type LoggedIngredient = typeof foodLogIngredients.$inferSelect;

export type IngredientSnapshotInput = {
  recipeId: number | null;
  recipeIngredientId: number | null;
  foodId: number | null;
  name: string;
  position: number;
  /** How the recipe ingredient's `measure` was stated: the recipe batch or one serving. */
  amountBasis: "batch" | "serving" | null;
  /** Amount in this logged portion (what the user ate). */
  grams: number;
  /** Amount in one serving of the recipe; rescaling uses this, never the live recipe. */
  perServingGrams: number;
  measure: { name: string; count: number } | null;
  gramsAs: string;
  foodState: string | null;
  yieldFactor: number | null;
  rawEquivalentGrams: number;
  per100g: Macros | null;
  macros: Macros;
  resolved: boolean;
  macroSource: string | null;
  weightSource: string | null;
  source: string | null;
  sourceUrl: string | null;
  sourceDate: string | null;
};

export function toIngredientRow(
  foodLogId: number,
  input: IngredientSnapshotInput,
  createdAtMs: number,
): typeof foodLogIngredients.$inferInsert {
  return {
    foodLogId,
    recipeId: input.recipeId,
    recipeIngredientId: input.recipeIngredientId,
    foodId: input.foodId,
    name: input.name,
    position: input.position,
    amountBasis: input.amountBasis,
    grams: input.grams,
    perServingGrams: input.perServingGrams,
    measureJson: input.measure ? JSON.stringify(input.measure) : null,
    gramsAs: input.gramsAs,
    foodState: input.foodState,
    yieldFactor: input.yieldFactor,
    rawEquivalentGrams: input.rawEquivalentGrams,
    kcalPer100g: input.per100g?.kcal ?? null,
    proteinPer100g: input.per100g?.proteinG ?? null,
    carbsPer100g: input.per100g?.carbsG ?? null,
    fatPer100g: input.per100g?.fatG ?? null,
    fibrePer100g: input.per100g?.fibreG ?? null,
    sodiumPer100g: input.per100g?.sodiumMg ?? null,
    kcal: input.macros.kcal,
    proteinG: input.macros.proteinG,
    carbsG: input.macros.carbsG,
    fatG: input.macros.fatG,
    fibreG: input.macros.fibreG,
    sodiumMg: input.macros.sodiumMg,
    resolved: input.resolved ? 1 : 0,
    macroSource: input.macroSource,
    weightSource: input.weightSource,
    source: input.source,
    sourceUrl: input.sourceUrl,
    sourceDate: input.sourceDate,
    createdAtMs,
  };
}

export function insertIngredientSnapshots(
  foodLogId: number,
  snapshots: IngredientSnapshotInput[],
  createdAtMs: number,
): void {
  for (const snapshot of snapshots) {
    db.insert(foodLogIngredients).values(toIngredientRow(foodLogId, snapshot, createdAtMs)).run();
  }
}

export function ingredientsForEntry(foodLogId: number): LoggedIngredient[] {
  return db
    .select()
    .from(foodLogIngredients)
    .where(eq(foodLogIngredients.foodLogId, foodLogId))
    .orderBy(foodLogIngredients.position, foodLogIngredients.id)
    .all();
}

/** One query for a day view instead of one per entry. */
export function ingredientsByEntry(foodLogIds: number[]): Map<number, LoggedIngredient[]> {
  const out = new Map<number, LoggedIngredient[]>();
  if (foodLogIds.length === 0) return out;
  const rows = db
    .select()
    .from(foodLogIngredients)
    .where(inArray(foodLogIngredients.foodLogId, foodLogIds))
    .orderBy(foodLogIngredients.foodLogId, foodLogIngredients.position, foodLogIngredients.id)
    .all();
  for (const row of rows) {
    const list = out.get(row.foodLogId) ?? [];
    list.push(row);
    out.set(row.foodLogId, list);
  }
  return out;
}

/** Copy every child row when `copy_day` duplicates an entry. */
export function copyIngredientSnapshots(
  sourceFoodLogId: number,
  targetFoodLogId: number,
  createdAtMs: number,
): number {
  const rows = ingredientsForEntry(sourceFoodLogId);
  for (const row of rows) {
    db.insert(foodLogIngredients)
      .values({
        ...row,
        id: undefined,
        foodLogId: targetFoodLogId,
        createdAtMs,
      })
      .run();
  }
  return rows.length;
}

/** `meal_delete` must not leave orphaned ingredient or revision rows behind. */
export function deleteEntrySnapshotRows(foodLogId: number): void {
  db.delete(foodLogRevisions).where(eq(foodLogRevisions.foodLogId, foodLogId)).run();
  db.delete(foodLogIngredients).where(eq(foodLogIngredients.foodLogId, foodLogId)).run();
}

export type SnapshotRevision = {
  foodLogId: number;
  foodLogIngredientId?: number | null;
  foodId?: number | null;
  reason: string;
  previousJson: string;
  newJson: string;
  createdAtMs: number;
};

export function writeRevision(revision: SnapshotRevision): void {
  db.insert(foodLogRevisions)
    .values({
      foodLogId: revision.foodLogId,
      foodLogIngredientId: revision.foodLogIngredientId ?? null,
      foodId: revision.foodId ?? null,
      reason: revision.reason,
      previousJson: revision.previousJson,
      newJson: revision.newJson,
      createdAtMs: revision.createdAtMs,
    })
    .run();
}

export function ingredientJson(row: LoggedIngredient): string {
  return JSON.stringify({
    id: row.id,
    foodLogId: row.foodLogId,
    recipeId: row.recipeId,
    recipeIngredientId: row.recipeIngredientId,
    foodId: row.foodId,
    name: row.name,
    position: row.position,
    amountBasis: row.amountBasis,
    grams: row.grams,
    perServingGrams: row.perServingGrams,
    measureJson: row.measureJson,
    gramsAs: row.gramsAs,
    foodState: row.foodState,
    yieldFactor: row.yieldFactor,
    rawEquivalentGrams: row.rawEquivalentGrams,
    kcalPer100g: row.kcalPer100g,
    proteinPer100g: row.proteinPer100g,
    carbsPer100g: row.carbsPer100g,
    fatPer100g: row.fatPer100g,
    fibrePer100g: row.fibrePer100g,
    sodiumPer100g: row.sodiumPer100g,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    fibreG: row.fibreG,
    sodiumMg: row.sodiumMg,
    resolved: row.resolved,
    macroSource: row.macroSource,
    weightSource: row.weightSource,
    source: row.source,
    sourceUrl: row.sourceUrl,
    sourceDate: row.sourceDate,
  });
}

export function entryJson(row: FoodEntry): string {
  return JSON.stringify({
    id: row.id,
    day: row.day,
    meal: row.meal,
    eatenAtMs: row.eatenAtMs,
    foodId: row.foodId,
    name: row.name,
    grams: row.grams,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    fibreG: row.fibreG,
    sodiumMg: row.sodiumMg,
    estimated: row.estimated,
    weightSource: row.weightSource,
    macroSource: row.macroSource,
    gramsAs: row.gramsAs,
    rawEquivalentGrams: row.rawEquivalentGrams,
    basisState: row.basisState,
    basisYieldFactor: row.basisYieldFactor,
    recipeId: row.recipeId,
    servingNo: row.servingNo,
    servingFraction: row.servingFraction,
    recipeServingJson: row.recipeServingJson,
    note: row.note,
  });
}

/**
 * Rescale every child of a recipe entry from its stored per-serving amount.
 *
 * `newFraction` is the serving fraction after an edit. The rows are updated from
 * `per_serving_grams`, not by compounding the previous row, so repeated edits do not drift.
 * A revision row is kept for every child that actually changes.
 */
export function rescaleIngredientSnapshots(
  entry: FoodEntry,
  newFraction: number,
  createdAtMs: number,
): LoggedIngredient[] {
  const rows = ingredientsForEntry(entry.id);
  if (rows.length === 0) return [];
  const oldFraction = entry.servingFraction && entry.servingFraction > 0 ? entry.servingFraction : 1;
  const ratio = newFraction / oldFraction;
  if (Math.abs(ratio - 1) < 1e-12) return rows;
  const updated: LoggedIngredient[] = [];
  for (const row of rows) {
    const next = {
      ...row,
      grams: row.perServingGrams * newFraction,
      rawEquivalentGrams: row.rawEquivalentGrams === null ? null : row.rawEquivalentGrams * ratio,
      kcal: row.kcal * ratio,
      proteinG: row.proteinG * ratio,
      carbsG: row.carbsG * ratio,
      fatG: row.fatG * ratio,
      fibreG: row.fibreG * ratio,
      sodiumMg: row.sodiumMg * ratio,
    };
    db.update(foodLogIngredients)
      .set({
        grams: next.grams,
        rawEquivalentGrams: next.rawEquivalentGrams,
        kcal: next.kcal,
        proteinG: next.proteinG,
        carbsG: next.carbsG,
        fatG: next.fatG,
        fibreG: next.fibreG,
        sodiumMg: next.sodiumMg,
      })
      .where(eq(foodLogIngredients.id, row.id))
      .run();
    writeRevision({
      foodLogId: entry.id,
      foodLogIngredientId: row.id,
      foodId: row.foodId,
      reason: "serving_rescale",
      previousJson: ingredientJson(row),
      newJson: ingredientJson(next),
      createdAtMs,
    });
    updated.push(next);
  }
  return updated;
}

/** Recompute a recipe entry's aggregate row from its child snapshots (never from the live recipe). */
export function totalsFromIngredients(rows: LoggedIngredient[]): {
  grams: number;
  rawEquivalentGrams: number;
  macros: Macros;
  estimated: boolean;
} {
  let grams = 0;
  let rawEquivalentGrams = 0;
  const macros: Macros = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, sodiumMg: 0 };
  for (const row of rows) {
    grams += row.grams;
    rawEquivalentGrams += row.rawEquivalentGrams ?? 0;
    macros.kcal += row.kcal;
    macros.proteinG += row.proteinG;
    macros.carbsG += row.carbsG;
    macros.fatG += row.fatG;
    macros.fibreG += row.fibreG;
    macros.sodiumMg += row.sodiumMg;
  }
  return {
    grams,
    rawEquivalentGrams,
    macros,
    // An unresolved ingredient or an ingredient whose own macros are estimated makes the
    // aggregate estimated; never silently promote the recipe to non-estimated.
    estimated: rows.some((row) => row.resolved === 0 || row.macroSource === "estimated"),
  };
}

export type LoggedIngredientEntry = FoodEntry & {
  ingredients: LoggedIngredient[];
  /** null for a plain food entry; true only when the full child snapshot exists. */
  ingredientSnapshotComplete: boolean | null;
};

/** The expected child count recorded with the parent snapshot, or null when it was not recorded. */
function expectedIngredientCount(json: string | null): number | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    return Number.isInteger(raw.ingredientCount) ? (raw.ingredientCount as number) : null;
  } catch {
    return null;
  }
}

/** Attach the full child snapshot to day-view entries and label legacy aggregate-only rows. */
export function withIngredientSnapshots(entries: FoodEntry[]): LoggedIngredientEntry[] {
  const byEntry = ingredientsByEntry(entries.map((entry) => entry.id));
  return entries.map((entry) => {
    const ingredients = byEntry.get(entry.id) ?? [];
    const isRecipeEntry = entry.recipeId !== null || entry.recipeServingJson !== null;
    const expected = expectedIngredientCount(entry.recipeServingJson);
    return {
      ...entry,
      ingredients,
      // A non-empty list is not enough: a partially deleted child snapshot must not look complete.
      ingredientSnapshotComplete: isRecipeEntry
        ? expected !== null && ingredients.length === expected
        : null,
    };
  });
}
