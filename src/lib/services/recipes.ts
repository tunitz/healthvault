import { and, desc, eq, isNull, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { foodLog, foodLogIngredients, foods, recipeIngredients, recipes } from "@/db/schema";
import { resolveMeasureGrams } from "@/lib/services/measures";
import type { Macros } from "@/lib/services/nutrition";
import {
  amountBasisField,
  computeRecipeServing,
  servingFractionField,
  type RecipeServingIngredient,
} from "@/lib/services/recipe-serving";
import { boolField, fail, idField, numField, str } from "@/lib/validate";

/**
 * Recipes: a named composite dish with ingredient rows.
 *
 * Totals are computed from the ingredients (per-100 g × grams) every time they are read, so
 * there is no second stored copy to drift. Logging a serving writes the usual immutable
 * `food_log` snapshot; editing a recipe later never rewrites history.
 */

export type Recipe = typeof recipes.$inferSelect;
export type RecipeIngredient = typeof recipeIngredients.$inferSelect;

export type ResolvedIngredient = {
  id: number;
  foodId: number | null;
  name: string | null;
  grams: number;
  measure: { name: string; count: number } | null;
  /** False for a name-only (or dangling) ingredient: stored, exposed, but never given macros. */
  resolved: boolean;
  /** Snapshot of the food's definition used for this calculation (null when unresolved). */
  per100g: Macros | null;
  state: string | null;
  yieldFactor: number | null;
  brand: string | null;
  source: string | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  macros: Macros;
};

export type RecipeTotals = { grams: number; macros: Macros };

export type LoggedServing = {
  day: string;
  meal: string;
  servingNo: number | null;
  servingFraction: number | null;
};

export type RecipeDetail = Recipe & {
  ingredients: ResolvedIngredient[];
  total: RecipeTotals;
  perServing: RecipeTotals;
  /** False when at least one ingredient has no food-resolved nutrition. */
  complete: boolean;
  unresolvedIngredients: string[];
  remainingServings: number;
  loggedServings: LoggedServing[];
  /** Archived recipes are history: readable and rescalable, never active or loggable again. */
  archived: boolean;
};

type NormalizedIngredient = {
  foodId: number | null;
  name: string | null;
  grams: number;
  measureJson: string | null;
  position: number;
};

const EMPTY_MACROS: Macros = {
  kcal: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  fibreG: 0,
  sodiumMg: 0,
};

function foodRow(id: number) {
  const row = db.select().from(foods).where(eq(foods.id, id)).get();
  if (!row) fail("food not found", 404);
  return row;
}

/** Validate one ingredient before any insert, so a bad recipe writes nothing. */
function normalizeIngredient(raw: unknown, index: number): NormalizedIngredient {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`ingredients[${index}] must be an object`);
  }
  const input = raw as Record<string, unknown>;
  const foodId =
    input.foodId === undefined || input.foodId === null || input.foodId === ""
      ? null
      : idField(input.foodId, `ingredients[${index}].foodId`);
  // A name-only ingredient is allowed by the schema: it is stored with its grams/measure, but
  // its nutrition stays unresolved and the recipe is marked incomplete. A name is required so
  // the missing nutrition is identifiable in the output.
  const food = foodId === null ? null : foodRow(foodId);
  const name = str(input.name, `ingredients[${index}].name`, { max: 200 }) ?? food?.name ?? null;
  if (!name) fail(`ingredients[${index}] needs a name or foodId`);

  const gramsInput = numField(input.grams, `ingredients[${index}].grams`, { min: 0.1, max: 20_000 });
  const measure =
    input.measure === undefined || input.measure === null
      ? null
      : resolveMeasureGrams(input.measure, food?.measuresJson ?? null, `ingredients[${index}].measure`);
  const grams = gramsInput ?? measure?.grams ?? null;
  if (grams === null) fail(`ingredients[${index}] needs grams or measure`);

  return {
    foodId,
    name,
    grams,
    measureJson: measure ? JSON.stringify({ name: measure.name, count: measure.count }) : null,
    position: index,
  };
}

type IngredientRowLike = {
  id: number;
  foodId: number | null;
  name: string | null;
  grams: number;
  measureJson: string | null;
};

type FoodRow = typeof foods.$inferSelect;

function parseStoredMeasure(json: string | null): { name: string; count: number } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { name?: unknown; count?: unknown };
    if (typeof parsed.name === "string" && typeof parsed.count === "number") {
      return { name: parsed.name, count: parsed.count };
    }
    return null;
  } catch {
    return null;
  }
}

function resolveIngredientRow(row: IngredientRowLike, food: FoodRow | null | undefined): ResolvedIngredient {
  const factor = row.grams / 100;
  // A name-only (or dangling) ingredient keeps its grams but contributes no invented nutrition;
  // it is exposed via `resolved: false` and makes the recipe/log estimated.
  const resolved = Boolean(food);
  const per100g: Macros | null = food
    ? {
        kcal: food.kcalPer100g,
        proteinG: food.proteinPer100g,
        carbsG: food.carbsPer100g,
        fatG: food.fatPer100g,
        fibreG: food.fibrePer100g,
        sodiumMg: food.sodiumPer100g,
      }
    : null;
  const macros: Macros = food
    ? {
        kcal: food.kcalPer100g * factor,
        proteinG: food.proteinPer100g * factor,
        carbsG: food.carbsPer100g * factor,
        fatG: food.fatPer100g * factor,
        fibreG: food.fibrePer100g * factor,
        sodiumMg: food.sodiumPer100g * factor,
      }
    : { ...EMPTY_MACROS };
  return {
    id: row.id,
    foodId: row.foodId,
    name: row.name,
    grams: row.grams,
    measure: parseStoredMeasure(row.measureJson),
    resolved,
    per100g,
    state: food?.state ?? null,
    yieldFactor: food?.yieldFactor ?? null,
    brand: food?.brand ?? null,
    source: food?.source ?? null,
    sourceUrl: food?.sourceUrl ?? null,
    sourceDate: food?.sourceDate ?? null,
    macros,
  };
}

function resolveIngredients(recipeId: number): ResolvedIngredient[] {
  const rows = db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(recipeIngredients.position, recipeIngredients.id)
    .all();

  return rows.map((row) => {
    const food = row.foodId === null ? null : db.select().from(foods).where(eq(foods.id, row.foodId)).get();
    return resolveIngredientRow(row, food);
  });
}

function totalsOf(
  ingredients: ResolvedIngredient[],
  servings: number,
): { total: RecipeTotals; perServing: RecipeTotals } {
  const total = ingredients.reduce<RecipeTotals>(
    (acc, ingredient) => ({
      grams: acc.grams + ingredient.grams,
      macros: {
        kcal: acc.macros.kcal + ingredient.macros.kcal,
        proteinG: acc.macros.proteinG + ingredient.macros.proteinG,
        carbsG: acc.macros.carbsG + ingredient.macros.carbsG,
        fatG: acc.macros.fatG + ingredient.macros.fatG,
        fibreG: acc.macros.fibreG + ingredient.macros.fibreG,
        sodiumMg: acc.macros.sodiumMg + ingredient.macros.sodiumMg,
      },
    }),
    { grams: 0, macros: { ...EMPTY_MACROS } },
  );
  const divisor = servings > 0 ? servings : 1;
  const perServing: RecipeTotals = {
    grams: total.grams / divisor,
    macros: {
      kcal: total.macros.kcal / divisor,
      proteinG: total.macros.proteinG / divisor,
      carbsG: total.macros.carbsG / divisor,
      fatG: total.macros.fatG / divisor,
      fibreG: total.macros.fibreG / divisor,
      sodiumMg: total.macros.sodiumMg / divisor,
    },
  };
  return { total, perServing };
}

/** Total and per-serving values for a recipe. Throws 404 when the recipe does not exist. */
export function recipeTotals(recipeId: number): {
  recipe: Recipe;
  ingredients: ResolvedIngredient[];
  total: RecipeTotals;
  perServing: RecipeTotals;
  unresolved: ResolvedIngredient[];
  ingredientCount: number;
} {
  const recipe = db.select().from(recipes).where(eq(recipes.id, recipeId)).get();
  if (!recipe) fail("recipe not found", 404);
  const ingredients = resolveIngredients(recipeId);
  const { total, perServing } = totalsOf(ingredients, recipe.servingsTotal);
  return {
    recipe,
    ingredients,
    total,
    perServing,
    unresolved: ingredients.filter((ingredient) => !ingredient.resolved),
    ingredientCount: ingredients.length,
  };
}

export function getRecipe(id: unknown): RecipeDetail {
  const recipeId = idField(id);
  const { recipe, ingredients, total, perServing, unresolved } = recipeTotals(recipeId);
  const logged = db
    .select({
      day: foodLog.day,
      meal: foodLog.meal,
      servingNo: foodLog.servingNo,
      servingFraction: foodLog.servingFraction,
    })
    .from(foodLog)
    .where(eq(foodLog.recipeId, recipeId))
    .orderBy(foodLog.eatenAtMs)
    .all();
  const used = db
    .select({ count: sql<number>`count(distinct ${foodLog.servingNo})` })
    .from(foodLog)
    .where(eq(foodLog.recipeId, recipeId))
    .get();
  return {
    ...recipe,
    ingredients,
    total,
    perServing,
    complete: unresolved.length === 0,
    unresolvedIngredients: unresolved.map((ingredient) => ingredient.name ?? `ingredient ${ingredient.id}`),
    remainingServings: Math.max(0, recipe.servingsTotal - (used?.count ?? 0)),
    loggedServings: logged,
    archived: recipe.archivedAtMs !== null,
  };
}

export type RecipeListItem = {
  id: number;
  name: string;
  servingsTotal: number;
  updatedAtMs: number;
  archived: boolean;
  complete: boolean;
  unresolvedCount: number;
};

export type RecipeList = {
  items: RecipeListItem[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * Bounded, paginated recipe search. Archived recipes are history and are hidden unless asked for.
 * `complete` is computed from the live ingredient rows so a name-only (or dangling) ingredient is
 * never presented as known nutrition; a recipe with no ingredients is incomplete for the same
 * reason.
 */
export function listRecipes(input: Record<string, unknown> = {}): RecipeList {
  const query = str(input.query, "query", { max: 120 });
  const includeArchived = boolField(input.includeArchived, "includeArchived") ?? false;
  const requestedLimit = numField(input.limit ?? 20, "limit", { integer: true, min: 0, max: 1_000_000 }) ?? 20;
  const limit = Math.min(Math.max(1, Math.trunc(requestedLimit)), 100);
  const offset = Math.max(
    0,
    Math.trunc(numField(input.offset ?? 0, "offset", { integer: true, min: 0, max: 1_000_000 }) ?? 0),
  );

  const conditions = [];
  if (!includeArchived) conditions.push(isNull(recipes.archivedAtMs));
  if (query) conditions.push(like(recipes.name, `%${query.replace(/[%_]/g, "")}%`));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select({
      id: recipes.id,
      name: recipes.name,
      servingsTotal: recipes.servingsTotal,
      updatedAtMs: recipes.updatedAtMs,
      archivedAtMs: recipes.archivedAtMs,
      ingredientCount: sql<number>`count(${recipeIngredients.id})`,
      unresolvedCount: sql<number>`coalesce(sum(case when ${recipeIngredients.id} is not null and ${foods.id} is null then 1 else 0 end), 0)`,
    })
    .from(recipes)
    .leftJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
    .leftJoin(foods, eq(foods.id, recipeIngredients.foodId))
    .where(where)
    .groupBy(recipes.id)
    .orderBy(desc(recipes.updatedAtMs), desc(recipes.id))
    .limit(limit)
    .offset(offset)
    .all();

  const total = db
    .select({ count: sql<number>`count(*)` })
    .from(recipes)
    .where(where)
    .get();

  return {
    items: rows.map((row) => {
      const ingredientCount = Number(row.ingredientCount);
      const unresolvedCount = Number(row.unresolvedCount);
      return {
        id: row.id,
        name: row.name,
        servingsTotal: row.servingsTotal,
        updatedAtMs: row.updatedAtMs,
        archived: row.archivedAtMs !== null,
        complete: ingredientCount > 0 && unresolvedCount === 0,
        unresolvedCount,
      };
    }),
    total: total?.count ?? 0,
    limit,
    offset,
  };
}

/**
 * Resolve a not-yet-saved recipe draft exactly as `createRecipe` would validate it, without any
 * write. Ingredient ids are synthetic negatives (a draft has no rows yet); overrides on a draft
 * should therefore match by `foodId`.
 */
function resolveDraftIngredients(draft: Record<string, unknown>): ResolvedIngredient[] {
  const raw = draft.ingredients;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("draft.ingredients must be an array");
  if (raw.length > 100) fail("at most 100 ingredients per recipe");
  return raw.map((value, index) => {
    const ingredient = normalizeIngredient(value, index);
    const food = ingredient.foodId === null ? null : foodRow(ingredient.foodId);
    return resolveIngredientRow(
      {
        id: -(index + 1),
        foodId: ingredient.foodId,
        name: ingredient.name,
        grams: ingredient.grams,
        measureJson: ingredient.measureJson,
      },
      food,
    );
  });
}

export type RecipeServingPreview = {
  recipeId: number | null;
  name: string;
  servingsTotal: number;
  servingFraction: number;
  amountBasis: "batch" | "serving" | null;
  complete: boolean;
  archived: boolean;
  unresolvedIngredients: string[];
  ingredients: RecipeServingIngredient[];
  /** Whole-recipe totals (the editor's "batch" view), with overrides applied to the batch. */
  batch: { grams: number; macros: Macros };
  /**
   * The portion selected by `servingFraction` (one serving when servingFraction = 1). This is
   * exactly what `logRecipe` would save as the aggregate row.
   */
  total: { grams: number; rawEquivalentGrams: number; macros: Macros };
  perServing: { grams: number; macros: Macros };
};

/**
 * Read-only preview of one recipe serving (or a draft), using the same arithmetic as `logRecipe`.
 *
 * This performs no writes: no `food_log`, ingredient, revision or recipe row is touched. `draft`
 * lets the recipe editor calculate live totals before the recipe exists. Passing `overrides` (the
 * same shape as `ingredientOverrides`) requires an explicit `amountBasis`, exactly as logging does.
 */
export function previewRecipeServing(input: Record<string, unknown>): RecipeServingPreview {
  const hasRecipeId =
    input.recipeId !== undefined && input.recipeId !== null && input.recipeId !== "";
  const hasDraft = input.draft !== undefined && input.draft !== null && input.draft !== "";
  if (hasRecipeId === hasDraft) {
    fail("previewRecipeServing needs exactly one of recipeId or draft");
  }

  let recipeId: number | null = null;
  let name: string;
  let servingsTotal: number;
  let ingredients: ResolvedIngredient[];
  let archived = false;

  if (hasRecipeId) {
    recipeId = idField(input.recipeId, "recipeId");
    const totals = recipeTotals(recipeId);
    name = totals.recipe.name;
    servingsTotal = totals.recipe.servingsTotal;
    ingredients = totals.ingredients;
    archived = totals.recipe.archivedAtMs !== null;
  } else {
    if (!input.draft || typeof input.draft !== "object" || Array.isArray(input.draft)) {
      fail("draft must be an object");
    }
    const draft = input.draft as Record<string, unknown>;
    name = str(draft.name, "draft.name", { max: 200 }) ?? "Draft recipe";
    servingsTotal = numField(draft.servings ?? draft.servingsTotal ?? 2, "draft.servings", {
      required: true,
      integer: true,
      min: 1,
      max: 100,
    })!;
    ingredients = resolveDraftIngredients(draft);
  }

  const servingFraction = servingFractionField(input.servingFraction);
  const amountBasis = amountBasisField(input.amountBasis);
  // `overrides` is the plan's short name; `ingredientOverrides` matches `logRecipe`/the API.
  const rawOverrides =
    input.overrides !== undefined ? input.overrides : input.ingredientOverrides;
  const computation = computeRecipeServing({
    recipeId,
    servingsTotal,
    ingredients,
    rawOverrides,
    amountBasis,
    servingFraction,
    weightSource: "counted",
  });

  return {
    recipeId,
    name,
    servingsTotal,
    servingFraction,
    amountBasis: computation.amountBasis,
    complete: computation.ingredients.length > 0 && !computation.incomplete,
    archived,
    unresolvedIngredients: computation.unresolvedIngredients,
    ingredients: computation.ingredients,
    batch: computation.batch,
    total: {
      grams: computation.totalGrams,
      rawEquivalentGrams: computation.totalRawEquivalentGrams,
      macros: computation.totalMacros,
    },
    perServing: {
      grams: computation.perServing.grams,
      macros: {
        kcal: computation.perServing.kcal,
        proteinG: computation.perServing.proteinG,
        carbsG: computation.perServing.carbsG,
        fatG: computation.perServing.fatG,
        fibreG: computation.perServing.fibreG,
        sodiumMg: computation.perServing.sodiumMg,
      },
    },
  };
}

export function createRecipe(input: Record<string, unknown>): RecipeDetail {
  const name = str(input.name, "name", { required: true, max: 200 })!;
  const servings = numField(input.servings ?? input.servingsTotal ?? 2, "servings", {
    required: true,
    integer: true,
    min: 1,
    max: 100,
  })!;
  const note = str(input.note, "note", { max: 2000 });
  const rawIngredients = input.ingredients;
  if (!Array.isArray(rawIngredients) || rawIngredients.length === 0) {
    fail("ingredients must be a non-empty array");
  }
  if (rawIngredients.length > 100) fail("at most 100 ingredients per recipe");
  const ingredients = rawIngredients.map((raw, index) => normalizeIngredient(raw, index));
  const now = Date.now();

  const id = db.transaction((tx) => {
    const row = tx
      .insert(recipes)
      .values({ name, servingsTotal: servings, note, createdAtMs: now, updatedAtMs: now })
      .returning()
      .get()!;
    for (const ingredient of ingredients) {
      tx.insert(recipeIngredients)
        .values({
          recipeId: row.id,
          foodId: ingredient.foodId,
          name: ingredient.name,
          grams: ingredient.grams,
          measureJson: ingredient.measureJson,
          position: ingredient.position,
        })
        .run();
    }
    return row.id;
  });

  return getRecipe(id);
}

export function updateRecipe(id: unknown, input: Record<string, unknown>): RecipeDetail {
  const recipeId = idField(id);
  const existing = db.select().from(recipes).where(eq(recipes.id, recipeId)).get();
  if (!existing) fail("recipe not found", 404);
  if (existing.archivedAtMs !== null) {
    fail("recipe is archived; archived recipes are history and cannot be edited", 409);
  }

  const patch: Partial<typeof recipes.$inferInsert> = { updatedAtMs: Date.now() };
  if ("name" in input) patch.name = str(input.name, "name", { required: true, max: 200 })!;
  if ("servings" in input || "servingsTotal" in input) {
    patch.servingsTotal = numField(input.servings ?? input.servingsTotal, "servings", {
      required: true,
      integer: true,
      min: 1,
      max: 100,
    })!;
  }
  if ("note" in input) patch.note = str(input.note, "note", { max: 2000 });
  if (input.ingredients !== undefined) {
    const rawIngredients = input.ingredients;
    if (!Array.isArray(rawIngredients) || rawIngredients.length === 0) {
      fail("ingredients must be a non-empty array");
    }
    if (rawIngredients.length > 100) fail("at most 100 ingredients per recipe");
    const ingredients = rawIngredients.map((raw, index) => normalizeIngredient(raw, index));

    db.transaction((tx) => {
      tx.update(recipes).set(patch).where(eq(recipes.id, recipeId)).run();
      // Historical child rows keep their own copy and their original recipe_ingredient_id; they
      // reference this definition only as provenance, so replacing it does not rewrite history.
      tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId)).run();
      for (const ingredient of ingredients) {
        tx.insert(recipeIngredients)
          .values({
            recipeId,
            foodId: ingredient.foodId,
            name: ingredient.name,
            grams: ingredient.grams,
            measureJson: ingredient.measureJson,
            position: ingredient.position,
          })
          .run();
      }
    });
  } else {
    db.update(recipes).set(patch).where(eq(recipes.id, recipeId)).run();
  }

  return getRecipe(recipeId);
}

export type RecipeDeleteResult = {
  deleted: boolean;
  archived: boolean;
  /** Present when the recipe was archived instead of deleted. */
  reason?: string;
  loggedEntries?: number;
  /** Historical child rows that still name this recipe, even if their parent link was cleared. */
  snapshotIngredients?: number;
  /** Kept for backwards compatibility with the old `{ deleted }` result. */
  archivedAtMs?: number;
};

/**
 * Delete a recipe, or archive it when logged history references it.
 *
 * A logged serving is immutable history, and the full per-ingredient snapshot on that row must
 * stay readable and rescalable. Hard-deleting the recipe would destroy the only link to its
 * definition, so a referenced recipe is tombstoned (`archived_at_ms`) instead: it leaves the
 * active surface but its detail and the old logs remain. An unreferenced recipe is deleted
 * together with its own ingredient rows, so a populated recipe is never undeletable.
 */
export function deleteRecipe(id: unknown): RecipeDeleteResult {
  const recipeId = idField(id);
  const existing = db.select().from(recipes).where(eq(recipes.id, recipeId)).get();
  if (!existing) return { deleted: false, archived: false };

  const logged = db
    .select({ count: sql<number>`count(*)` })
    .from(foodLog)
    .where(eq(foodLog.recipeId, recipeId))
    .get();
  const loggedEntries = logged?.count ?? 0;
  // `copy_day` clears the parent recipe link but copies the child snapshots, whose historical
  // recipe_id still names this definition. Archiving (not deleting) keeps that path intact.
  const snapshots = db
    .select({ count: sql<number>`count(*)` })
    .from(foodLogIngredients)
    .where(eq(foodLogIngredients.recipeId, recipeId))
    .get();
  const snapshotIngredients = snapshots?.count ?? 0;

  if (loggedEntries > 0 || snapshotIngredients > 0) {
    if (existing.archivedAtMs === null) {
      const now = Date.now();
      const reasons: string[] = [];
      if (loggedEntries > 0) {
        reasons.push(`${loggedEntries} logged meal entr${loggedEntries === 1 ? "y" : "ies"}`);
      }
      if (snapshotIngredients > 0) {
        reasons.push(`${snapshotIngredients} historical ingredient snapshot${snapshotIngredients === 1 ? "" : "s"}`);
      }
      db.update(recipes)
        .set({
          archivedAtMs: now,
          archivedReason: `recipe has ${reasons.join(" and ")}; archived instead of deleted`,
          updatedAtMs: now,
        })
        .where(eq(recipes.id, recipeId))
        .run();
    }
    const current = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()!;
    return {
      deleted: false,
      archived: true,
      reason: current.archivedReason ?? "recipe has logged history",
      loggedEntries,
      snapshotIngredients,
      archivedAtMs: current.archivedAtMs ?? undefined,
    };
  }

  // No logged history: the recipe definition is the only data, so removing it (and its own
  // ingredient rows) is exactly what the user asked for.
  db.transaction((tx) => {
    tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId)).run();
    tx.delete(recipes).where(eq(recipes.id, recipeId)).run();
  });
  return { deleted: true, archived: false };
}
