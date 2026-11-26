/**
 * Stage 5b — food quantities and the recipe builder, on a scratch database.
 *
 * Pins the approved examples from the UI/UX plan: a food-specific unit resolves to grams without
 * the user typing the weight (egg 60 g/egg × 2, garlic 6 g/clove × 3), a raw solid is scaled from
 * its per-100 g reference with no 100 g cap (ampalaya 250 g → 2.5×), and a batch is divided by the
 * servings actually logged (1 of 4 = 25%, 0.5 of 4 = 12.5%). It also guards the two boundaries the
 * refinement must not cross: the UI never saves a new name-only ingredient (legacy service support
 * stays), and editing units/recipes/foods never rewrites an already-logged immutable snapshot.
 *
 * Never reads real health data or opens `data/health.db`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-recipe-quantities-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";
const DAY = "2026-11-12";

let nutrition: typeof import("@/lib/services/nutrition");
let recipes: typeof import("@/lib/services/recipes");
let measureSvc: typeof import("@/lib/services/measures");
let profileService: typeof import("@/lib/services/profile");
let ui: typeof import("@/lib/recipes-ui");
let ValidationError: typeof import("@/lib/validate").ValidationError;
let sqlite: import("better-sqlite3").Database;

let sequence = 0;

function addFood(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return nutrition.addFood({
    name: `Qty food ${sequence}`,
    per100g: { kcal: 100, proteinG: 10, carbsG: 5, fatG: 2, fibreG: 1, sodiumMg: 50 },
    ...overrides,
  });
}

function expectValidation(fn: () => unknown, status: number, pattern: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { status: number }).status).toBe(status);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected a ValidationError");
}

beforeAll(async () => {
  nutrition = await import("@/lib/services/nutrition");
  recipes = await import("@/lib/services/recipes");
  measureSvc = await import("@/lib/services/measures");
  profileService = await import("@/lib/services/profile");
  ui = await import("@/lib/recipes-ui");
  ({ ValidationError } = await import("@/lib/validate"));
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
});

beforeEach(() => {
  for (const table of [
    "food_log_revisions",
    "food_log_ingredients",
    "food_log",
    "recipe_ingredients",
    "recipes",
    "food_revisions",
    "foods",
  ]) {
    sqlite.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("food-specific units resolve to grams", () => {
  test("2 eggs configured at 60 g/egg resolve to 120 g with scaled macros", () => {
    const egg = addFood({
      name: "Jumbo egg",
      measures: { egg: 60 },
      per100g: { kcal: 140, proteinG: 13, carbsG: 1, fatG: 9 },
    });
    const recipe = recipes.createRecipe({
      name: "Egg dish",
      servings: 1,
      ingredients: [{ foodId: egg.id, measure: { name: "egg", count: 2 } }],
    });
    const ingredient = recipe.ingredients[0];

    expect(ingredient.grams).toBe(120);
    expect(ingredient.measure).toEqual({ name: "egg", count: 2 });
    // 120 g / 100 × per-100 g values. The entered count+unit are preserved, not replaced by 120.
    expect(ingredient.macros.kcal).toBeCloseTo(140 * 1.2, 12);
    expect(ingredient.macros.proteinG).toBeCloseTo(13 * 1.2, 12);
  });

  test("3 cloves configured at 6 g/clove resolve to 18 g", () => {
    const garlic = addFood({ name: "Garlic", measures: { clove: 6 } });
    const recipe = recipes.createRecipe({
      name: "Garlic dish",
      servings: 1,
      ingredients: [{ foodId: garlic.id, measure: { name: "clove", count: 3 } }],
    });
    expect(recipe.ingredients[0].grams).toBe(18);
  });

  test("raw ampalaya 250 g is accepted and scaled 2.5x with no 100 g cap", () => {
    const ampalaya = addFood({
      name: "Ampalaya, raw",
      servingGrams: 100,
      per100g: { kcal: 20, proteinG: 1, carbsG: 4, fatG: 0.2 },
    });
    const recipe = recipes.createRecipe({
      name: "Ampalaya with eggs",
      servings: 4,
      ingredients: [{ foodId: ampalaya.id, grams: 250 }],
    });
    const ingredient = recipe.ingredients[0];
    expect(ingredient.grams).toBe(250);
    expect(ingredient.macros.kcal).toBeCloseTo(20 * 2.5, 12);
    expect(ingredient.macros.carbsG).toBeCloseTo(4 * 2.5, 12);
  });

  test("unknown volume units are rejected instead of assuming 1 ml = 1 g", () => {
    const oil = addFood({ name: "Oil, unknown density" });
    expectValidation(
      () =>
        recipes.createRecipe({
          name: "Bad volume",
          servings: 2,
          ingredients: [{ foodId: oil.id, measure: { name: "ml", count: 100 } }],
        }),
      400,
      /(no gram|configure|use grams|set it on the food)/i,
    );
    // A mass the food never declared must never silently appear.
    expect(recipes.listRecipes({}).total).toBe(0);
  });

  test("a verified per-food ml mapping is allowed; an unconfigured one is never water density", () => {
    expect(
      measureSvc.resolveMeasureGrams({ name: "ml", count: 100 }, '{"ml":0.9}').grams,
    ).toBeCloseTo(90, 12);
    expectValidation(
      () => measureSvc.resolveMeasureGrams({ name: "ml", count: 100 }, null),
      400,
      /(configure|use grams|verified)/i,
    );
  });
});

describe("batch nutrition divided by servings eaten", () => {
  test("a 4-serving batch gives 25% for 1 serving and 12.5% for 0.5", () => {
    const food = addFood({ name: "Batch base", per100g: { kcal: 200, proteinG: 10 } });
    const recipe = recipes.createRecipe({
      name: "Four servings",
      servings: 4,
      ingredients: [{ foodId: food.id, grams: 400 }],
    });
    const batchKcal = recipes.getRecipe(recipe.id).total.macros.kcal; // 400/100 × 200 = 800

    const one = recipes.previewRecipeServing({ recipeId: recipe.id, servingFraction: 1 });
    const half = recipes.previewRecipeServing({ recipeId: recipe.id, servingFraction: 0.5 });

    expect(one.total.macros.kcal).toBeCloseTo(batchKcal * 0.25, 12);
    expect(half.total.macros.kcal).toBeCloseTo(batchKcal * 0.125, 12);
    expect(one.total.macros.kcal).toBeCloseTo(200, 12);
    expect(half.total.macros.kcal).toBeCloseTo(100, 12);

    const logged = nutrition.logRecipe({
      recipeId: recipe.id,
      meal: "lunch",
      day: DAY,
      servingNo: 1,
      servingFraction: 0.5,
    });
    expect(logged.entry.kcal).toBeCloseTo(half.total.macros.kcal, 12);
    expect(logged.entry.proteinG).toBeCloseTo(half.total.macros.proteinG, 12);
  });
});

describe("immutable snapshots and legacy name-only history", () => {
  test("editing food units and recipe amounts never rewrites a logged recipe serving", () => {
    const food = addFood({
      name: "Egg snapshot",
      measures: { egg: 60 },
      per100g: { kcal: 140, proteinG: 13 },
    });
    const recipe = recipes.createRecipe({
      name: "Snapshot dish",
      servings: 1,
      ingredients: [{ foodId: food.id, measure: { name: "egg", count: 2 } }],
    });
    const logged = nutrition.logRecipe({
      recipeId: recipe.id,
      meal: "dinner",
      day: DAY,
      servingNo: 1,
    });
    const before = nutrition.getEntry(logged.entry.id);
    const childBefore = logged.ingredients[0];
    expect(before.kcal).toBeCloseTo(168, 12); // 120 g × 140/100

    // Change the food's unit definition, its macros, and the saved recipe amounts/units.
    nutrition.updateFood(food.id, { measures: { egg: 80 }, per100g: { kcal: 999 } });
    recipes.updateRecipe(recipe.id, {
      servings: 2,
      ingredients: [{ foodId: food.id, measure: { name: "egg", count: 9 } }],
    });

    const after = nutrition.getEntry(logged.entry.id);
    expect(after.kcal).toBe(before.kcal);
    expect(after.proteinG).toBe(before.proteinG);
    expect(after.grams).toBe(before.grams);
    const childAfter = sqlite
      .prepare("SELECT grams, kcal FROM food_log_ingredients WHERE id = ?")
      .get(childBefore.id) as { grams: number; kcal: number };
    expect(childAfter.grams).toBe(childBefore.grams);
    expect(childAfter.kcal).toBe(childBefore.kcal);
  });

  test("legacy name-only recipes stay readable and are repaired by linking a saved food", () => {
    const food = addFood({ name: "Linked herb" });
    const recipe = recipes.createRecipe({
      name: "Legacy stew",
      servings: 2,
      ingredients: [{ name: "Mystery herb", grams: 10 }],
    });

    const before = recipes.getRecipe(recipe.id);
    expect(before.complete).toBe(false);
    expect(before.ingredients[0].resolved).toBe(false);
    expect(before.ingredients[0].grams).toBe(10); // amount kept, no invented macros
    expect(before.unresolvedIngredients).toEqual(["Mystery herb"]);

    const repaired = recipes.updateRecipe(recipe.id, {
      ingredients: [{ foodId: food.id, name: "Mystery herb", grams: 10 }],
    });
    expect(repaired.complete).toBe(true);
    expect(repaired.ingredients[0].resolved).toBe(true);
  });
});

describe("recipe UI helpers", () => {
  const sharedDefaults = { tbsp: 15, tsp: 5, kutsarita: 5, cup: 240 };

  test("a new recipe draft cannot carry a name-only ingredient", () => {
    const result = ui.recipeDraftFromRows(
      [
        { key: "a", foodId: null, name: "Unknown herb", quantity: "10", unit: "g" },
      ],
      "Stew",
      "2",
      "",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/saved food|link|choose/i);
  });

  test("quantity + unit rows map to grams or a food-specific measure", () => {
    const grams = ui.recipeDraftFromRows(
      [{ key: "a", foodId: 7, name: "Ampalaya", quantity: "250", unit: "g" }],
      "Dish",
      "4",
      "desc",
    );
    expect(grams).toMatchObject({
      ok: true,
      draft: {
        name: "Dish",
        servings: 4,
        note: "desc",
        ingredients: [{ foodId: 7, grams: 250 }],
      },
    });

    const measure = ui.recipeDraftFromRows(
      [{ key: "b", foodId: 8, name: "Egg", quantity: "2", unit: "egg" }],
      "Dish",
      "1",
      "",
    );
    expect(measure).toMatchObject({
      ok: true,
      draft: { ingredients: [{ foodId: 8, measure: { name: "egg", count: 2 } }] },
    });
  });

  test("a food offers only grams plus its own units, with a sensible default", () => {
    const egg = ui.recipeFoodOption({
      id: 1,
      name: "Jumbo egg",
      brand: null,
      servingGrams: 60,
      state: "raw",
      yieldFactor: 1,
      measures: { egg: 60, piece: 60, tbsp: 15 },
      measuresJson: '{"egg":60,"piece":60}',
    });
    expect(ui.recipeUnits(egg, sharedDefaults)).toEqual(["g", "egg", "piece"]);
    expect(ui.preferredUnit(egg, sharedDefaults)).toBe("egg");
    expect(ui.defaultQuantity(egg, "egg")).toBe(1);

    const ampalaya = ui.recipeFoodOption({
      id: 2,
      name: "Ampalaya, raw",
      brand: null,
      servingGrams: 100,
      state: "raw",
      yieldFactor: 1,
      measures: sharedDefaults,
      measuresJson: null,
    });
    expect(ui.recipeUnits(ampalaya, sharedDefaults)).toEqual(["g"]);
    expect(ui.preferredUnit(ampalaya, sharedDefaults)).toBe("g");
    expect(ui.defaultQuantity(ampalaya, "g")).toBe(100);

    // Search results carry only the effective map; a food-specific gram value still counts as a
    // valid unit, while an untouched shared default (tbsp 15 g) is not offered blindly.
    const honeyFromSearch = {
      measures: { ...sharedDefaults, tbsp: 21 },
    };
    expect(ui.recipeUnits(honeyFromSearch, sharedDefaults)).toEqual(["g", "tbsp"]);
  });

  test("editor rows preserve a legacy measure and mark a dangling food as unlinked", () => {
    const rows = ui.editorRowsFromRecipe([
      { id: 1, foodId: 9, name: "Egg", grams: 120, measure: { name: "egg", count: 2 } },
      { id: 2, foodId: null, name: "Mystery herb", grams: 10, measure: null, resolved: false },
    ]);
    expect(rows[0]).toMatchObject({ foodId: 9, quantity: "2", unit: "egg" });
    expect(rows[1]).toMatchObject({ foodId: null, name: "Mystery herb", quantity: "10", unit: "g" });
  });
});
