import { eq } from "drizzle-orm";
import { db } from "@/db";
import { foods } from "@/db/schema";
import type { IngredientSnapshotInput } from "@/lib/services/food-log-snapshots";
import { resolveMeasureGrams } from "@/lib/services/measures";
import type { FoodState, Macros } from "@/lib/services/nutrition";
import type { ResolvedIngredient } from "@/lib/services/recipes";
import { enumField, fail, idField, numField } from "@/lib/validate";

/**
 * The single recipe-serving arithmetic used by both `previewRecipeServing` (read-only) and
 * `logRecipe` (writes). Keeping one implementation is what makes it impossible for a preview to
 * show different ingredients or totals than the entry that is saved a moment later.
 *
 * The only database access here is reading the live foods referenced by the recipe/overrides to
 * resolve household measures. Nothing is written; the caller decides whether to persist the
 * returned snapshots.
 */

const EMPTY_MACROS: Macros = {
  kcal: 0,
  proteinG: 0,
  carbsG: 0,
  fatG: 0,
  fibreG: 0,
  sodiumMg: 0,
};

/**
 * Convert a weighed amount to the food's macro basis. `yieldFactor` is cooked g per raw g for a
 * raw-basis food (0.75 chicken breast) and cooked g per dry g for a dry-basis food (2.3 rice).
 * A factor of 1.0 means the food never declared a conversion, so a mismatched state is an error
 * rather than a silently 30%-wrong entry.
 */
export function basisGrams(
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

export type ParsedOverride = {
  ingredientId: number | null;
  foodId: number | null;
  grams: number | null;
  /** Raw measure input; resolved against the matched food's own measures later. */
  measureInput: unknown;
  gramsAs: FoodState | null;
};

/** Parse `amountBasis`; `null` means the caller did not declare one. */
export function amountBasisField(value: unknown): "batch" | "serving" | null {
  if (value === undefined || value === null || value === "") return null;
  return enumField(value, "amountBasis", ["batch", "serving"] as const) as "batch" | "serving";
}

/** One serving fraction; defaults to a whole serving and is always positive. */
export function servingFractionField(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  return numField(value, "servingFraction", { required: true, min: 0.01, max: 100 })!;
}

/**
 * Parse `ingredientOverrides` before touching the database.
 *
 * `amountBasis` is required whenever overrides are sent: `batch` means the grams are for the
 * whole recipe (divided by servings), `serving` means the grams are already one serving. Making
 * the caller state it prevents an ambiguous 2x/0.5x interpretation of the same number.
 */
export function parseIngredientOverrides(
  raw: unknown,
  amountBasis: "batch" | "serving" | null,
): ParsedOverride[] {
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
        : (enumField(input.gramsAs, `ingredientOverrides[${index}].gramsAs`, ["raw", "cooked"] as const)! as FoodState);
    return { ingredientId, foodId, grams, measureInput, gramsAs };
  });
}

/** Map overrides onto the recipe's ingredient list, rejecting duplicates and ambiguity. */
export function matchIngredientOverrides(
  overrides: ParsedOverride[],
  ingredients: ResolvedIngredient[],
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

/** One ingredient as it would be saved (and as the preview renders it). */
export type RecipeServingIngredient = {
  ingredientId: number;
  foodId: number | null;
  name: string;
  resolved: boolean;
  per100g: Macros | null;
  brand: string | null;
  state: string | null;
  yieldFactor: number | null;
  source: string | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  measure: { name: string; count: number } | null;
  amountBasis: "batch" | "serving" | null;
  gramsAs: string;
  /** Amount in one serving of the recipe. */
  perServingGrams: number;
  /** Amount in the previewed/logged portion (`perServingGrams × servingFraction`). */
  grams: number;
  rawEquivalentGrams: number;
  perServingMacros: Macros;
  macros: Macros;
};

export type RecipeServingComputation = {
  snapshots: IngredientSnapshotInput[];
  ingredients: RecipeServingIngredient[];
  incomplete: boolean;
  unresolvedIngredients: string[];
  amountBasis: "batch" | "serving" | null;
  servingFraction: number;
  totalGrams: number;
  totalRawEquivalentGrams: number;
  totalMacros: Macros;
  /** Whole-recipe totals: the definition with any per-meal overrides applied as batch amounts. */
  batch: { grams: number; macros: Macros };
  /** Per-one-serving values captured on a logged recipe row (`recipeServingJson`). */
  perServing: {
    grams: number;
    kcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    fibreG: number;
    sodiumMg: number;
    estimated: boolean;
    snapshotVersion: 2;
    ingredientCount: number;
  };
};

/**
 * Resolve one recipe serving from its already-resolved ingredients.
 *
 * `rawOverrides` is the caller's `ingredientOverrides` array; `amountBasis` must accompany it.
 * The portion is expressed by `servingFraction` (1 = one whole serving). Callers that persist the
 * result write exactly the returned snapshots and per-serving snapshot, so preview and log share
 * every value.
 */
export function computeRecipeServing(input: {
  recipeId: number | null;
  servingsTotal: number;
  ingredients: ResolvedIngredient[];
  rawOverrides: unknown;
  amountBasis: "batch" | "serving" | null;
  servingFraction: number;
  weightSource: string;
}): RecipeServingComputation {
  const overrides = parseIngredientOverrides(input.rawOverrides, input.amountBasis);
  if (overrides.length > 0 && input.amountBasis === null) {
    // parseIngredientOverrides already fails, but keep the invariant local for TypeScript.
    fail("amountBasis is required with ingredientOverrides");
  }
  if (overrides.length === 0 && input.amountBasis !== null) {
    fail("amountBasis only applies with ingredientOverrides");
  }
  const effectiveBasis = overrides.length > 0 ? input.amountBasis : null;
  const matched = matchIngredientOverrides(overrides, input.ingredients);
  const divisor = input.servingsTotal > 0 ? input.servingsTotal : 1;
  const fraction = input.servingFraction;
  const batchGrams: number[] = [];
  const batchMacroRows: Macros[] = [];

  const snapshots: IngredientSnapshotInput[] = input.ingredients.map((ingredient, index) => {
    const override = matched.get(ingredient.id);
    let overrideGrams = override?.grams ?? null;
    let overrideMeasure: { name: string; count: number } | null = null;
    if (override && override.measureInput !== null) {
      const food =
        ingredient.foodId === null
          ? null
          : db.select().from(foods).where(eq(foods.id, ingredient.foodId)).get();
      if (ingredient.foodId !== null && !food) fail("food not found", 404);
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
    const label = `ingredient "${ingredient.name ?? ingredient.id}"`;
    const gramsAs = override?.gramsAs ?? ((ingredient.state as FoodState | null) ?? "raw");
    const basisState = (ingredient.state as FoodState | null) ?? "raw";
    const yieldFactor = ingredient.yieldFactor ?? 1;
    // Resolve the per-serving amount on the food's macro basis, then apply the serving fraction.
    const perServingBasis = ingredient.resolved
      ? basisGrams(perServingGrams, gramsAs, basisState, yieldFactor, label)
      : perServingGrams;
    const perServingMacros: Macros =
      ingredient.per100g === null
        ? { ...EMPTY_MACROS }
        : {
            kcal: (ingredient.per100g.kcal * perServingBasis) / 100,
            proteinG: (ingredient.per100g.proteinG * perServingBasis) / 100,
            carbsG: (ingredient.per100g.carbsG * perServingBasis) / 100,
            fatG: (ingredient.per100g.fatG * perServingBasis) / 100,
            fibreG: (ingredient.per100g.fibreG * perServingBasis) / 100,
            sodiumMg: (ingredient.per100g.sodiumMg * perServingBasis) / 100,
          };

    // The whole-batch view used by the recipe editor. For an unchanged recipe this is exactly the
    // same arithmetic as `recipeTotals`, while a serving-basis override is scaled back up.
    const batchIngredientGrams =
      overrideGrams === null
        ? ingredient.grams
        : effectiveBasis === "batch"
          ? overrideGrams
          : overrideGrams * divisor;
    const batchBasis = ingredient.resolved
      ? basisGrams(batchIngredientGrams, gramsAs, basisState, yieldFactor, label)
      : batchIngredientGrams;
    const batchFactor = batchBasis / 100;
    batchGrams.push(batchIngredientGrams);
    batchMacroRows.push(
      ingredient.per100g === null
        ? { ...EMPTY_MACROS }
        : {
            kcal: ingredient.per100g.kcal * batchFactor,
            proteinG: ingredient.per100g.proteinG * batchFactor,
            carbsG: ingredient.per100g.carbsG * batchFactor,
            fatG: ingredient.per100g.fatG * batchFactor,
            fibreG: ingredient.per100g.fibreG * batchFactor,
            sodiumMg: ingredient.per100g.sodiumMg * batchFactor,
          },
    );
    return {
      recipeId: input.recipeId,
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
      weightSource: input.weightSource,
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
    { ...EMPTY_MACROS },
  );
  const unresolvedIngredients = input.ingredients
    .filter((ingredient) => !ingredient.resolved)
    .map((ingredient) => ingredient.name ?? `ingredient ${ingredient.id}`);
  const totalBatchGrams = batchGrams.reduce((sum, grams) => sum + grams, 0);
  const totalBatchMacros = batchMacroRows.reduce<Macros>(
    (acc, macros) => ({
      kcal: acc.kcal + macros.kcal,
      proteinG: acc.proteinG + macros.proteinG,
      carbsG: acc.carbsG + macros.carbsG,
      fatG: acc.fatG + macros.fatG,
      fibreG: acc.fibreG + macros.fibreG,
      sodiumMg: acc.sodiumMg + macros.sodiumMg,
    }),
    { ...EMPTY_MACROS },
  );
  return {
    snapshots,
    ingredients: input.ingredients.map((ingredient, index) => ({
      ingredientId: ingredient.id,
      foodId: ingredient.foodId,
      name: ingredient.name ?? `ingredient ${ingredient.id}`,
      resolved: ingredient.resolved,
      per100g: ingredient.per100g,
      brand: ingredient.brand,
      state: ingredient.state,
      yieldFactor: ingredient.yieldFactor,
      source: ingredient.source,
      sourceUrl: ingredient.sourceUrl,
      sourceDate: ingredient.sourceDate,
      measure: snapshots[index].measure,
      amountBasis: snapshots[index].amountBasis,
      gramsAs: snapshots[index].gramsAs,
      perServingGrams: snapshots[index].perServingGrams,
      grams: snapshots[index].grams,
      rawEquivalentGrams: snapshots[index].rawEquivalentGrams,
      perServingMacros: {
        kcal: snapshots[index].macros.kcal / fraction,
        proteinG: snapshots[index].macros.proteinG / fraction,
        carbsG: snapshots[index].macros.carbsG / fraction,
        fatG: snapshots[index].macros.fatG / fraction,
        fibreG: snapshots[index].macros.fibreG / fraction,
        sodiumMg: snapshots[index].macros.sodiumMg / fraction,
      },
      macros: snapshots[index].macros,
    })),
    incomplete: unresolvedIngredients.length > 0,
    unresolvedIngredients,
    amountBasis: effectiveBasis,
    servingFraction: fraction,
    totalGrams,
    totalRawEquivalentGrams: totalBasis,
    totalMacros,
    batch: { grams: totalBatchGrams, macros: totalBatchMacros },
    perServing: {
      grams: snapshots.reduce((sum, snapshot) => sum + snapshot.perServingGrams, 0),
      // Keep the original per-serving arithmetic and property order: the bytes stored in
      // `recipe_serving_json` must not change for an unchanged recipe/portion.
      kcal: totalMacros.kcal / fraction,
      proteinG: totalMacros.proteinG / fraction,
      carbsG: totalMacros.carbsG / fraction,
      fatG: totalMacros.fatG / fraction,
      fibreG: totalMacros.fibreG / fraction,
      sodiumMg: totalMacros.sodiumMg / fraction,
      estimated: unresolvedIngredients.length > 0,
      snapshotVersion: 2,
      ingredientCount: snapshots.length,
    },
  };
}
