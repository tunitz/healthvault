/**
 * Pure helpers shared by the recipe editor, the recipe detail/log form and their server actions.
 *
 * The editor keeps its rows as strings (that is what an input holds), while the recipe service
 * accepts typed ingredient objects. Converting in one place means the live preview and the value
 * the form finally submits are built from exactly the same rules. Nothing here reads the
 * database, so importing it from a client component is safe.
 */
import type { RecipeServingPreview } from "@/lib/services/recipes";

export type RecipeFoodOption = {
  id: number;
  name: string;
  brand: string | null;
  servingGrams: number;
  state: string;
  yieldFactor: number;
  measures: Record<string, number>;
};

/** Narrow a stored food to the fields the picker needs (keeps client props small). */
export function recipeFoodOption(food: RecipeFoodOption): RecipeFoodOption {
  return {
    id: food.id,
    name: food.name,
    brand: food.brand,
    servingGrams: food.servingGrams,
    state: food.state,
    yieldFactor: food.yieldFactor,
    measures: food.measures,
  };
}

export type RecipeEditorIngredient = {
  /** Client-only React key; never sent to the server. */
  key: string;
  kind: "food" | "name";
  foodId: number | null;
  name: string;
  amount: "grams" | "measure";
  grams: string;
  measureName: string;
  measureCount: string;
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
 * Build editor rows from the stored recipe. A stored household measure is kept as the amount
 * mode so a later save does not silently replace "1 tbsp" with a rounded gram value.
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
      kind: hasFood ? "food" : "name",
      foodId: hasFood ? ingredient.foodId : null,
      name: ingredient.name ?? "",
      amount: ingredient.measure ? "measure" : "grams",
      grams: String(ingredient.grams),
      measureName: ingredient.measure?.name ?? "",
      measureCount: ingredient.measure ? String(ingredient.measure.count) : "1",
    };
  });
}

export type RecipeDraftResult =
  | { ok: true; draft: RecipeDraft }
  | { ok: false; error: string };

/**
 * Validate and convert the editor rows into the service's ingredient shape.
 *
 * This mirrors the service's own checks (name/servings bounds, a food or a name, grams or a
 * measure) so the client can disable preview/submit with a precise message. The service still
 * re-validates everything on write; this is a UX guard, not a security boundary.
 */
export function recipeDraftFromRows(
  rows: RecipeEditorIngredient[],
  name: string,
  servings: string,
  note: string,
): RecipeDraftResult {
  const trimmedName = name.trim();
  if (trimmedName === "") return { ok: false, error: "Name is required" };
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
    if (row.kind === "food" && row.foodId === null) {
      return { ok: false, error: `${label}: choose a saved food or switch it to a name` };
    }
    if (row.kind === "name" && row.name.trim() === "") {
      return { ok: false, error: `${label}: name is required` };
    }
    if (row.kind === "name" && row.name.trim().length > 200) {
      return { ok: false, error: `${label}: name must be at most 200 characters` };
    }

    if (row.amount === "measure") {
      const measureName = row.measureName.trim();
      if (measureName === "") return { ok: false, error: `${label}: measure unit is required` };
      const count = Number(row.measureCount);
      if (!Number.isFinite(count) || count <= 0) {
        return { ok: false, error: `${label}: measure count must be a positive number` };
      }
      ingredients.push({
        ...(row.kind === "food" ? { foodId: row.foodId! } : { name: row.name.trim() }),
        measure: { name: measureName, count },
      });
      continue;
    }

    const grams = Number(row.grams);
    if (!Number.isFinite(grams) || grams < 0.1 || grams > 20_000) {
      return { ok: false, error: `${label}: grams must be between 0.1 and 20000` };
    }
    ingredients.push({
      ...(row.kind === "food" ? { foodId: row.foodId! } : { name: row.name.trim() }),
      grams,
    });
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
