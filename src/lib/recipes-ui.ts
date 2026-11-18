/**
 * Pure helpers shared by the recipe editor, the recipe detail/log form and their server actions.
 *
 * The editor keeps its rows as strings (that is what an input holds), while the recipe service
 * accepts typed ingredient objects. Converting in one place means the live preview and the value
 * the form finally submits are built from exactly the same rules. Nothing here reads the
 * database, so importing it from a client component is safe — including the food option/measure
 * parsing below, which deliberately stays local rather than importing the server-only measure
 * service (that module initialises SQLite on import).
 */
import type { RecipeServingPreview } from "@/lib/services/recipes";

export type RecipeFoodOption = {
  id: number;
  name: string;
  brand: string | null;
  servingGrams: number;
  state: string;
  yieldFactor: number;
  /** Effective grams-per-unit (shared defaults with food overrides applied). */
  measures: Record<string, number>;
  /** The food's own configured units only, when the caller can supply `measuresJson`. */
  ownMeasures?: Record<string, number>;
};

/** A stored food narrowed to the picker fields. Accepts the raw `measuresJson` when available. */
export function recipeFoodOption(
  food: Omit<RecipeFoodOption, "ownMeasures"> & { measuresJson?: string | null },
): RecipeFoodOption {
  return {
    id: food.id,
    name: food.name,
    brand: food.brand,
    servingGrams: food.servingGrams,
    state: food.state,
    yieldFactor: food.yieldFactor,
    measures: food.measures,
    ...(food.measuresJson !== undefined
      ? { ownMeasures: ownMeasuresFromJson(food.measuresJson) }
      : {}),
  };
}

/** Parse per-food measure overrides without importing server code. Malformed rows are ignored. */
function ownMeasuresFromJson(json: string | null | undefined): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const unit = key.trim().toLowerCase();
      const grams = typeof value === "number" ? value : Number(value);
      if (unit && Number.isFinite(grams) && grams > 0) out[unit] = grams;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Units that are valid for one food: grams plus the food's own configured measures.
 *
 * `measures` from the food library is the *effective* map (shared defaults such as tbsp/cup plus
 * overrides), so falling back to it unfiltered would offer a blind tbsp/cup mass for ingredients
 * whose bulk density is unknown. When `ownMeasures` is present it is authoritative; otherwise we
 * subtract the shared default unit names, which leaves exactly the food-specific overrides.
 */
export function recipeUnits(
  food: Pick<RecipeFoodOption, "measures" | "ownMeasures">,
  sharedDefaults: Record<string, number> = {},
): string[] {
  const own =
    food.ownMeasures && Object.keys(food.ownMeasures).length > 0
      ? food.ownMeasures
      : Object.fromEntries(
          Object.entries(food.measures ?? {}).filter(
            ([unit, grams]) => !(unit in sharedDefaults) || sharedDefaults[unit] !== grams,
          ),
        );
  return ["g", ...Object.keys(own).filter((unit) => unit !== "g")];
}

/** Selecting a food supplies its preferred unit: its first own unit, or grams. */
export function preferredUnit(
  food: Pick<RecipeFoodOption, "measures" | "ownMeasures">,
  sharedDefaults: Record<string, number> = {},
): string {
  return recipeUnits(food, sharedDefaults).find((unit) => unit !== "g") ?? "g";
}

/** The quantity shown for a preferred unit: the food's gram serving, or one named item. */
export function defaultQuantity(
  food: Pick<RecipeFoodOption, "servingGrams">,
  unit: string,
): number {
  return unit === "g" ? food.servingGrams : 1;
}

export type RecipeEditorIngredient = {
  /** Client-only React key; never sent to the server. */
  key: string;
  foodId: number | null;
  /** Display name, kept for a legacy name-only row that is not yet linked to a saved food. */
  name: string;
  /** The number the user typed, for the whole batch. */
  quantity: string;
  /** "g" for weighed grams, or a food-specific unit (egg, clove, ...). */
  unit: string;
};

export type RecipeDraftIngredient = {
  foodId?: number;
  name?: string;
  grams?: number;
  measure?: { name: string; count: number };
};

export type RecipeDraft = {
  name: string;
  servings: number;
  note: string | null;
  ingredients: RecipeDraftIngredient[];
};

export type RecipePreviewResult =
  | { ok: true; preview: RecipeServingPreview }
  | { ok: false; error: string };

export type RecipeLogState = {
  ok: boolean;
  error?: string;
  message?: string;
  /** Present after a successful log, so the client can link to that day's totals. */
  day?: string;
  entryId?: number;
  servingNo?: number;
};

/** Re-exported so client components can type preview state without importing a server module. */
export type { RecipeServingPreview };

/**
 * Build editor rows from the stored recipe. A stored measure is kept as the unit so a later save
 * does not silently replace "2 eggs" with a rounded gram value. A name-only or dangling row keeps
 * its name and amount but has no foodId, so the editor asks the user to link a saved food.
 */
export function editorRowsFromRecipe(
  ingredients: {
    id: number;
    foodId: number | null;
    name: string | null;
    grams: number;
    measure: { name: string; count: number } | null;
    /** False for a dangling food reference: the row is shown as a name, not as a saved food. */
    resolved?: boolean;
  }[],
): RecipeEditorIngredient[] {
  return ingredients.map((ingredient) => {
    const hasFood = ingredient.foodId !== null && ingredient.resolved !== false;
    return {
      key: `ingredient-${ingredient.id}`,
      foodId: hasFood ? ingredient.foodId : null,
      name: ingredient.name ?? "",
      quantity: ingredient.measure ? String(ingredient.measure.count) : String(ingredient.grams),
      unit: ingredient.measure?.name ?? "g",
    };
  });
}

export type RecipeDraftResult =
  | { ok: true; draft: RecipeDraft }
  | { ok: false; error: string };

/**
 * Validate and convert the editor rows into the service's ingredient shape.
 *
 * Amounts are for the WHOLE BATCH; the service divides by servings when a portion is logged. A
 * row must reference a saved food — the service still accepts legacy name-only rows (MCP/API and
 * old history), but the new UI builder never produces one, and an old unlinked row must be
 * repaired by choosing a food before it can be saved. The service re-validates everything on
 * write; this is a UX guard, not a security boundary.
 */
export function recipeDraftFromRows(
  rows: RecipeEditorIngredient[],
  name: string,
  servings: string,
  note: string,
): RecipeDraftResult {
  const trimmedName = name.trim();
  if (trimmedName === "") return { ok: false, error: "Recipe name is required" };
  if (trimmedName.length > 200) return { ok: false, error: "Name must be at most 200 characters" };

  const parsedServings = Number(servings);
  if (!Number.isInteger(parsedServings) || parsedServings < 1 || parsedServings > 100) {
    return { ok: false, error: "Servings must be a whole number from 1 to 100" };
  }
  if (rows.length === 0) return { ok: false, error: "Add at least one ingredient" };
  if (rows.length > 100) return { ok: false, error: "At most 100 ingredients per recipe" };

  const ingredients: RecipeDraftIngredient[] = [];
  for (const [index, row] of rows.entries()) {
    const label = `Ingredient ${index + 1}`;
    if (row.foodId === null) {
      return { ok: false, error: `${label}: link a saved food before saving` };
    }
    const unit = row.unit.trim().toLowerCase();
    if (unit === "") return { ok: false, error: `${label}: choose a unit` };

    const quantity = Number(row.quantity);
    if (unit === "g" || unit === "gram" || unit === "grams") {
      if (!Number.isFinite(quantity) || quantity < 0.1 || quantity > 20_000) {
        return { ok: false, error: `${label}: grams must be between 0.1 and 20000` };
      }
      ingredients.push({ foodId: row.foodId, grams: quantity });
    } else {
      if (!Number.isFinite(quantity) || quantity < 0.01 || quantity > 10_000) {
        return { ok: false, error: `${label}: quantity must be a positive number` };
      }
      ingredients.push({ foodId: row.foodId, measure: { name: unit, count: quantity } });
    }
  }

  return {
    ok: true,
    draft: {
      name: trimmedName,
      servings: parsedServings,
      note: note.trim() === "" ? null : note.trim(),
      ingredients,
    },
  };
}

/**
 * The first serving number that has not been logged yet. `getRecipe` exposes every logged
 * serving but not the number to use next, so the detail page derives it from that list.
 */
export function nextServingNo(
  logged: { servingNo: number | null }[],
  servingsTotal: number,
): number | null {
  const used = new Set(
    logged
      .map((row) => row.servingNo)
      .filter((value): value is number => typeof value === "number"),
  );
  for (let n = 1; n <= servingsTotal; n += 1) {
    if (!used.has(n)) return n;
  }
  return null;
}
