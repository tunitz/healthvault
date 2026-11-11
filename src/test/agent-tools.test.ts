/**
 * Targeted service/API-surface tests for recipes, raw/cooked state, household measures and
 * provenance. Runs against a throwaway SQLite file under /tmp — never `data/health.db`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatClock, formatClockSeconds, localDay, localTimeMs } from "@/lib/day";
import { listFoodTemplates } from "@/lib/services/food-templates";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-agent-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

let nutrition: typeof import("@/lib/services/nutrition");
let recipes: typeof import("@/lib/services/recipes");
let history: typeof import("@/lib/services/food-history");
let profileService: typeof import("@/lib/services/profile");
let agentTools: typeof import("@/lib/agent-tools");
let sqlite: import("better-sqlite3").Database;
let ValidationError: typeof import("@/lib/validate").ValidationError;

const DAY = "2026-11-11";

function near(actual: number, expected: number, tolerance = 0.01) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`expected ${actual} ≈ ${expected} (±${tolerance})`);
  }
}

let ampalaya: ReturnType<typeof nutrition.addFood>;
let chicken: ReturnType<typeof nutrition.addFood>;
let honey: ReturnType<typeof nutrition.addFood>;
let coffee: ReturnType<typeof nutrition.addFood>;
let egg: ReturnType<typeof nutrition.addFood>;
let recipe: ReturnType<typeof recipes.createRecipe>;

beforeAll(async () => {
  nutrition = await import("@/lib/services/nutrition");
  recipes = await import("@/lib/services/recipes");
  history = await import("@/lib/services/food-history");
  profileService = await import("@/lib/services/profile");
  agentTools = await import("@/lib/agent-tools");
  ({ ValidationError } = await import("@/lib/validate"));
  ({ sqlite } = await import("@/db"));
});

afterAll(() => {
  try {
    sqlite?.close();
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

function columns(table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

let legacyMigrationsWritten = 0;

/** A migration folder pinned at 0002, for exercising the real upgrade path on a scratch DB. */
function writeLegacyMigrations(): string {
  const folder = join(scratchDir, `migrations-0002-${legacyMigrationsWritten}`);
  legacyMigrationsWritten += 1;
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, 3);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    copyFileSync(join(process.cwd(), "drizzle", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
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

describe("migration", () => {
  test("adds the spec columns to a fresh database and keeps integrity", () => {
    expect(columns("foods")).toContain("state");
    expect(columns("foods")).toContain("yield_factor");
    expect(columns("foods")).toContain("measures_json");
    expect(columns("foods")).toContain("source_url");
    expect(columns("foods")).toContain("source_date");
    expect(columns("food_log")).toContain("recipe_id");
    expect(columns("food_log")).toContain("serving_no");
    expect(columns("food_log")).toContain("serving_fraction");
    expect(columns("food_log")).toContain("grams_as");
    expect(columns("food_log")).toContain("raw_equivalent_grams");
    expect(columns("food_log")).toContain("basis_state");
    expect(columns("food_log")).toContain("basis_yield_factor");
    expect(columns("food_log")).toContain("weight_source");
    expect(columns("food_log")).toContain("macro_source");
    expect(columns("food_log")).toContain("recipe_serving_json");
    expect(columns("recipes")).toEqual([
      "id",
      "name",
      "servings_total",
      "note",
      "created_at_ms",
      "updated_at_ms",
      "archived_at_ms",
      "archived_reason",
    ]);
    expect(columns("recipe_ingredients")).toEqual([
      "id",
      "recipe_id",
      "food_id",
      "name",
      "grams",
      "measure_json",
      "position",
    ]);
    expect(columns("measures")).toEqual(["id", "name", "grams_default", "ml", "note"]);
    expect(columns("food_log_ingredients")).toEqual([
      "id",
      "food_log_id",
      "recipe_id",
      "recipe_ingredient_id",
      "food_id",
      "name",
      "position",
      "amount_basis",
      "grams",
      "per_serving_grams",
      "measure_json",
      "grams_as",
      "food_state",
      "yield_factor",
      "raw_equivalent_grams",
      "kcal_per_100g",
      "protein_per_100g",
      "carbs_per_100g",
      "fat_per_100g",
      "fibre_per_100g",
      "sodium_per_100g",
      "kcal",
      "protein_g",
      "carbs_g",
      "fat_g",
      "fibre_g",
      "sodium_mg",
      "resolved",
      "macro_source",
      "weight_source",
      "source",
      "source_url",
      "source_date",
      "created_at_ms",
    ]);
    expect(columns("food_revisions")).toEqual([
      "id",
      "food_id",
      "reason",
      "previous_json",
      "current_json",
      "created_at_ms",
    ]);
    expect(columns("food_log_revisions")).toEqual([
      "id",
      "food_log_id",
      "food_log_ingredient_id",
      "food_id",
      "reason",
      "previous_json",
      "new_json",
      "created_at_ms",
    ]);
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  test("seeds the household measures", () => {
    const names = (sqlite.prepare("SELECT name FROM measures ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(names).toEqual(["cup", "kutsarita", "piece", "scoop", "strip", "tbsp", "tsp"]);
  });

  test("is idempotent on an already-migrated database", async () => {
    const { db } = await import("@/db");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
    expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  test("pre-migration rows keep working through the legacy estimated fallback", () => {
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO food_log
           (day, meal, eaten_at_ms, food_id, name, grams, kcal, protein_g, carbs_g, fat_g, fibre_g,
            sodium_mg, estimated, note, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run("2026-11-09", "snack", now, "Legacy row", 100, 123, 1, 2, 3, 4, 5, 1, now, now);
    const day = nutrition.dayNutrition("2026-11-09");
    expect(day.entries.length).toBe(1);
    expect(day.entries[0].macroSource).toBeNull();
    expect(day.entries[0].gramsAs).toBeNull();
    expect(day.estimatedEntries).toBe(1);
    expect(day.estimatedKcal).toBe(123);
  });

  test("upgrades a 0002 database additively, preserving existing rows", async () => {
    const oldMigrations = writeLegacyMigrations();

    const Database = (await import("better-sqlite3")).default;
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    const raw = new Database(join(scratchDir, "upgrade.db"));
    const legacy = drizzle(raw);
    migrate(legacy, { migrationsFolder: oldMigrations });

    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO foods (name, kcal_per_100g, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)`,
      )
      .run("Legacy chicken", 165, now, now);
    const foodId = (raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    raw
      .prepare(
        `INSERT INTO food_log
           (day, meal, eaten_at_ms, food_id, name, grams, kcal, estimated, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("2026-11-08", "lunch", now, foodId, "Legacy chicken", 200, 330, 1, now, now);

    migrate(legacy, { migrationsFolder: join(process.cwd(), "drizzle") });

    const row = raw
      .prepare("SELECT name, grams, kcal, estimated, grams_as, raw_equivalent_grams, macro_source FROM food_log")
      .get() as Record<string, unknown>;
    expect(row.name).toBe("Legacy chicken");
    expect(row.grams).toBe(200);
    expect(row.kcal).toBe(330);
    expect(row.estimated).toBe(1);
    expect(row.grams_as).toBeNull();
    expect(row.raw_equivalent_grams).toBeNull();
    expect(row.macro_source).toBeNull();
    expect(
      (raw.prepare("SELECT name FROM recipes").all() as unknown[]).length,
    ).toBe(0);
    expect(raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    raw.close();
  });

  test("backfills the canonical real-log defaults without creating or overwriting foods", async () => {
    const oldMigrations = writeLegacyMigrations();
    const Database = (await import("better-sqlite3")).default;
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    const raw = new Database(join(scratchDir, "canonical-backfill.db"));
    const legacy = drizzle(raw);
    migrate(legacy, { migrationsFolder: oldMigrations });

    const now = Date.now();
    const insertFood = raw.prepare(
      "INSERT INTO foods (name, brand, kcal_per_100g, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
    );
    const canonical: [string, string | null, number][] = [
      ["Honey", null, 304],
      ["NESCAFÉ Gold, instant coffee (dry)", "Nescafé", 353],
      ["Egg, whole, raw (jumbo 60g)", null, 143],
      ["KFC Crispy Fries", "KFC Philippines", 312],
      ["Whey Protein, ACTIVE, Chocolate", "ACTIVE", 380],
      ["Chicken breast, skinless, raw", null, 120],
    ];
    const nearMisses: [string, string | null, number][] = [
      ["Honey", "Local apiary", 304], // brand must match too
      ["honey", null, 304], // exact case only
      ["NESCAFÉ Gold", "Nescafé", 353], // no suffix fuzz
      ["Egg, whole, raw", null, 143], // no size fuzz
      ["KFC Crispy Fries", "Other", 312],
      ["Whey Protein, ACTIVE", "ACTIVE", 380],
      ["Chicken breast, skinless", null, 120],
      ["Chicken breast, skinless, raw", "Farm", 120],
    ];
    for (const [name, brand, kcal] of [...canonical, ...nearMisses]) {
      insertFood.run(name, brand, kcal, now, now);
    }
    const countBefore = (raw.prepare("SELECT COUNT(*) AS c FROM foods").get() as { c: number }).c;
    const chickenId = (
      raw
        .prepare("SELECT id FROM foods WHERE name = ? AND brand IS NULL")
        .get("Chicken breast, skinless, raw") as { id: number }
    ).id;
    raw
      .prepare(
        `INSERT INTO food_log
           (day, meal, eaten_at_ms, food_id, name, grams, kcal, estimated, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("2026-11-08", "lunch", now, chickenId, "Chicken breast, skinless, raw", 200, 240, 0, now, now);

    migrate(legacy, { migrationsFolder: join(process.cwd(), "drizzle") });

    const food = (name: string, brand: string | null) => {
      const row =
        brand === null
          ? raw
              .prepare("SELECT id, measures_json, yield_factor, state, updated_at_ms FROM foods WHERE name = ? AND brand IS NULL")
              .get(name)
          : raw
              .prepare("SELECT id, measures_json, yield_factor, state, updated_at_ms FROM foods WHERE name = ? AND brand = ?")
              .get(name, brand);
      return row as {
        id: number;
        measures_json: string | null;
        yield_factor: number;
        state: string;
        updated_at_ms: number;
      };
    };

    expect(food("Honey", null).measures_json).toBe('{"kutsarita":7,"tbsp":21}');
    expect(food("NESCAFÉ Gold, instant coffee (dry)", "Nescafé").measures_json).toBe(
      '{"tbsp":6,"tsp":1.8}',
    );
    expect(food("Egg, whole, raw (jumbo 60g)", null).measures_json).toBe('{"piece":60}');
    expect(food("KFC Crispy Fries", "KFC Philippines").measures_json).toBe('{"strip":2}');
    expect(food("Whey Protein, ACTIVE, Chocolate", "ACTIVE").measures_json).toBe('{"scoop":32.4}');
    const chickenFood = food("Chicken breast, skinless, raw", null);
    expect(chickenFood.measures_json).toBeNull();
    expect(chickenFood.yield_factor).toBe(0.75);
    expect(chickenFood.state).toBe("raw");
    // The backfill is a data fix, not a user edit: timestamps are not reordered.
    expect(food("Honey", null).updated_at_ms).toBe(now);
    expect(chickenFood.updated_at_ms).toBe(now);

    for (const [name, brand] of nearMisses) {
      const row = food(name, brand);
      expect(row.measures_json).toBeNull();
      expect(row.yield_factor).toBe(1);
    }
    expect((raw.prepare("SELECT COUNT(*) AS c FROM foods").get() as { c: number }).c).toBe(countBefore);

    const logRow = raw
      .prepare("SELECT food_id, name, grams, kcal, recipe_id, macro_source FROM food_log")
      .get() as Record<string, unknown>;
    expect(logRow.food_id).toBe(chickenId);
    expect(logRow.name).toBe("Chicken breast, skinless, raw");
    expect(logRow.grams).toBe(200);
    expect(logRow.kcal).toBe(240);
    expect(logRow.recipe_id).toBeNull();
    expect(logRow.macro_source).toBeNull();

    // Re-running the backfill statements is idempotent and never overwrites edited data.
    const migrationSql = readFileSync(
      join(process.cwd(), "drizzle", "0003_recipes_measures_provenance.sql"),
      "utf8",
    );
    const backfill = migrationSql.match(/UPDATE `foods`[\s\S]*?;/g) ?? [];
    expect(backfill.length).toBe(6);
    const honeyId = food("Honey", null).id;
    raw.prepare("UPDATE foods SET measures_json = ? WHERE id = ?").run('{"kutsarita":9}', honeyId);
    raw.prepare("UPDATE foods SET yield_factor = ? WHERE id = ?").run(0.9, chickenId);
    for (const statement of backfill) raw.exec(statement);
    expect(food("Honey", null).measures_json).toBe('{"kutsarita":9}');
    expect(food("Chicken breast, skinless, raw", null).yield_factor).toBe(0.9);
    for (const statement of backfill) raw.exec(statement);
    expect(food("Egg, whole, raw (jumbo 60g)", null).measures_json).toBe('{"piece":60}');
    expect(food("Whey Protein, ACTIVE, Chocolate", "ACTIVE").measures_json).toBe('{"scoop":32.4}');

    expect(raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    raw.close();
  });
});

describe("foods: state, yield factor, measures and source", () => {
  test("create and update keep omitted fields and expose effective measures", () => {
    ampalaya = nutrition.addFood({
      name: "Ampalaya",
      per100g: { kcal: 17, proteinG: 1, carbsG: 3.7, fatG: 0.17, fibreG: 2.8, sodiumMg: 5 },
    });
    expect(ampalaya.state).toBe("raw");
    expect(ampalaya.yieldFactor).toBe(1);
    const updated = nutrition.addFood({
      name: "Ampalaya",
      per100g: { kcal: 17, proteinG: 1, carbsG: 3.7, fatG: 0.17, fibreG: 2.8, sodiumMg: 5 },
      measures: { piece: 120 },
    });
    expect(updated.id).toBe(ampalaya.id);
    expect(updated.state).toBe("raw");
    expect(updated.measures.piece).toBe(120);
    expect(updated.source).toBe("manual");
  });

  test("food_search returns per-food measures", () => {
    honey = nutrition.addFood({
      name: "Honey",
      per100g: { kcal: 304, proteinG: 0.3, carbsG: 82.4, fatG: 0, fibreG: 0.2, sodiumMg: 4 },
      measures: { kutsarita: 7, tbsp: 21 },
    });
    const [found] = nutrition.searchFoods("Honey", 5);
    expect(found.measures.tbsp).toBe(21);
    expect(found.measures.tsp).toBe(5); // shared default, not hardcoded by the agent
  });

  test("source metadata is preserved and a definition update is audited", () => {
    const food = nutrition.addFood({
      name: "Sourced food",
      per100g: { kcal: 100, proteinG: 5, carbsG: 10, fatG: 2, fibreG: 1, sodiumMg: 20 },
      source: "label",
      sourceUrl: "https://example.test/sourced",
      sourceDate: "2026-11-02",
    });
    expect(food.sourceUrl).toBe("https://example.test/sourced");
    expect(food.sourceDate).toBe("2026-11-02");

    const updated = nutrition.addFood({
      name: "Sourced food",
      per100g: { kcal: 90, proteinG: 5, carbsG: 10, fatG: 2, fibreG: 1, sodiumMg: 20 },
    });
    expect(updated.sourceUrl).toBe("https://example.test/sourced");
    expect(updated.sourceDate).toBe("2026-11-02");
    const revisions = sqlite
      .prepare("SELECT previous_json, current_json FROM food_revisions WHERE food_id = ?")
      .all(food.id) as { previous_json: string; current_json: string }[];
    expect(revisions.length).toBe(1);
    expect(revisions[0].previous_json).toContain('"kcalPer100g":100');
    expect(revisions[0].current_json).toContain('"kcalPer100g":90');

    // The audit row does not make an unused food undeletable.
    expect(nutrition.deleteFood(food.id)).toEqual({ deleted: true });
  });
});

describe("acceptance 1: a composite dish logged by serving", () => {
  beforeAll(() => {
    const food = (name: string, per100g: import("@/lib/services/nutrition").Macros) =>
      nutrition.addFood({ name, per100g });
    food("Oyster mushroom", { kcal: 33, proteinG: 3.31, carbsG: 6.1, fatG: 0.41, fibreG: 2.3, sodiumMg: 18 });
    food("Tomato", { kcal: 18, proteinG: 0.88, carbsG: 3.9, fatG: 0.2, fibreG: 1.2, sodiumMg: 5 });
    food("Onion", { kcal: 40, proteinG: 1.1, carbsG: 9.3, fatG: 0.1, fibreG: 1.7, sodiumMg: 4 });
    food("Garlic", { kcal: 149, proteinG: 6.36, carbsG: 33, fatG: 0.5, fibreG: 2.1, sodiumMg: 17 });
    egg = nutrition.addFood({
      name: "Jumbo egg",
      per100g: { kcal: 143, proteinG: 12.56, carbsG: 0.7, fatG: 9.51, fibreG: 0, sodiumMg: 142 },
      measures: { piece: 60 },
    });
  });

  test("totals are computed from ingredients, and servings can be booked", () => {
    const find = (name: string) => nutrition.searchFoods(name, 1)[0];
    recipe = recipes.createRecipe({
      name: "Ginisang ampalaya",
      servings: 2,
      ingredients: [
        { foodId: ampalaya.id, grams: 235 },
        { foodId: find("Oyster mushroom").id, grams: 95 },
        { foodId: find("Tomato").id, grams: 95 },
        { foodId: find("Onion").id, grams: 110 },
        { foodId: find("Garlic").id, grams: 13.5 },
        { foodId: egg.id, measure: { name: "piece", count: 2 } },
      ],
    });
    // Exact arithmetic from the saved per-100 g values and the stated weights. The spec's
    // "~160 kcal / 12 g protein / 6.3 g fat" is the earlier approximate log of this dish, not a
    // target: the saved foods give 162.0575 / 11.73555 / 6.28425 per serving.
    near(recipe.total.macros.kcal, 324.115, 1e-9);
    near(recipe.total.macros.proteinG, 23.4711, 1e-9);
    near(recipe.total.macros.fatG, 12.5685, 1e-9);
    near(recipe.perServing.macros.kcal, 162.0575, 1e-9);
    near(recipe.perServing.macros.proteinG, 11.73555, 1e-9);
    near(recipe.perServing.macros.fatG, 6.28425, 1e-9);
    const eggIngredient = recipe.ingredients.find((item) => item.foodId === egg.id)!;
    expect(eggIngredient.grams).toBe(120);
    near(eggIngredient.macros.kcal, 171.6, 1e-9);
    near(eggIngredient.macros.proteinG, 15.072, 1e-9);
    near(eggIngredient.macros.fatG, 11.412, 1e-9);

    const lunch = nutrition.logRecipe({ recipeId: recipe.id, day: DAY, meal: "lunch" });
    const dinner = nutrition.logRecipe({ recipeId: recipe.id, day: DAY, meal: "dinner" });
    expect(lunch.servingNo).toBe(1);
    expect(dinner.servingNo).toBe(2);
    expect(lunch.entry.recipeId).toBe(recipe.id);
    expect(lunch.entry.macroSource).toBe("recipe");
    expect(lunch.entry.estimated).toBe(0);
    expect(recipes.getRecipe(recipe.id).remainingServings).toBe(0);
    expectValidation(
      () => nutrition.logRecipe({ recipeId: recipe.id, day: DAY, meal: "snack" }),
      400,
      /already logged/,
    );

    const day = nutrition.dayNutrition(DAY);
    near(day.totals.kcal, 324.115, 1e-9);
    near(day.totals.proteinG, 23.4711, 1e-9);
    near(day.totals.fatG, 12.5685, 1e-9);
    expect(day.entries.length).toBe(2);
    expect(day.estimatedKcal).toBe(0);
    expect(day.estimatedEntries).toBe(0);
  });
});

describe("acceptance 2: raw vs cooked", () => {
  test("stores both weights and applies the raw-basis macros", () => {
    chicken = nutrition.addFood({
      name: "Chicken breast, skinless",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
      state: "raw",
      yieldFactor: 0.75,
    });
    const { entries } = nutrition.logMeal({
      day: "2026-11-12",
      meal: "lunch",
      entries: [{ foodId: chicken.id, grams: 215, gramsAs: "cooked" }],
    });
    const entry = entries[0];
    expect(entry.grams).toBe(215);
    expect(entry.gramsAs).toBe("cooked");
    near(entry.rawEquivalentGrams!, 286.6667, 0.01);
    near(entry.kcal, 344, 0.1);
    near(entry.proteinG, 64.5, 0.1);
    expect(entry.weightSource).toBe("weighed");
    expect(entry.macroSource).toBe("label");

    const day = nutrition.dayNutrition("2026-11-12");
    near(day.entries[0].rawEquivalentGrams!, 286.6667, 0.01);
    expect(day.entries[0].grams).toBe(215);
  });

  test("a missing yield factor fails instead of silently assuming raw", () => {
    const plain = nutrition.addFood({
      name: "Mystery meat",
      per100g: { kcal: 100 },
      state: "raw",
    });
    expectValidation(
      () =>
        nutrition.logMeal({
          day: "2026-11-12",
          meal: "snack",
          entries: [{ foodId: plain.id, grams: 100, gramsAs: "cooked" }],
        }),
      400,
      /yieldFactor/,
    );
  });
});

describe("acceptance 3: household measures resolve from the food", () => {
  test("kutsarita honey and tbsp instant coffee", () => {
    coffee = nutrition.addFood({
      name: "NESCAFÉ Gold",
      per100g: { kcal: 353, proteinG: 12, carbsG: 41, fatG: 0.5, fibreG: 0, sodiumMg: 30 },
      measures: { tbsp: 6, tsp: 1.8 },
    });
    const { entries } = nutrition.logMeal({
      day: "2026-11-12",
      meal: "breakfast",
      entries: [
        { foodId: honey.id, measure: { name: "kutsarita", count: 1 } },
        { foodId: coffee.id, measure: { name: "tbsp", count: 1 } },
      ],
    });
    near(entries[0].grams, 7, 0.001);
    expect(entries[0].weightSource).toBe("counted");
    near(entries[1].grams, 6, 0.001);
    expect(entries[0].kcal).toBeCloseTo(21.28, 1);
    expect(entries[1].kcal).toBeCloseTo(21.18, 1);
  });

  test("unknown or default-less measures are rejected with an actionable error", () => {
    expectValidation(
      () =>
        nutrition.logMeal({
          day: "2026-11-12",
          meal: "snack",
          entries: [{ foodId: honey.id, measure: { name: "blorp", count: 1 } }],
        }),
      400,
      /no gram default/,
    );
    expectValidation(
      () => nutrition.addFood({ name: "Bad measures", per100g: { kcal: 1 }, measures: { "": 1 } }),
      400,
      /measure names/,
    );
  });
});

describe("acceptance 4: edits recompute from the source, not the previous row", () => {
  test("a food entry edits from the food each time", () => {
    const { entries } = nutrition.logMeal({
      day: "2026-11-12",
      meal: "dinner",
      entries: [{ foodId: chicken.id, grams: 215, gramsAs: "cooked" }],
    });
    const id = entries[0].id;

    const first = nutrition.updateEntry(id, { grams: 300 });
    near(first.rawEquivalentGrams!, 400, 0.01);
    near(first.kcal, 480, 0.01);
    near(first.proteinG, 90, 0.01);

    const second = nutrition.updateEntry(id, { grams: 250 });
    near(second.rawEquivalentGrams!, 333.3333, 0.01);
    near(second.kcal, 400, 0.01);
    near(second.proteinG, 75, 0.01);
  });

  test("a recipe entry rescales from the stored per-serving snapshot", () => {
    const snapshotRecipe = recipes.createRecipe({
      name: "Snapshot dish",
      servings: 3,
      ingredients: [{ foodId: ampalaya.id, grams: 300 }],
    });
    const logged = nutrition.logRecipe({
      recipeId: snapshotRecipe.id,
      day: "2026-11-14",
      meal: "lunch",
      servingNo: 1,
    });
    const snapshotKcal = logged.entry.kcal;
    const snapshotGrams = logged.entry.grams;

    // Editing the recipe later must not move what was already logged.
    recipes.updateRecipe(snapshotRecipe.id, {
      ingredients: [{ foodId: ampalaya.id, grams: 900 }],
    });

    const first = nutrition.updateEntry(logged.entry.id, { servingFraction: 0.6 });
    near(first.kcal, snapshotKcal * 0.6, 0.01);
    near(first.grams, snapshotGrams * 0.6, 0.01);
    expect(first.servingFraction).toBe(0.6);

    const second = nutrition.updateEntry(logged.entry.id, { servingFraction: 0.6 });
    near(second.kcal, first.kcal, 0.0001);
    near(second.grams, first.grams, 0.0001);

    const third = nutrition.updateEntry(logged.entry.id, { servingFraction: 0.25 });
    near(third.kcal, snapshotKcal * 0.25, 0.01);
  });
});

function ingredientRows(recipeId: number): number {
  return (
    sqlite
      .prepare("SELECT COUNT(*) AS c FROM recipe_ingredients WHERE recipe_id = ?")
      .get(recipeId) as { c: number }
  ).c;
}

describe("recipe lifecycle", () => {
  test("a recipe with logged history is archived, not destroyed", () => {
    const archivedRecipe = recipes.createRecipe({
      name: "Archived dish",
      servings: 2,
      ingredients: [{ foodId: ampalaya.id, grams: 100 }],
    });
    const logged = nutrition.logRecipe({
      recipeId: archivedRecipe.id,
      day: "2026-11-25",
      meal: "lunch",
      servingNo: 1,
    });
    const result = recipes.deleteRecipe(archivedRecipe.id);
    expect(result.deleted).toBe(false);
    expect(result.archived).toBe(true);
    expect(result.loggedEntries).toBe(1);
    expect(result.reason).toMatch(/archived/);

    const archived = recipes.getRecipe(archivedRecipe.id);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAtMs).not.toBeNull();
    expect(archived.ingredients.length).toBe(1);
    expectValidation(() => recipes.updateRecipe(archivedRecipe.id, { name: "Nope" }), 409, /archived/);
    expectValidation(
      () =>
        nutrition.logRecipe({
          recipeId: archivedRecipe.id,
          day: "2026-11-25",
          meal: "dinner",
          servingNo: 2,
        }),
      409,
      /archived/,
    );

    // The logged snapshot and its per-serving snapshot remain readable and rescalable.
    const rescaled = nutrition.updateEntry(logged.entry.id, { servingFraction: 0.5 });
    near(rescaled.kcal, logged.entry.kcal * 0.5, 0.001);
    expect(nutrition.getEntry(logged.entry.id).ingredients.length).toBe(1);

    // Deleting again is idempotent and stays archived.
    expect(recipes.deleteRecipe(archivedRecipe.id)).toMatchObject({ deleted: false, archived: true });
  });

  test("an unreferenced recipe deletes with its own ingredient rows", () => {
    const populated = recipes.createRecipe({
      name: "Scratch dish",
      servings: 1,
      ingredients: [{ foodId: ampalaya.id, grams: 50 }],
    });
    expect(recipes.deleteRecipe(populated.id)).toEqual({ deleted: true, archived: false });
    expectValidation(() => recipes.getRecipe(populated.id), 404, /not found/);
    expect(ingredientRows(populated.id)).toBe(0);
  });

  test("a legacy recipe with no ingredient rows can still be deleted", () => {
    // The write surface requires a non-empty ingredient list, so this shape only comes from
    // legacy/manual data; it must not become undeletable.
    const now = Date.now();
    const inserted = sqlite
      .prepare(
        "INSERT INTO recipes (name, servings_total, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run("Legacy empty dish", 1, now, now);
    const legacyId = Number(inserted.lastInsertRowid);
    expect(ingredientRows(legacyId)).toBe(0);

    expect(recipes.deleteRecipe(legacyId)).toEqual({ deleted: true, archived: false });
    expectValidation(() => recipes.getRecipe(legacyId), 404, /not found/);
  });

  test("recipe_delete archives through the agent route and 404s a missing recipe", async () => {
    const toolRoute = await import("@/app/api/agent/[tool]/route");
    const call = (tool: string, body: Record<string, unknown>) =>
      toolRoute.POST(
        new Request(`http://127.0.0.1:3040/api/agent/${tool}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ tool }) },
      );

    const archivedRecipe = recipes.createRecipe({
      name: "Route archived dish",
      servings: 1,
      ingredients: [{ foodId: ampalaya.id, grams: 20 }],
    });
    nutrition.logRecipe({
      recipeId: archivedRecipe.id,
      day: "2026-11-25",
      meal: "snack",
      servingNo: 1,
    });
    const archived = await call("recipe_delete", { id: archivedRecipe.id });
    expect(archived.status).toBe(200);
    const archivedBody = (await archived.json()) as { result: { deleted: boolean; archived: boolean } };
    expect(archivedBody.result).toMatchObject({ deleted: false, archived: true });

    const populated = recipes.createRecipe({
      name: "Route dish",
      servings: 1,
      ingredients: [{ foodId: ampalaya.id, grams: 25 }],
    });
    const deleted = await call("recipe_delete", { id: populated.id });
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as { result: { deleted: boolean; archived: boolean } };
    expect(deletedBody.result).toEqual({ deleted: true, archived: false });

    const missing = await call("recipe_delete", { id: 999_999 });
    expect(missing.status).toBe(404);
  });

  test("copied child snapshots keep a recipe archived even after the parent link is cleared", () => {
    const copiedRecipe = recipes.createRecipe({
      name: "Copied history dish",
      servings: 1,
      ingredients: [{ foodId: ampalaya.id, grams: 40 }],
    });
    const original = nutrition.logRecipe({
      recipeId: copiedRecipe.id,
      day: "2026-12-09",
      meal: "lunch",
      servingNo: 1,
    }).entry;
    expect(nutrition.copyDay("2026-12-09", "2026-12-10").copied).toBe(1);
    // The copy has recipe_id = null but its child rows still carry recipe_id.
    expect(
      (sqlite.prepare("SELECT recipe_id FROM food_log WHERE day = ?").get("2026-12-10") as { recipe_id: number | null })
        .recipe_id,
    ).toBeNull();
    nutrition.deleteEntry(original.id);

    const result = recipes.deleteRecipe(copiedRecipe.id);
    expect(result.deleted).toBe(false);
    expect(result.archived).toBe(true);
    expect(result.loggedEntries).toBe(0);
    expect(result.snapshotIngredients).toBeGreaterThan(0);
    expect(recipes.getRecipe(copiedRecipe.id).archived).toBe(true);
  });

  test("food_delete is blocked while a recipe ingredient references the food", () => {
    nutrition.addFood({
      name: "Recipe-only food",
      per100g: { kcal: 50 },
    });
    const food = nutrition.searchFoods("Recipe-only food", 1)[0];
    recipes.createRecipe({
      name: "Uses recipe-only food",
      servings: 1,
      ingredients: [{ foodId: food.id, grams: 10 }],
    });
    expectValidation(() => nutrition.deleteFood(food.id), 409, /recipe/);
  });
});

describe("legacy compatibility, provenance and copy_day", () => {
  test("legacy estimated fallback still works", () => {
    const { entries } = nutrition.logMeal({
      day: "2026-11-15",
      meal: "lunch",
      entries: [
        { name: "Hand estimate", grams: 100, per100g: { kcal: 100 } },
        { name: "Stated macros", grams: 100, kcal: 200, estimated: false },
      ],
    });
    expect(entries[0].estimated).toBe(1);
    expect(entries[0].macroSource).toBe("estimated");
    expect(entries[0].rawEquivalentGrams).toBe(100);
    expect(entries[1].estimated).toBe(0);
    expect(entries[1].macroSource).toBe("label");

    const day = nutrition.dayNutrition("2026-11-15");
    expect(day.estimatedEntries).toBe(1);
    near(day.estimatedKcal, 100, 0.001);
    near(day.estimatedKcalShare, 1 / 3, 0.001);

    const edited = nutrition.updateEntry(entries[0].id, { grams: 150 });
    near(edited.kcal, 150, 0.001);
    near(edited.proteinG, 0, 0.001);
  });

  test("provenance can be stated explicitly and estimated follows it", () => {
    const { entries } = nutrition.logMeal({
      day: "2026-11-15",
      meal: "dinner",
      entries: [
        {
          name: "Label food",
          grams: 50,
          kcal: 100,
          proteinG: 5,
          macroSource: "usda",
          weightSource: "weighed",
        },
      ],
    });
    expect(entries[0].macroSource).toBe("usda");
    expect(entries[0].estimated).toBe(0);
    expect(entries[0].weightSource).toBe("weighed");
  });

  test("eatenAt is settable on log and update, in the profile timezone", () => {
    const { entries } = nutrition.logMeal({
      meal: "breakfast",
      eatenAt: "2026-11-10T08:00:00+08:00",
      entries: [{ name: "Coffee", grams: 250, kcal: 2 }],
    });
    expect(entries[0].day).toBe("2026-11-10");
    expect(entries[0].eatenAtMs).toBe(Date.parse("2026-11-10T08:00:00+08:00"));

    const updated = nutrition.updateEntry(entries[0].id, {
      eatenAt: Date.parse("2026-11-10T09:15:00+08:00"),
    });
    expect(updated.day).toBe("2026-11-10");
    expect(updated.eatenAtMs).toBe(Date.parse("2026-11-10T09:15:00+08:00"));
  });

  test("copy_day preserves the full ingredient snapshot and keeps the copy rescalable", () => {
    const source = sqlite
      .prepare("SELECT id, name, meal, kcal, serving_fraction FROM food_log WHERE day = ? ORDER BY eaten_at_ms")
      .all(DAY) as { id: number; name: string; meal: string; kcal: number; serving_fraction: number }[];
    const result = nutrition.copyDay(DAY, "2026-11-13");
    expect(result.copied).toBe(2);
    const copied = sqlite
      .prepare(
        "SELECT id, name, meal, kcal, recipe_id, serving_no, serving_fraction, recipe_serving_json FROM food_log WHERE day = ? ORDER BY eaten_at_ms",
      )
      .all("2026-11-13") as {
      id: number;
      name: string;
      meal: string;
      kcal: number;
      recipe_id: number | null;
      serving_no: number | null;
      serving_fraction: number | null;
      recipe_serving_json: string | null;
    }[];
    expect(copied.length).toBe(2);
    for (const [index, row] of copied.entries()) {
      expect(row.name).toBe(source[index].name);
      expect(row.meal).toBe(source[index].meal);
      near(row.kcal, source[index].kcal, 0.0001);
      // The copy is a separate eat, not a re-use of the source serving number.
      expect(row.recipe_id).toBeNull();
      expect(row.serving_no).toBeNull();
      // But the stored per-serving arithmetic and every ingredient come with it.
      expect(row.serving_fraction).toBe(source[index].serving_fraction);
      expect(row.recipe_serving_json).not.toBeNull();
      const sourceChildren = sqlite
        .prepare("SELECT * FROM food_log_ingredients WHERE food_log_id = ? ORDER BY position")
        .all(source[index].id) as Record<string, unknown>[];
      const copiedChildren = sqlite
        .prepare("SELECT * FROM food_log_ingredients WHERE food_log_id = ? ORDER BY position")
        .all(row.id) as Record<string, unknown>[];
      expect(copiedChildren.length).toBe(sourceChildren.length);
      expect(copiedChildren.length).toBeGreaterThan(0);
      for (const [childIndex, child] of copiedChildren.entries()) {
        const original = sourceChildren[childIndex];
        for (const key of [
          "recipe_id",
          "recipe_ingredient_id",
          "food_id",
          "name",
          "position",
          "amount_basis",
          "grams",
          "per_serving_grams",
          "measure_json",
          "grams_as",
          "food_state",
          "yield_factor",
          "raw_equivalent_grams",
          "kcal",
          "protein_g",
          "carbs_g",
          "fat_g",
          "fibre_g",
          "sodium_mg",
          "resolved",
          "macro_source",
          "weight_source",
          "source",
          "source_url",
          "source_date",
        ]) {
          expect(child[key], `child ${key}`).toEqual(original[key]);
        }
      }
    }

    // A copied entry is not linked to a live recipe, but its stored snapshot still rescales.
    const copiedFirst = copied[0];
    const rescaled = nutrition.updateEntry(copiedFirst.id, { servingFraction: 0.5 });
    near(rescaled.kcal, copiedFirst.kcal * 0.5, 0.001);
    expect(nutrition.getEntry(copiedFirst.id).ingredients.length).toBeGreaterThan(0);
    expectValidation(
      () => nutrition.updateEntry(copiedFirst.id, { servingNo: 2 }),
      400,
      /copied recipe snapshot/,
    );
  });
});

describe("explicit food templates (no name inference)", () => {
  test("the catalogue carries measures and yields but never invented macros", () => {
    const templates = listFoodTemplates();
    const honey = templates.find((template) => template.slug === "honey")!;
    expect(honey.measures).toEqual({ kutsarita: 7, tbsp: 21 });
    const coffee = templates.find((template) => template.slug === "nescafe-gold")!;
    expect(coffee.measures).toEqual({ tbsp: 6, tsp: 1.8 });
    const chicken = templates.find((template) => template.slug === "chicken-breast-skinless")!;
    expect(chicken.yieldFactor).toBe(0.75);
    expect(chicken.state).toBe("raw");
    const rice = templates.find((template) => template.slug === "white-rice-dry")!;
    expect(rice.yieldFactor).toBe(2.3);
    expect(rice.state).toBe("dry");
    for (const template of templates) {
      expect(Object.keys(template).some((key) => /kcal|protein|carbs|fat|fibre|sodium/i.test(key))).toBe(false);
    }
  });

  test("a saved food keeps shared defaults until the template is applied explicitly", () => {
    const saved = nutrition.addFood({
      name: "Honey (jar)",
      per100g: { kcal: 304, proteinG: 0.3, carbsG: 82.4, fatG: 0, fibreG: 0.2, sodiumMg: 4 },
    });
    const before = nutrition.searchFoods("Honey (jar)", 1)[0];
    expect(before.measures.kutsarita).toBe(5); // shared default, not the real-log override
    expect(before.measures.tbsp).toBe(15);

    const applied = nutrition.applyFoodTemplate(saved.id, "honey");
    expect(applied.measures.kutsarita).toBe(7);
    expect(applied.measures.tbsp).toBe(21);
    expect(applied.kcalPer100g).toBe(304); // macros are never touched
    expect(applied.name).toBe("Honey (jar)");

    const after = nutrition.searchFoods("Honey (jar)", 1)[0];
    expect(after.measures.kutsarita).toBe(7);
    expect(after.measures.tbsp).toBe(21);

    const { entries } = nutrition.logMeal({
      day: "2026-11-17",
      meal: "breakfast",
      entries: [{ foodId: saved.id, measure: { name: "kutsarita", count: 1 } }],
    });
    near(entries[0].grams, 7, 0.001);
    expect(entries[0].weightSource).toBe("counted");
  });

  test("merging is non-destructive unless overwrite is requested", () => {
    const existing = nutrition.addFood({
      name: "Instant coffee (custom)",
      per100g: { kcal: 353, proteinG: 12, carbsG: 41, fatG: 0.5, fibreG: 0, sodiumMg: 30 },
      measures: { tbsp: 22 },
    });
    const merged = nutrition.applyFoodTemplate(existing.id, "nescafe-gold");
    expect(merged.measures.tbsp).toBe(22); // the user's value wins
    expect(merged.measures.tsp).toBe(1.8); // missing value filled from the template

    const forced = nutrition.applyFoodTemplate(existing.id, "nescafe-gold", { overwrite: true });
    expect(forced.measures.tbsp).toBe(6);
    expect(forced.measures.tsp).toBe(1.8);
    expect(forced.kcalPer100g).toBe(353);
  });

  test("yield templates apply to an untouched food and keep a custom basis by default", () => {
    const fresh = nutrition.addFood({
      name: "Chicken template target",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
    });
    const applied = nutrition.applyFoodTemplate(fresh.id, "chicken-breast-skinless");
    expect(applied.state).toBe("raw");
    expect(applied.yieldFactor).toBe(0.75);

    const custom = nutrition.addFood({
      name: "Chicken custom basis",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
      state: "raw",
      yieldFactor: 0.8,
    });
    const kept = nutrition.applyFoodTemplate(custom.id, "chicken-breast-skinless");
    expect(kept.yieldFactor).toBe(0.8);
    const overwritten = nutrition.applyFoodTemplate(custom.id, "chicken-breast-skinless", {
      overwrite: true,
    });
    expect(overwritten.yieldFactor).toBe(0.75);
  });

  test("a dry-food yield template requires overwrite because it relabels the basis", () => {
    const rice = nutrition.addFood({
      name: "Rice (dry template target)",
      per100g: { kcal: 365, proteinG: 7, carbsG: 80, fatG: 0.7, fibreG: 1.3, sodiumMg: 5 },
    });
    expectValidation(
      () => nutrition.applyFoodTemplate(rice.id, "white-rice-dry"),
      409,
      /overwrite: true/,
    );
    const unchanged = nutrition.searchFoods("Rice (dry template target)", 1)[0];
    expect(unchanged.state).toBe("raw");
    expect(unchanged.yieldFactor).toBe(1);

    const applied = nutrition.applyFoodTemplate(rice.id, "white-rice-dry", { overwrite: true });
    expect(applied.state).toBe("dry");
    expect(applied.yieldFactor).toBe(2.3);

    const { entries } = nutrition.logMeal({
      day: "2026-11-19",
      meal: "lunch",
      entries: [{ foodId: rice.id, grams: 230, gramsAs: "cooked" }],
    });
    near(entries[0].rawEquivalentGrams!, 100, 0.01);
    near(entries[0].kcal, 365, 0.01);
    near(entries[0].proteinG, 7, 0.01);
    expect(entries[0].gramsAs).toBe("cooked");
  });

  test("unknown or missing template names fail instead of guessing", () => {
    const food = nutrition.searchFoods("Honey (jar)", 1)[0];
    expectValidation(() => nutrition.applyFoodTemplate(food.id, "honey-product"), 404, /unknown food template/);
    expectValidation(() => nutrition.applyFoodTemplate(food.id, ""), 400, /template is required/);
  });
});

describe("eatenAt and day consistency", () => {
  test("a day that contradicts eatenAt is rejected on log and on update", () => {
    expectValidation(
      () =>
        nutrition.logMeal({
          day: "2026-11-16",
          meal: "lunch",
          eatenAt: "2026-11-17T08:00:00+08:00",
          entries: [{ name: "Mismatched", grams: 10, kcal: 1 }],
        }),
      400,
      /falls on 2026-11-17/,
    );
    expectValidation(
      () =>
        nutrition.logRecipe({
          recipeId: recipe.id,
          day: "2026-11-16",
          meal: "lunch",
          servingNo: 9,
          eatenAt: "2026-11-17T08:00:00+08:00",
        }),
      400,
      /falls on 2026-11-17/,
    );
  });

  test("moving an entry to another day keeps its wall-clock time", () => {
    const at = localTimeMs("2026-11-16", "09:30", "Asia/Shanghai");
    const { entries } = nutrition.logMeal({
      meal: "breakfast",
      eatenAt: at,
      entries: [{ name: "Clock test", grams: 50, kcal: 10 }],
    });
    expect(entries[0].day).toBe("2026-11-16");
    expect(formatClock(entries[0].eatenAtMs, "Asia/Shanghai")).toBe("09:30");

    const moved = nutrition.updateEntry(entries[0].id, { day: "2026-11-18" });
    expect(moved.day).toBe("2026-11-18");
    expect(formatClock(moved.eatenAtMs, "Asia/Shanghai")).toBe("09:30");

    expectValidation(
      () =>
        nutrition.updateEntry(entries[0].id, {
          day: "2026-11-19",
          eatenAt: "2026-11-20T09:30:00+08:00",
        }),
      400,
      /falls on 2026-11-20/,
    );

    const matched = nutrition.updateEntry(entries[0].id, {
      day: "2026-11-21",
      eatenAt: "2026-11-21T07:45:00+08:00",
    });
    expect(matched.day).toBe("2026-11-21");
    expect(formatClock(matched.eatenAtMs, "Asia/Shanghai")).toBe("07:45");
  });
});

describe("food source snapshot arithmetic", () => {
  test("history is immutable; an edit recomputes from the current food", () => {
    const food = nutrition.addFood({
      name: "Source chicken",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
      state: "raw",
      yieldFactor: 0.75,
    });
    const logged = nutrition.logMeal({
      day: "2026-11-19",
      meal: "dinner",
      entries: [{ foodId: food.id, grams: 100, gramsAs: "cooked" }],
    }).entries[0];
    near(logged.rawEquivalentGrams!, 133.3333, 0.01);
    near(logged.kcal, 160, 0.001);
    near(logged.proteinG, 30, 0.001);

    // Updating the same food changes the source, not the snapshot.
    nutrition.addFood({
      name: "Source chicken",
      per100g: { kcal: 110, proteinG: 20, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
    });
    const source = nutrition.searchFoods("Source chicken", 1)[0];
    expect(source.yieldFactor).toBe(0.75); // omitted on update, so preserved
    expect(source.state).toBe("raw");

    const untouched = nutrition.dayNutrition("2026-11-19").entries.find((entry) => entry.id === logged.id)!;
    near(untouched.kcal, 160, 0.001);
    near(untouched.proteinG, 30, 0.001);
    near(untouched.rawEquivalentGrams!, 133.3333, 0.01);
    expect(untouched.gramsAs).toBe("cooked");

    const updated = nutrition.updateEntry(logged.id, { grams: 150 });
    near(updated.rawEquivalentGrams!, 200, 0.01);
    near(updated.kcal, 220, 0.01);
    near(updated.proteinG, 40, 0.01);
    expect(updated.gramsAs).toBe("cooked");
    expect(updated.macroSource).toBe("label");
  });
});

describe("review regressions", () => {
  test("meal_log rejects a state override on a saved food but allows it inline", () => {
    expectValidation(
      () =>
        nutrition.logMeal({
          day: "2026-11-22",
          meal: "lunch",
          entries: [{ foodId: chicken.id, grams: 100, state: "cooked" }],
        }),
      400,
      /gramsAs/,
    );
    expectValidation(
      () =>
        nutrition.logMeal({
          day: "2026-11-22",
          meal: "snack",
          entries: [{ foodId: chicken.id, grams: 100, gramsAs: "boiled" }],
        }),
      400,
      /gramsAs/,
    );
    const { entries } = nutrition.logMeal({
      day: "2026-11-22",
      meal: "snack",
      entries: [{ name: "Inline cooked", grams: 100, kcal: 100, state: "cooked" }],
    });
    expect(entries[0].gramsAs).toBe("cooked");
  });

  test("servingNo is range- and duplicate-checked on log and update", () => {
    expectValidation(
      () => nutrition.logRecipe({ recipeId: recipe.id, day: "2026-11-22", meal: "lunch", servingNo: 1 }),
      409,
      /already logged/,
    );
    expectValidation(
      () => nutrition.logRecipe({ recipeId: recipe.id, day: "2026-11-22", meal: "lunch", servingNo: 9 }),
      400,
      /between 1 and 2/,
    );

    const numbered = recipes.createRecipe({
      name: "Serving numbers",
      servings: 2,
      ingredients: [{ foodId: ampalaya.id, grams: 100 }],
    });
    const first = nutrition.logRecipe({ recipeId: numbered.id, day: "2026-11-22", meal: "breakfast", servingNo: 1 });
    nutrition.logRecipe({ recipeId: numbered.id, day: "2026-11-22", meal: "dinner", servingNo: 2 });
    expectValidation(() => nutrition.updateEntry(first.entry.id, { servingNo: 2 }), 409, /already logged/);
    expectValidation(() => nutrition.updateEntry(first.entry.id, { servingNo: 99 }), 400, /between 1 and 2/);
    expectValidation(
      () => nutrition.updateEntry(first.entry.id, { servingFraction: 0.5, grams: 50 }),
      400,
      /not both/,
    );
  });

  test("day moves preserve seconds and a unique collision is a 409", () => {
    const at = localTimeMs("2026-11-20", "09:30:45", "Asia/Shanghai");
    const movedEntry = nutrition.logMeal({
      meal: "breakfast",
      eatenAt: at,
      entries: [{ name: "Second-hand", grams: 10, kcal: 5 }],
    }).entries[0];
    const moved = nutrition.updateEntry(movedEntry.id, { day: "2026-11-23" });
    expect(moved.day).toBe("2026-11-23");
    expect(formatClockSeconds(moved.eatenAtMs, "Asia/Shanghai")).toBe("09:30:45");

    const first = nutrition.logMeal({
      day: "2026-11-20",
      meal: "snack",
      eatenAt: localTimeMs("2026-11-20", "10:00:00", "Asia/Shanghai"),
      entries: [{ name: "Collision", grams: 10, kcal: 5 }],
    }).entries[0];
    const second = nutrition.logMeal({
      day: "2026-11-20",
      meal: "snack",
      eatenAt: localTimeMs("2026-11-20", "11:00:00", "Asia/Shanghai"),
      entries: [{ name: "Collision", grams: 10, kcal: 5 }],
    }).entries[0];
    expectValidation(() => nutrition.updateEntry(second.id, { eatenAt: first.eatenAtMs }), 409, /different time/);
  });

  test("fibre- and sodium-only edits are applied", () => {
    const { entries } = nutrition.logMeal({
      day: "2026-11-22",
      meal: "dinner",
      entries: [{ name: "Micronutrients", grams: 100, kcal: 100, fibreG: 1, sodiumMg: 100 }],
    });
    const fibre = nutrition.updateEntry(entries[0].id, { fibreG: 5 });
    expect(fibre.fibreG).toBe(5);
    near(fibre.kcal, 100, 0.001);
    const sodium = nutrition.updateEntry(entries[0].id, { sodiumMg: 250 });
    expect(sodium.sodiumMg).toBe(250);
    expect(sodium.fibreG).toBe(5);
  });

  test("explicit macro edits refresh rawEquivalent from the saved food yield", () => {
    const food = nutrition.addFood({
      name: "Explicit macro chicken",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
      state: "raw",
      yieldFactor: 0.75,
    });
    const { entries } = nutrition.logMeal({
      day: "2026-11-22",
      meal: "breakfast",
      entries: [{ foodId: food.id, grams: 100, gramsAs: "cooked" }],
    });
    const edited = nutrition.updateEntry(entries[0].id, { grams: 150, kcal: 500, proteinG: 60 });
    near(edited.rawEquivalentGrams!, 200, 0.01);
    near(edited.kcal, 500, 0.001);
    near(edited.proteinG, 60, 0.001);
    expect(edited.grams).toBe(150);
    expect(edited.gramsAs).toBe("cooked");

    expectValidation(() => nutrition.updateEntry(entries[0].id, { state: "cooked" }), 400, /gramsAs/);
  });

  test("a name-only ingredient is stored, exposed as unresolved and marks logs estimated", () => {
    const dish = recipes.createRecipe({
      name: "Seasoned dish",
      servings: 2,
      ingredients: [
        { foodId: ampalaya.id, grams: 200 },
        { name: "Salt", grams: 2 },
        { name: "Honey drizzle", measure: { name: "tbsp", count: 1 } },
      ],
    });
    expect(dish.complete).toBe(false);
    expect(dish.unresolvedIngredients).toEqual(["Salt", "Honey drizzle"]);

    const salt = dish.ingredients.find((ingredient) => ingredient.name === "Salt")!;
    expect(salt.resolved).toBe(false);
    expect(salt.grams).toBe(2);
    expect(salt.macros.kcal).toBe(0); // never invented
    const drizzle = dish.ingredients.find((ingredient) => ingredient.name === "Honey drizzle")!;
    expect(drizzle.resolved).toBe(false);
    expect(drizzle.grams).toBe(15); // shared tbsp default, no per-food value invented

    // Totals contain only the resolved food (200 g ampalaya = 34 kcal, 17 per serving).
    near(dish.total.macros.kcal, 34, 0.001);
    near(dish.perServing.macros.kcal, 17, 0.001);

    const logged = nutrition.logRecipe({
      recipeId: dish.id,
      day: "2026-11-24",
      meal: "lunch",
      servingNo: 1,
    });
    expect(logged.incomplete).toBe(true);
    expect(logged.unresolvedIngredients).toEqual(["Salt", "Honey drizzle"]);
    expect(logged.entry.macroSource).toBe("estimated");
    expect(logged.entry.estimated).toBe(1);

    // The estimated flag is part of the row snapshot: resizing keeps it even after the live
    // recipe becomes complete.
    recipes.updateRecipe(dish.id, {
      ingredients: [{ foodId: ampalaya.id, grams: 200 }],
    });
    const rescaled = nutrition.updateEntry(logged.entry.id, { servingFraction: 0.5 });
    expect(rescaled.macroSource).toBe("estimated");
    expect(rescaled.estimated).toBe(1);
    near(rescaled.kcal, logged.entry.kcal * 0.5, 0.001);

    // A fresh log of the now-complete recipe is not estimated.
    const completeLog = nutrition.logRecipe({
      recipeId: dish.id,
      day: "2026-11-24",
      meal: "dinner",
      servingNo: 2,
    });
    expect(completeLog.incomplete).toBe(false);
    expect(completeLog.unresolvedIngredients).toEqual([]);
    expect(completeLog.entry.macroSource).toBe("recipe");
    expect(completeLog.entry.estimated).toBe(0);
  });

  test("a recipe with only unresolved ingredients cannot be logged", () => {
    const uncountable = recipes.createRecipe({
      name: "All unresolved",
      servings: 1,
      ingredients: [{ name: "Mystery", grams: 10 }],
    });
    expect(uncountable.complete).toBe(false);
    expectValidation(
      () =>
        nutrition.logRecipe({
          recipeId: uncountable.id,
          day: "2026-11-24",
          meal: "snack",
          servingNo: 1,
        }),
      400,
      /no food-resolved ingredients/,
    );
  });

  test("name-only ingredients still need grams or a resolvable measure", () => {
    expectValidation(
      () => recipes.createRecipe({ name: "No amount", servings: 1, ingredients: [{ name: "Salt" }] }),
      400,
      /grams or measure/,
    );
    expectValidation(
      () => recipes.createRecipe({ name: "No name", servings: 1, ingredients: [{ grams: 1 }] }),
      400,
      /needs a name or foodId/,
    );
  });

  test("date-only eatenAt and oversized measures are rejected", () => {
    expectValidation(
      () =>
        nutrition.logMeal({
          meal: "lunch",
          eatenAt: "2026-11-17",
          entries: [{ name: "Date only", grams: 10, kcal: 1 }],
        }),
      400,
      /include a time/,
    );
    expectValidation(
      () =>
        nutrition.logMeal({
          day: "2026-11-22",
          meal: "snack",
          entries: [{ foodId: honey.id, measure: { name: "kutsarita", count: 4000 } }],
        }),
      400,
      /use grams/,
    );
  });
});

describe("naive eatenAt uses the profile timezone", () => {
  test("wall-clock timestamps resolve in the profile zone, offsets and epoch stay absolute", () => {
    const naive = "2026-11-10T08:00:00";
    const serverMs = Date.parse(naive);
    const candidates = ["America/New_York", "Asia/Shanghai", "Europe/Berlin", "Pacific/Auckland"];
    const zone = candidates.find(
      (candidate) => localTimeMs("2026-11-10", "08:00:00", candidate) !== serverMs,
    )!;
    expect(zone).toBeDefined();

    const original = profileService.getProfile().timezone;
    try {
      profileService.updateProfile({ timezone: zone });
      expect(profileService.getTimezone()).toBe(zone);
      const expected = localTimeMs("2026-11-10", "08:00:00", zone);
      // The zone is chosen so a server-timezone Date.parse would give a different instant.
      expect(expected).not.toBe(serverMs);

      const { entries } = nutrition.logMeal({
        meal: "breakfast",
        eatenAt: naive,
        entries: [{ name: "Naive clock", grams: 10, kcal: 5 }],
      });
      expect(entries[0].eatenAtMs).toBe(expected);
      expect(entries[0].day).toBe("2026-11-10");

      // The update path uses the same profile-zone interpretation.
      const updated = nutrition.updateEntry(entries[0].id, { eatenAt: "2026-11-10T09:15:00" });
      expect(updated.eatenAtMs).toBe(localTimeMs("2026-11-10", "09:15:00", zone));
      expect(updated.day).toBe("2026-11-10");

      // Seconds are optional, fractional seconds are preserved.
      const { entries: short } = nutrition.logMeal({
        meal: "snack",
        eatenAt: "2026-11-10T08:00",
        entries: [{ name: "Naive short", grams: 10, kcal: 5 }],
      });
      expect(short[0].eatenAtMs).toBe(expected);

      const { entries: withMs } = nutrition.logMeal({
        meal: "snack",
        eatenAt: "2026-11-10T08:00:00.250",
        entries: [{ name: "Naive ms", grams: 10, kcal: 5 }],
      });
      expect(withMs[0].eatenAtMs).toBe(expected + 250);

      // Explicit offsets ignore the profile zone; offset without seconds is still accepted.
      const explicit = "2026-11-10T08:00:00+08:00";
      const { entries: offset } = nutrition.logMeal({
        meal: "lunch",
        eatenAt: explicit,
        entries: [{ name: "Offset clock", grams: 10, kcal: 5 }],
      });
      expect(offset[0].eatenAtMs).toBe(Date.parse(explicit));

      const offsetShort = "2026-11-10T08:00+08:00";
      expect(Number.isNaN(Date.parse(offsetShort))).toBe(false);
      const { entries: offsetShortEntry } = nutrition.logMeal({
        meal: "dinner",
        eatenAt: offsetShort,
        entries: [{ name: "Offset short", grams: 10, kcal: 5 }],
      });
      expect(offsetShortEntry[0].eatenAtMs).toBe(Date.parse(offsetShort));

      // Epoch milliseconds are unchanged.
      const epoch = Date.parse("2026-11-10T08:00:00Z");
      const { entries: numbered } = nutrition.logMeal({
        meal: "dinner",
        eatenAt: epoch,
        entries: [{ name: "Epoch clock", grams: 10, kcal: 5 }],
      });
      expect(numbered[0].eatenAtMs).toBe(epoch);

      // The derived day follows the profile zone around midnight.
      const late = nutrition.logMeal({
        meal: "dinner",
        eatenAt: "2026-11-10T23:30:00",
        entries: [{ name: "Late local", grams: 10, kcal: 5 }],
      }).entries[0];
      expect(late.day).toBe("2026-11-10");
      const utc = Date.parse("2026-11-11T03:30:00Z");
      const crossing = nutrition.logMeal({
        meal: "dinner",
        eatenAt: utc,
        entries: [{ name: "Crossing", grams: 10, kcal: 5 }],
      }).entries[0];
      expect(crossing.day).toBe(localDay(utc, zone));
    } finally {
      profileService.updateProfile({ timezone: original });
    }
  });
});

describe("per-meal ingredient overrides and full snapshots", () => {
  test("amountBasis is required and batch/serving amounts are unambiguous", () => {
    const overrideRecipe = recipes.createRecipe({
      name: "Override dish",
      servings: 2,
      ingredients: [
        { foodId: ampalaya.id, grams: 100 },
        { foodId: egg.id, measure: { name: "piece", count: 1 } },
      ],
    });
    const ampalayaIngredient = overrideRecipe.ingredients.find(
      (item) => item.foodId === ampalaya.id,
    )!;
    expectValidation(
      () =>
        nutrition.logRecipe({
          recipeId: overrideRecipe.id,
          day: "2026-11-26",
          meal: "lunch",
          ingredientOverrides: [{ ingredientId: ampalayaIngredient.id, grams: 200 }],
        }),
      400,
      /amountBasis/,
    );

    const batch = nutrition.logRecipe({
      recipeId: overrideRecipe.id,
      day: "2026-11-26",
      meal: "lunch",
      amountBasis: "batch",
      ingredientOverrides: [{ ingredientId: ampalayaIngredient.id, grams: 200 }],
    });
    expect(batch.amountBasis).toBe("batch");
    expect(batch.ingredients.length).toBe(2);
    const batchAmpalaya = batch.ingredients.find((item) => item.foodId === ampalaya.id)!;
    const batchEgg = batch.ingredients.find((item) => item.foodId === egg.id)!;
    near(batchAmpalaya.perServingGrams, 100, 0.001); // 200 g batch / 2 servings
    near(batchAmpalaya.grams, 100, 0.001);
    expect(batchAmpalaya.recipeIngredientId).toBe(ampalayaIngredient.id);
    near(batchEgg.perServingGrams, 30, 0.001); // 1 piece (60 g) / 2 servings
    near(batchEgg.grams, 30, 0.001);
    expect(batchEgg.foodState).toBe("raw");
    expect(batchEgg.measureJson).toBe('{"name":"piece","count":1}');
    near(batchAmpalaya.kcalPer100g!, 17, 0.001);
    // The recipe definition is untouched by a per-meal override.
    const definition = recipes.getRecipe(overrideRecipe.id);
    expect(definition.ingredients.find((item) => item.foodId === ampalaya.id)!.grams).toBe(100);

    const serving = nutrition.logRecipe({
      recipeId: overrideRecipe.id,
      day: "2026-11-26",
      meal: "dinner",
      servingNo: 2,
      amountBasis: "serving",
      ingredientOverrides: [{ ingredientId: ampalayaIngredient.id, grams: 40 }],
    });
    const servingAmpalaya = serving.ingredients.find((item) => item.foodId === ampalaya.id)!;
    near(servingAmpalaya.perServingGrams, 40, 0.001);
    near(servingAmpalaya.grams, 40, 0.001);
    // 40 g ampalaya (6.8 kcal) + 30 g egg (42.9 kcal) per serving.
    near(serving.entry.kcal, 49.7, 0.01);

    // Duplicate or unknown targets fail instead of silently choosing one.
    const validationRecipe = recipes.createRecipe({
      name: "Override validation dish",
      servings: 1,
      ingredients: [{ foodId: ampalaya.id, grams: 10 }],
    });
    const validationIngredient = validationRecipe.ingredients[0];
    expectValidation(
      () =>
        nutrition.logRecipe({
          recipeId: validationRecipe.id,
          day: "2026-11-27",
          meal: "dinner",
          amountBasis: "serving",
          ingredientOverrides: [
            { ingredientId: validationIngredient.id, grams: 10 },
            { foodId: ampalaya.id, grams: 20 },
          ],
        }),
      400,
      /more than once/,
    );
    expectValidation(
      () =>
        nutrition.logRecipe({
          recipeId: validationRecipe.id,
          day: "2026-11-27",
          meal: "dinner",
          amountBasis: "serving",
          ingredientOverrides: [{ ingredientId: 999_999, grams: 10 }],
        }),
      404,
      /not in this recipe/,
    );
  });

  test("a per-meal override can say it was weighed cooked", () => {
    const cookedRecipe = recipes.createRecipe({
      name: "Cooked override dish",
      servings: 1,
      ingredients: [{ foodId: chicken.id, grams: 100 }],
    });
    const ingredient = cookedRecipe.ingredients[0];
    const logged = nutrition.logRecipe({
      recipeId: cookedRecipe.id,
      day: "2026-12-04",
      meal: "lunch",
      servingNo: 1,
      amountBasis: "serving",
      ingredientOverrides: [{ ingredientId: ingredient.id, grams: 150, gramsAs: "cooked" }],
    });
    const child = logged.ingredients[0];
    expect(child.grams).toBe(150);
    expect(child.gramsAs).toBe("cooked");
    expect(child.foodState).toBe("raw");
    expect(child.yieldFactor).toBe(0.75);
    near(child.rawEquivalentGrams!, 200, 0.001);
    near(child.kcal, 240, 0.001);
    near(logged.entry.kcal, 240, 0.001);
  });

  test("editing a recipe never rewrites an existing ingredient snapshot", () => {
    const editable = recipes.createRecipe({
      name: "Editable dish",
      servings: 2,
      ingredients: [
        { foodId: ampalaya.id, grams: 100 },
        { foodId: egg.id, grams: 50 },
      ],
    });
    const logged = nutrition.logRecipe({
      recipeId: editable.id,
      day: "2026-12-03",
      meal: "lunch",
      servingNo: 1,
    });
    const before = nutrition.getEntry(logged.entry.id);
    expect(before.ingredients.map((item) => item.foodId)).toEqual([ampalaya.id, egg.id]);
    const beforeMacros = { kcal: before.kcal, proteinG: before.proteinG };

    recipes.updateRecipe(editable.id, {
      ingredients: [{ foodId: egg.id, grams: 200 }],
    });

    const after = nutrition.getEntry(logged.entry.id);
    expect(after.ingredients.map((item) => item.foodId)).toEqual([ampalaya.id, egg.id]);
    expect(after.ingredients.every((item) => item.recipeIngredientId !== null)).toBe(true);
    near(after.kcal, beforeMacros.kcal, 0.0001);
    near(after.proteinG, beforeMacros.proteinG, 0.0001);
    // A new log uses the edited definition; the old one does not move.
    const second = nutrition.logRecipe({
      recipeId: editable.id,
      day: "2026-12-03",
      meal: "dinner",
      servingNo: 2,
    });
    expect(second.entry.kcal).not.toBeCloseTo(after.kcal, 1);
  });

  test("explicit macro edits on a recipe entry with children are rejected", () => {
    const macroRecipe = recipes.createRecipe({
      name: "Macro edit dish",
      servings: 1,
      ingredients: [{ foodId: ampalaya.id, grams: 100 }],
    });
    const logged = nutrition.logRecipe({
      recipeId: macroRecipe.id,
      day: "2026-12-07",
      meal: "lunch",
      servingNo: 1,
    });
    expectValidation(
      () => nutrition.updateEntry(logged.entry.id, { kcal: 999 }),
      409,
      /derived from its recorded ingredients/,
    );
    expectValidation(
      () => nutrition.updateEntry(logged.entry.id, { servingFraction: 0.5, kcal: 999 }),
      400,
      /not both/,
    );
    // Undamaged by the rejected calls.
    near(nutrition.getEntry(logged.entry.id).kcal, logged.entry.kcal, 0.0001);
    expect(nutrition.getEntry(logged.entry.id).ingredients.length).toBe(1);
  });

  test("meal_get exposes the snapshot and meal_delete cleans every child row", () => {
    const snapshotRecipe = recipes.createRecipe({
      name: "Snapshot cleanup dish",
      servings: 1,
      ingredients: [{ foodId: ampalaya.id, grams: 100 }],
    });
    const detail = nutrition.getEntry(
      nutrition.logRecipe({
        recipeId: snapshotRecipe.id,
        day: "2026-11-28",
        meal: "lunch",
        servingNo: 1,
      }).entry.id,
    );
    expect(detail.ingredientSnapshotComplete).toBe(true);
    expect(detail.ingredients.length).toBe(1);
    expect(detail.ingredients[0].foodId).toBe(ampalaya.id);
    expect(detail.ingredients[0].source).toBe("manual");

    // A non-empty list is not enough: a partially deleted child snapshot is incomplete.
    const partialRecipe = recipes.createRecipe({
      name: "Partial snapshot dish",
      servings: 1,
      ingredients: [
        { foodId: ampalaya.id, grams: 60 },
        { foodId: egg.id, grams: 40 },
      ],
    });
    const partial = nutrition.logRecipe({
      recipeId: partialRecipe.id,
      day: "2026-12-08",
      meal: "lunch",
      servingNo: 1,
    });
    sqlite.prepare("DELETE FROM food_log_ingredients WHERE id = ?").run(partial.ingredients[1].id);
    const damaged = nutrition.getEntry(partial.entry.id);
    expect(damaged.ingredients.length).toBe(1);
    expect(damaged.ingredientSnapshotComplete).toBe(false);

    // Rescaling writes child revisions; deleting the meal must not leave them behind.
    nutrition.updateEntry(detail.id, { servingFraction: 0.5 });
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS c FROM food_log_revisions WHERE food_log_id = ?").get(detail.id) as { c: number }).c,
    ).toBeGreaterThan(0);
    nutrition.deleteEntry(detail.id);
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS c FROM food_log_ingredients WHERE food_log_id = ?").get(detail.id) as { c: number }).c,
    ).toBe(0);
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS c FROM food_log_revisions WHERE food_log_id = ?").get(detail.id) as { c: number }).c,
    ).toBe(0);
  });

  test("a legacy aggregate-only recipe row is labelled incomplete, never invented", () => {
    const now = Date.now();
    const inserted = sqlite
      .prepare(
        `INSERT INTO food_log
           (day, meal, eaten_at_ms, food_id, name, grams, kcal, protein_g, carbs_g, fat_g, fibre_g,
            sodium_mg, estimated, recipe_id, serving_no, serving_fraction, recipe_serving_json,
            created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?)`,
      )
      .run(
        "2026-11-29",
        "lunch",
        now,
        "Legacy aggregate dish",
        250,
        400,
        20,
        30,
        10,
        2,
        100,
        0,
        recipe.id,
        now,
        now,
      );
    const legacyId = Number(inserted.lastInsertRowid);
    const detail = nutrition.getEntry(legacyId);
    expect(detail.ingredients).toEqual([]);
    expect(detail.ingredientSnapshotComplete).toBe(false);
    const day = nutrition.dayNutrition("2026-11-29");
    expect(day.entries[0].ingredients).toEqual([]);
    expect(day.entries[0].ingredientSnapshotComplete).toBe(false);

    const legacyPreview = history.previewHistoryRefresh({ entryIds: [legacyId] });
    expect(legacyPreview.changed).toBe(0);
    expect(legacyPreview.skipped).toBe(1);
    expect(legacyPreview.skippedReasons.aggregate_snapshot_without_ingredients).toBe(1);
    expect(legacyPreview.changes[0].status).toBe("skipped");
    expect(legacyPreview.changes[0].reason).toBe("aggregate_snapshot_without_ingredients");

    // No recorded per-serving arithmetic: refuse instead of recalculating from a live recipe.
    expectValidation(
      () => nutrition.updateEntry(legacyId, { servingFraction: 0.5 }),
      409,
      /predates the per-serving snapshot/,
    );
    // An explicit macro edit is still allowed.
    const edited = nutrition.updateEntry(legacyId, { kcal: 410 });
    near(edited.kcal, 410, 0.001);

    // A plain food entry has no ingredient snapshot to be incomplete about.
    const plain = nutrition.logMeal({
      day: "2026-11-29",
      meal: "snack",
      entries: [{ name: "Plain snack", grams: 10, kcal: 5 }],
    }).entries[0];
    expect(nutrition.getEntry(plain.id).ingredientSnapshotComplete).toBeNull();
  });

  test("food_delete also checks logged ingredient references", () => {
    const food = nutrition.addFood({ name: "Snapshot-only food", per100g: { kcal: 70 } });
    const dish = recipes.createRecipe({
      name: "Snapshot-only dish",
      servings: 1,
      ingredients: [{ foodId: food.id, grams: 30 }],
    });
    nutrition.logRecipe({
      recipeId: dish.id,
      day: "2026-11-30",
      meal: "lunch",
      servingNo: 1,
    });
    // Remove the live ingredient reference; only the historical snapshot still names the food.
    recipes.updateRecipe(dish.id, { ingredients: [{ foodId: ampalaya.id, grams: 30 }] });
    expectValidation(() => nutrition.deleteFood(food.id), 409, /logged recipe ingredients/);
  });
});

describe("explicit past-meal history refresh", () => {
  test("preview is read-only, scoped and stale hashes are rejected", () => {
    const food = nutrition.addFood({
      name: "Refresh chicken",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
      state: "raw",
      yieldFactor: 0.75,
      source: "label",
      sourceUrl: "https://example.test/chicken",
      sourceDate: "2026-11-01",
    });
    const plain = nutrition.logMeal({
      day: "2026-12-01",
      meal: "lunch",
      entries: [{ foodId: food.id, grams: 100, gramsAs: "cooked" }],
    }).entries[0];
    const dish = recipes.createRecipe({
      name: "Refresh dish",
      servings: 1,
      ingredients: [{ foodId: food.id, grams: 100 }],
    });
    const recipeEntry = nutrition.logRecipe({
      recipeId: dish.id,
      day: "2026-12-01",
      meal: "dinner",
      servingNo: 1,
    }).entry;

    expectValidation(() => history.previewHistoryRefresh({}), 400, /foodIds and\/or entryIds/);

    const before = history.previewHistoryRefresh({ foodIds: [food.id] });
    expect(before.changed).toBe(0);
    expect(before.unchanged).toBeGreaterThanOrEqual(2);

    nutrition.addFood({
      name: "Refresh chicken",
      per100g: { kcal: 110, proteinG: 20, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
    });
    const preview = history.previewHistoryRefresh({ foodIds: [food.id] });
    expect(preview.changed).toBe(2);
    expect(preview.skipped).toBe(0);
    expect(preview.previewHash.length).toBe(64);
    const plainChange = preview.changes.find((change) => change.kind === "entry")!;
    expect(plainChange.entryId).toBe(plain.id);
    near(plainChange.previous!.kcal, 160, 0.001);
    near(plainChange.proposed!.kcal, 146.6667, 0.01);
    const childChange = preview.changes.find((change) => change.kind === "ingredient")!;
    expect(childChange.entryId).toBe(recipeEntry.id);
    expect(childChange.ingredientId).not.toBeNull();

    // Preview itself wrote nothing.
    near(nutrition.getEntry(plain.id).kcal, 160, 0.001);
    near(nutrition.getEntry(recipeEntry.id).kcal, 120, 0.001);

    expectValidation(() => history.applyHistoryRefresh({ foodIds: [food.id] }), 400, /previewHash/);
    expectValidation(
      () => history.applyHistoryRefresh({ foodIds: [food.id], previewHash: "0".repeat(64) }),
      409,
      /stale/,
    );

    const applied = history.applyHistoryRefresh({
      foodIds: [food.id],
      previewHash: preview.previewHash,
    });
    expect(applied.applied).toBe(2);
    expect(applied.entriesTouched).toBe(2);
    expect(applied.revisions).toBeGreaterThanOrEqual(3); // 2 rows + the recipe parent recompute
    near(nutrition.getEntry(plain.id).kcal, 146.6667, 0.01);
    near(nutrition.getEntry(plain.id).proteinG, 26.6667, 0.01);
    near(nutrition.getEntry(recipeEntry.id).kcal, 110, 0.001);
    expect(nutrition.getEntry(recipeEntry.id).ingredients[0].kcalPer100g).toBe(110);
    expect(nutrition.getEntry(recipeEntry.id).ingredients[0].sourceUrl).toBe(
      "https://example.test/chicken",
    );

    const revisions = sqlite
      .prepare(
        "SELECT reason, previous_json, new_json FROM food_log_revisions WHERE food_log_id IN (?, ?) ORDER BY id",
      )
      .all(plain.id, recipeEntry.id) as { reason: string; previous_json: string; new_json: string }[];
    expect(revisions.length).toBeGreaterThanOrEqual(3);
    expect(revisions.some((row) => row.reason === "food_history_refresh" && row.previous_json.includes('"kcal":160'))).toBe(true);
    expect(revisions.some((row) => row.reason === "recipe_snapshot_recomputed")).toBe(true);

    const after = history.previewHistoryRefresh({ foodIds: [food.id] });
    expect(after.changed).toBe(0);
    expect(after.unchanged).toBeGreaterThanOrEqual(2);

    // The food update is itself audited.
    const foodRevisions = sqlite
      .prepare("SELECT previous_json, current_json FROM food_revisions WHERE food_id = ?")
      .all(food.id) as { previous_json: string; current_json: string }[];
    expect(foodRevisions.length).toBeGreaterThan(0);
    expect(foodRevisions.at(-1)!.previous_json).toContain('"kcalPer100g":120');
    expect(foodRevisions.at(-1)!.current_json).toContain('"kcalPer100g":110');
  });

  test("a changed yield factor is skipped explicitly, never reported unchanged", () => {
    const food = nutrition.addFood({
      name: "Yield refresh food",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
      state: "raw",
      yieldFactor: 0.75,
    });
    const entry = nutrition.logMeal({
      day: "2026-12-11",
      meal: "lunch",
      entries: [{ foodId: food.id, grams: 100, gramsAs: "cooked" }],
    }).entries[0];
    nutrition.addFood({
      name: "Yield refresh food",
      per100g: { kcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.6, fibreG: 0, sodiumMg: 60 },
      yieldFactor: 0.8,
    });
    const preview = history.previewHistoryRefresh({ foodIds: [food.id] });
    expect(preview.changed).toBe(0);
    expect(preview.unchanged).toBe(0);
    expect(preview.skipped).toBe(1);
    expect(preview.skippedReasons.yield_changed).toBe(1);
    expect(preview.changes[0].entryId).toBe(entry.id);
    expect(preview.changes[0].status).toBe("skipped");
    expect(preview.changes[0].reason).toBe("yield_changed");
  });

  test("refresh preserves estimated/manual provenance and never forces estimated false", () => {
    const food = nutrition.addFood({
      name: "Estimated provenance food",
      per100g: { kcal: 100, proteinG: 5, carbsG: 10, fatG: 2, fibreG: 1, sodiumMg: 20 },
      source: "manual",
    });
    const entry = nutrition.logMeal({
      day: "2026-12-12",
      meal: "lunch",
      entries: [{ foodId: food.id, grams: 100, estimated: true }],
    }).entries[0];
    expect(entry.macroSource).toBe("estimated");
    expect(entry.estimated).toBe(1);

    nutrition.addFood({
      name: "Estimated provenance food",
      per100g: { kcal: 110, proteinG: 5, carbsG: 10, fatG: 2, fibreG: 1, sodiumMg: 20 },
    });
    const preview = history.previewHistoryRefresh({ foodIds: [food.id] });
    expect(preview.changed).toBe(1);
    const applied = history.applyHistoryRefresh({
      foodIds: [food.id],
      previewHash: preview.previewHash,
    });
    expect(applied.applied).toBe(1);
    const after = nutrition.getEntry(entry.id);
    near(after.kcal, 110, 0.001);
    expect(after.macroSource).toBe("estimated");
    expect(after.estimated).toBe(1);
  });

  test("an oversized bulk scope is rejected before any partial write", () => {
    const food = nutrition.addFood({ name: "Bulk refresh food", per100g: { kcal: 1 } });
    const insert = sqlite.prepare(
      `INSERT INTO food_log
         (day, meal, eaten_at_ms, food_id, name, grams, kcal, estimated, macro_source,
          basis_state, basis_yield_factor, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const base = Date.now();
    sqlite.transaction(() => {
      for (let index = 0; index <= history.MAX_HISTORY_REFRESH_ROWS; index += 1) {
        insert.run("2026-12-13", "snack", base + index, food.id, "Bulk item", 10, 1, 0, "label", "raw", 1, base, base);
      }
    })();
    const revisionsBefore = (
      sqlite.prepare("SELECT COUNT(*) AS c FROM food_log_revisions").get() as { c: number }
    ).c;
    expectValidation(
      () => history.previewHistoryRefresh({ foodIds: [food.id] }),
      400,
      /at most 500/,
    );
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS c FROM food_log_revisions").get() as { c: number }).c,
    ).toBe(revisionsBefore);
  });

  test("missing foods and changed bases are skipped with a reason", () => {
    const missing = nutrition.addFood({ name: "Missing food", per100g: { kcal: 10 } });
    const missingEntry = nutrition.logMeal({
      day: "2026-12-02",
      meal: "lunch",
      entries: [{ foodId: missing.id, grams: 10 }],
    }).entries[0];
    // Simulate a food removed outside the service guard; the preview must not invent values.
    // Foreign keys are off for this out-of-band deletion only, then restored immediately.
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.prepare("DELETE FROM foods WHERE id = ?").run(missing.id);
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
    const missingPreview = history.previewHistoryRefresh({ entryIds: [missingEntry.id] });
    expect(missingPreview.skipped).toBe(1);
    expect(missingPreview.skippedReasons.food_missing).toBe(1);

    const basis = nutrition.addFood({
      name: "Basis change food",
      per100g: { kcal: 100, proteinG: 10, carbsG: 0, fatG: 0, fibreG: 0, sodiumMg: 0 },
      state: "raw",
    });
    const basisEntry = nutrition.logMeal({
      day: "2026-12-02",
      meal: "dinner",
      entries: [{ foodId: basis.id, grams: 50 }],
    }).entries[0];
    nutrition.addFood({
      name: "Basis change food",
      per100g: { kcal: 100, proteinG: 10, carbsG: 0, fatG: 0, fibreG: 0, sodiumMg: 0 },
      state: "cooked",
    });
    const basisPreview = history.previewHistoryRefresh({ foodIds: [basis.id] });
    expect(basisPreview.skipped).toBe(1);
    expect(basisPreview.skippedReasons.basis_changed).toBe(1);
    expect(basisEntry.id).toBeGreaterThan(0);
  });
});

describe("agent auth surface", () => {
  test("discovery needs no credential", async () => {
    const discovery = await import("@/app/api/agent/route");
    const response = await discovery.GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tools: string[];
      posture: string;
    };
    expect(body.tools).toEqual(agentTools.AGENT_TOOLS as never);
    expect(body.posture).toBe(
      "single-user; local agent surface, no token required (trusted LAN only)",
    );
  });

  test("a tool call needs no credential", async () => {
    const toolRoute = await import("@/app/api/agent/[tool]/route");
    const response = await toolRoute.POST(
      new Request("http://127.0.0.1:3040/api/agent/healthvault_context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ tool: "healthvault_context" }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      tool: string;
      result: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.tool).toBe("healthvault_context");
  });
});

describe("agent surface", () => {
  test("the original 27 tools keep their order and the 10 additive tools follow", () => {
    const original = [
      "healthvault_context",
      "profile_get",
      "profile_update",
      "measurement_add",
      "measurement_history",
      "food_search",
      "food_add",
      "meal_log",
      "meal_update",
      "meal_delete",
      "nutrition_day",
      "nutrition_summary",
      "nutrition_target_set",
      "supplement_list",
      "supplement_create",
      "supplement_update",
      "supplement_log",
      "metrics_series",
      "workouts_recent",
      "measurement_delete",
      "food_delete",
      "copy_day",
      "record_types",
      "records_recent",
      "uploads_recent",
      "supplement_history",
      "supplement_delete",
    ];
    expect(agentTools.AGENT_TOOLS.slice(0, 27)).toEqual(original as never);
    expect(agentTools.AGENT_TOOLS.slice(27)).toEqual([
      "recipe_create",
      "recipe_get",
      "recipe_log",
      "recipe_update",
      "recipe_delete",
      "food_template_list",
      "food_template_apply",
      "meal_get",
      "food_history_preview",
      "food_history_refresh",
    ] as never);
  });
});
