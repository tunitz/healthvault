/**
 * Nutrition service additions on a scratch database.
 *
 * Covers bounded/paginated `listFoods` and `listRecipes`, id-keyed `updateFood` (partial edits,
 * rename collisions, revisions) and the read surfaces `getFoodRevisions` /
 * `listEntryRevisions`. The recipe-serving suite proves the read-only preview and the write path
 * share one arithmetic implementation, including both override bases, and that a preview leaves
 * the database bytes untouched. Never reads real health data or opens `data/health.db`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-nutrition-services-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";
const DAY = "2026-11-12";

let nutrition: typeof import("@/lib/services/nutrition");
let recipes: typeof import("@/lib/services/recipes");
let logSnapshots: typeof import("@/lib/services/food-log-snapshots");
let profileService: typeof import("@/lib/services/profile");
let ValidationError: typeof import("@/lib/validate").ValidationError;
let sqlite: import("better-sqlite3").Database;

let sequence = 0;

function addFood(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return nutrition.addFood({
    name: `Food ${sequence}`,
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

function rowCount(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** Main database plus its WAL: a read must not change either file. */
function databaseBytes(): string {
  const file = process.env.DATABASE_PATH!;
  const main = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  const wal = existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`) : Buffer.alloc(0);
  return createHash("sha256").update(main).update(wal).digest("hex");
}

beforeAll(async () => {
  nutrition = await import("@/lib/services/nutrition");
  recipes = await import("@/lib/services/recipes");
  logSnapshots = await import("@/lib/services/food-log-snapshots");
  profileService = await import("@/lib/services/profile");
  ({ ValidationError } = await import("@/lib/validate"));
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM food_log_revisions").run();
  sqlite.prepare("DELETE FROM food_log_ingredients").run();
  sqlite.prepare("DELETE FROM food_log").run();
  sqlite.prepare("DELETE FROM recipe_ingredients").run();
  sqlite.prepare("DELETE FROM recipes").run();
  sqlite.prepare("DELETE FROM food_revisions").run();
  sqlite.prepare("DELETE FROM foods").run();
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("listFoods", () => {
  test("searches name or brand and paginates with a total", () => {
    addFood({ name: "Alpha oats", brand: "Brand A" });
    addFood({ name: "Beta rice", brand: "Alpha brand" });
    addFood({ name: "Gamma stew" });

    const all = nutrition.listFoods({});
    expect(all.total).toBe(3);
    expect(all.items.length).toBe(3);
    expect(all.items[0].name).toBe("Gamma stew"); // updated_at_ms DESC, id DESC
    expect(all.items[0].measures).toBeDefined();

    const found = nutrition.listFoods({ query: "alpha" });
    expect(new Set(found.items.map((food) => food.name))).toEqual(
      new Set(["Alpha oats", "Beta rice"]),
    );

    const page = nutrition.listFoods({ limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);
    expect(page.items.length).toBe(1);
    expect(page.items[0].name).toBe("Beta rice");
  });

  test("caps the page size and clamps a zero limit without changing searchFoods", () => {
    for (let i = 0; i < 5; i += 1) addFood();

    expect(nutrition.listFoods({ limit: 10_000 }).limit).toBe(100);
    expect(nutrition.listFoods({ limit: 0 }).limit).toBe(1);
    expect(nutrition.listFoods({ limit: 10_000 }).items.length).toBe(5);
    expect(nutrition.searchFoods(null, 10_000).length).toBe(5); // still bounded by the old cap
  });
});

describe("updateFood", () => {
  test("updates by id, keeps omitted optional fields and records a revision", () => {
    const original = addFood({
      name: "Oats",
      brand: "Acme",
      barcode: "123456",
      servingGrams: 40,
      per100g: { kcal: 100, proteinG: 10, carbsG: 60, fatG: 6, fibreG: 4, sodiumMg: 2 },
      measures: { cup: 80 },
      source: "label",
      sourceUrl: "https://example.test/oats",
      sourceDate: "2026-11-01",
    });

    const updated = nutrition.updateFood(original.id, {
      name: "Rolled oats",
      per100g: { kcal: 120 },
      proteinG: 11,
    });

    expect(updated.id).toBe(original.id);
    expect(updated.name).toBe("Rolled oats");
    expect(updated.brand).toBe("Acme");
    expect(updated.barcode).toBe("123456");
    expect(updated.servingGrams).toBe(40);
    expect(updated.kcalPer100g).toBe(120);
    expect(updated.proteinPer100g).toBe(11);
    // Omitted optional macros, provenance and measures are not blanked by an edit.
    expect(updated.carbsPer100g).toBe(60);
    expect(updated.fatPer100g).toBe(6);
    expect(updated.fibrePer100g).toBe(4);
    expect(updated.sodiumPer100g).toBe(2);
    expect(updated.source).toBe("label");
    expect(updated.sourceUrl).toBe("https://example.test/oats");
    expect(updated.sourceDate).toBe("2026-11-01");
    expect(updated.measures.cup).toBe(80);

    const revisions = nutrition.getFoodRevisions(original.id);
    expect(revisions.length).toBe(1);
    expect(revisions[0].reason).toBe("food_definition_update");
    expect(revisions[0].previousJson).toContain('"name":"Oats"');
    expect(revisions[0].currentJson).toContain('"name":"Rolled oats"');
    expect(revisions[0].currentJson).toContain('"kcalPer100g":120');

    // A no-change edit refreshes updated_at_ms but must not invent a revision row.
    nutrition.updateFood(original.id, {});
    expect(nutrition.getFoodRevisions(original.id).length).toBe(1);
  });

  test("explicit null clears an optional field instead of keeping it", () => {
    const food = addFood({
      barcode: "999",
      sourceUrl: "https://example.test/old",
      sourceDate: "2026-10-01",
    });
    const cleared = nutrition.updateFood(food.id, {
      barcode: null,
      sourceUrl: null,
      sourceDate: null,
    });
    expect(cleared.barcode).toBeNull();
    expect(cleared.sourceUrl).toBeNull();
    expect(cleared.sourceDate).toBeNull();
  });

  test("never rewrites an already-logged food snapshot", () => {
    const food = addFood({
      name: "Snapshot-safe food",
      per100g: { kcal: 100, proteinG: 10, carbsG: 5, fatG: 2 },
    });
    const logged = nutrition.logMeal({
      day: DAY,
      meal: "snack",
      entries: [{ foodId: food.id, grams: 100 }],
    }).entries[0];
    expect(logged.kcal).toBe(100);

    nutrition.updateFood(food.id, { per100g: { kcal: 999, proteinG: 99 } });

    const after = nutrition.getEntry(logged.id);
    expect(after.kcal).toBe(100);
    expect(after.proteinG).toBe(10);
    expect(after.foodId).toBe(food.id);
    // The definition change is still audited even though the meal is untouched.
    expect(nutrition.getFoodRevisions(food.id).length).toBe(1);
  });

  test("supports a rename but rejects a (name, brand) collision with another row", () => {
    const first = addFood({ name: "Same name", brand: "Brand A" });
    const second = addFood({ name: "Other name", brand: "Brand A" });

    expectValidation(
      () => nutrition.updateFood(second.id, { name: "Same name" }),
      409,
      /name and brand/,
    );
    expect(nutrition.getFood(second.id).name).toBe("Other name");

    // A different brand is a different pair and is allowed.
    const renamed = nutrition.updateFood(second.id, { name: "Same name", brand: "Brand B" });
    expect(renamed.name).toBe("Same name");
    expect(renamed.brand).toBe("Brand B");
    expect(first.name).toBe("Same name");
  });

  test("reads revisions newest first and 404s a missing food", () => {
    const food = addFood();
    nutrition.updateFood(food.id, { per100g: { kcal: 110 } });
    nutrition.updateFood(food.id, { per100g: { kcal: 120 } });

    const revisions = nutrition.getFoodRevisions(food.id);
    expect(revisions.length).toBe(2);
    expect(revisions[0].currentJson).toContain('"kcalPer100g":120');
    expect(revisions[1].currentJson).toContain('"kcalPer100g":110');

    // Revisions are an audit trail with no FK; deleting an unused food keeps them readable.
    expect(nutrition.deleteFood(food.id)).toEqual({ deleted: true });
    expect(nutrition.getFoodRevisions(food.id).length).toBe(2);

    expectValidation(() => nutrition.updateFood(999_999, { name: "Missing" }), 404, /not found/);
  });
});

describe("listRecipes", () => {
  test("paginates, searches, hides archived recipes by default and marks incomplete ones", () => {
    const rice = addFood({ name: "Rice", per100g: { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3 } });
    const chicken = addFood({ name: "Chicken", per100g: { kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6 } });

    const complete = recipes.createRecipe({
      name: "Chicken rice",
      servings: 2,
      ingredients: [
        { foodId: rice.id, grams: 200 },
        { foodId: chicken.id, grams: 150 },
      ],
    });
    const incomplete = recipes.createRecipe({
      name: "Mystery stew",
      servings: 3,
      ingredients: [
        { foodId: rice.id, grams: 100 },
        { name: "Unknown herb", grams: 10 },
      ],
    });
    const archived = recipes.createRecipe({
      name: "Archived dish",
      servings: 1,
      ingredients: [{ foodId: rice.id, grams: 50 }],
    });
    nutrition.logRecipe({ recipeId: archived.id, meal: "lunch", day: DAY, servingNo: 1 });
    expect(recipes.deleteRecipe(archived.id)).toMatchObject({ deleted: false, archived: true });

    const active = recipes.listRecipes({});
    expect(active.total).toBe(2);
    expect(new Set(active.items.map((item) => item.name))).toEqual(
      new Set(["Chicken rice", "Mystery stew"]),
    );
    const completeItem = active.items.find((item) => item.id === complete.id)!;
    expect(completeItem).toMatchObject({
      name: "Chicken rice",
      servingsTotal: 2,
      archived: false,
      complete: true,
      unresolvedCount: 0,
    });
    expect(completeItem.updatedAtMs).toBeGreaterThan(0);
    const incompleteItem = active.items.find((item) => item.id === incomplete.id)!;
    expect(incompleteItem.complete).toBe(false);
    expect(incompleteItem.unresolvedCount).toBe(1);

    const withArchived = recipes.listRecipes({ includeArchived: true });
    expect(withArchived.total).toBe(3);
    expect(withArchived.items.find((item) => item.id === archived.id)?.archived).toBe(true);

    const search = recipes.listRecipes({ query: "mystery" });
    expect(search.items.map((item) => item.name)).toEqual(["Mystery stew"]);

    const page = recipes.listRecipes({ limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.items.length).toBe(1);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);

    expect(recipes.listRecipes({ limit: 10_000 }).limit).toBe(100);
    expect(recipes.listRecipes({ limit: 0 }).limit).toBe(1);
  });
});

describe("previewRecipeServing", () => {
  function servingFixture() {
    const rice = addFood({
      name: "Cooked rice",
      per100g: { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fibreG: 0.4, sodiumMg: 1 },
      state: "cooked",
    });
    const chicken = addFood({
      name: "Cooked chicken",
      per100g: { kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6, fibreG: 0, sodiumMg: 74 },
      state: "cooked",
    });
    const recipe = recipes.createRecipe({
      name: "Rice bowl",
      servings: 3,
      ingredients: [
        { foodId: rice.id, grams: 300 },
        { foodId: chicken.id, grams: 200 },
      ],
    });
    return { rice, chicken, recipe };
  }

  test("matches the logged aggregate and child snapshots exactly", () => {
    const { recipe } = servingFixture();
    const preview = recipes.previewRecipeServing({
      recipeId: recipe.id,
      servingFraction: 0.75,
    });
    const logged = nutrition.logRecipe({
      recipeId: recipe.id,
      meal: "lunch",
      day: DAY,
      servingNo: 1,
      servingFraction: 0.75,
    });

    expect(preview.recipeId).toBe(recipe.id);
    expect(preview.servingFraction).toBe(0.75);
    expect(preview.amountBasis).toBeNull();
    expect(preview.complete).toBe(true);
    expect(preview.archived).toBe(false);
    expect(preview.ingredients.length).toBe(2);

    // The editor's batch view is exactly the recipe's computed batch total.
    const detail = recipes.getRecipe(recipe.id);
    expect(preview.batch.grams).toBe(detail.total.grams);
    expect(preview.batch.macros.kcal).toBe(detail.total.macros.kcal);

    expect(preview.total.grams).toBeCloseTo(logged.entry.grams, 12);
    expect(preview.total.rawEquivalentGrams).toBeCloseTo(logged.entry.rawEquivalentGrams!, 12);
    expect(preview.total.macros.kcal).toBeCloseTo(logged.entry.kcal, 12);
    expect(preview.total.macros.proteinG).toBeCloseTo(logged.entry.proteinG, 12);
    expect(preview.total.macros.carbsG).toBeCloseTo(logged.entry.carbsG, 12);
    expect(preview.total.macros.fatG).toBeCloseTo(logged.entry.fatG, 12);

    const storedServing = JSON.parse(logged.entry.recipeServingJson!) as {
      grams: number;
      kcal: number;
      proteinG: number;
    };
    expect(preview.perServing.grams).toBe(storedServing.grams);
    expect(preview.perServing.macros.kcal).toBe(storedServing.kcal);
    expect(preview.perServing.macros.proteinG).toBe(storedServing.proteinG);

    const children = logged.ingredients;
    for (const [index, previewed] of preview.ingredients.entries()) {
      const child = children[index];
      expect(previewed.perServingGrams).toBe(child.perServingGrams);
      expect(previewed.grams).toBe(child.grams);
      expect(previewed.rawEquivalentGrams).toBeCloseTo(child.rawEquivalentGrams!, 12);
      expect(previewed.macros.kcal).toBeCloseTo(child.kcal, 12);
      expect(previewed.macros.proteinG).toBeCloseTo(child.proteinG, 12);
      const childAmountBasis = child.amountBasis;
      if (
        childAmountBasis !== "batch" &&
        childAmountBasis !== "serving" &&
        childAmountBasis !== null
      ) {
        throw new Error(`unexpected stored amountBasis: ${childAmountBasis}`);
      }
      expect(previewed.amountBasis).toBe(childAmountBasis);
    }
  });

  test("previews both override bases identically to the saved entry and never edits the recipe", () => {
    const { recipe } = servingFixture();
    const first = recipe.ingredients[0];

    for (const [index, basis] of (["batch", "serving"] as const).entries()) {
      const overrides = [{ ingredientId: first.id, grams: basis === "batch" ? 450 : 150 }];
      const preview = recipes.previewRecipeServing({
        recipeId: recipe.id,
        overrides,
        amountBasis: basis,
        servingFraction: 1,
      });
      const logged = nutrition.logRecipe({
        recipeId: recipe.id,
        meal: index === 0 ? "lunch" : "dinner",
        day: DAY,
        servingNo: index + 1,
        ingredientOverrides: overrides,
        amountBasis: basis,
      });

      expect(preview.amountBasis).toBe(basis);
      expect(preview.batch.grams).toBe(650); // 450/150×3 g rice + 200 g chicken
      expect(preview.total.macros.kcal).toBeCloseTo(logged.entry.kcal, 12);
      expect(preview.total.macros.proteinG).toBeCloseTo(logged.entry.proteinG, 12);
      expect(preview.ingredients[0].perServingGrams).toBe(logged.ingredients[0].perServingGrams);
      expect(preview.ingredients[0].amountBasis).toBe(basis);
      expect(preview.ingredients[1].amountBasis).toBe("batch");
    }

    // The saved recipe definition is untouched by either preview or per-meal overrides.
    const unchanged = recipes.getRecipe(recipe.id);
    expect(unchanged.ingredients[0].grams).toBe(300);
  });

  test("previews a draft with the same totals createRecipe computes", () => {
    const rice = addFood({
      name: "Draft rice",
      per100g: { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fibreG: 0.4, sodiumMg: 1 },
    });
    const draft = {
      name: "Draft bowl",
      servings: 2,
      ingredients: [
        { foodId: rice.id, grams: 300 },
        { name: "Unknown garnish", grams: 50 },
      ],
    };

    const preview = recipes.previewRecipeServing({ draft });
    const created = recipes.createRecipe(draft);

    expect(preview.recipeId).toBeNull();
    expect(preview.name).toBe("Draft bowl");
    expect(preview.servingsTotal).toBe(2);
    expect(preview.complete).toBe(false);
    expect(preview.unresolvedIngredients).toEqual(["Unknown garnish"]);
    expect(preview.total.grams).toBeCloseTo(created.perServing.grams, 12);
    expect(preview.total.macros.kcal).toBeCloseTo(created.perServing.macros.kcal, 12);
    expect(preview.batch.grams).toBe(created.total.grams);
    expect(preview.batch.macros.kcal).toBe(created.total.macros.kcal);
    expect(preview.perServing.macros.kcal).toBeCloseTo(created.perServing.macros.kcal, 12);
    expect(preview.ingredients[0].ingredientId).toBeLessThan(0); // synthetic draft id

    const empty = recipes.previewRecipeServing({ draft: { servings: 2, ingredients: [] } });
    expect(empty.total.macros.kcal).toBe(0);
    expect(empty.complete).toBe(false);
  });

  test("is read-only: the database bytes and every row count are unchanged", () => {
    const { recipe } = servingFixture();
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const countsBefore = {
      foodLog: rowCount("food_log"),
      ingredients: rowCount("food_log_ingredients"),
      foodLogRevisions: rowCount("food_log_revisions"),
      recipes: rowCount("recipes"),
      recipeIngredients: rowCount("recipe_ingredients"),
    };
    const bytesBefore = databaseBytes();

    const preview = recipes.previewRecipeServing({
      recipeId: recipe.id,
      servingFraction: 0.5,
    });

    expect(preview.ingredients.length).toBe(2);
    expect(databaseBytes()).toBe(bytesBefore);
    expect({
      foodLog: rowCount("food_log"),
      ingredients: rowCount("food_log_ingredients"),
      foodLogRevisions: rowCount("food_log_revisions"),
      recipes: rowCount("recipes"),
      recipeIngredients: rowCount("recipe_ingredients"),
    }).toEqual(countsBefore);
  });

  test("validates the scope and override basis like logRecipe", () => {
    const { recipe } = servingFixture();

    expectValidation(() => recipes.previewRecipeServing({}), 400, /exactly one/);
    expectValidation(
      () => recipes.previewRecipeServing({ recipeId: recipe.id, draft: { ingredients: [] } }),
      400,
      /exactly one/,
    );
    expectValidation(
      () =>
        recipes.previewRecipeServing({
          recipeId: recipe.id,
          overrides: [{ ingredientId: recipe.ingredients[0].id, grams: 10 }],
        }),
      400,
      /amountBasis/,
    );
    expectValidation(
      () => recipes.previewRecipeServing({ recipeId: recipe.id, amountBasis: "batch" }),
      400,
      /only applies/,
    );
    expectValidation(
      () => recipes.previewRecipeServing({ recipeId: 999_999 }),
      404,
      /not found/,
    );
  });
});

describe("listEntryRevisions", () => {
  test("returns the rescale audit trail newest first and 404s after deletion", () => {
    const rice = addFood({
      name: "Revision rice",
      per100g: { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3 },
    });
    const chicken = addFood({
      name: "Revision chicken",
      per100g: { kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6 },
    });
    const recipe = recipes.createRecipe({
      name: "Revision bowl",
      servings: 2,
      ingredients: [
        { foodId: rice.id, grams: 200 },
        { foodId: chicken.id, grams: 100 },
      ],
    });
    const logged = nutrition.logRecipe({
      recipeId: recipe.id,
      meal: "lunch",
      day: DAY,
      servingNo: 1,
    });

    nutrition.updateEntry(logged.entry.id, { servingFraction: 0.5 });

    const revisions = logSnapshots.listEntryRevisions(logged.entry.id);
    expect(revisions.length).toBeGreaterThanOrEqual(3); // both children + the parent row
    expect(revisions.every((revision) => revision.reason === "serving_rescale")).toBe(true);
    expect(revisions.some((revision) => revision.foodLogIngredientId !== null)).toBe(true);
    expect(revisions.some((revision) => revision.foodLogIngredientId === null)).toBe(true);
    for (const revision of revisions) {
      expect(revision.previousJson.length).toBeGreaterThan(0);
      expect(revision.newJson.length).toBeGreaterThan(0);
    }

    nutrition.deleteEntry(logged.entry.id);
    expectValidation(
      () => logSnapshots.listEntryRevisions(logged.entry.id),
      404,
      /not found/,
    );
  });
});
