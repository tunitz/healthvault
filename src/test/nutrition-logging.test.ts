/**
 * UI-first logging: the Add-food draft helpers and the read-only nutrition preview.
 *
 * The preview is the exact arithmetic `logMeal` uses. These tests pin that a preview matches the
 * row that is finally saved (including raw/cooked conversion and household measures), that the
 * draft defaults come from the food rather than a hard-coded 100 g, and that a stored draft is
 * scoped to its day. All writes go to a scratch database under /tmp; no real data is opened.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "hv-nutrition-logging-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const DAY = "2026-11-12";

let nutrition: typeof import("@/lib/services/nutrition");
let profile: typeof import("@/lib/services/profile");
let ui: typeof import("@/lib/foods-ui");
let sqlite: import("better-sqlite3").Database;

beforeAll(async () => {
  nutrition = await import("@/lib/services/nutrition");
  profile = await import("@/lib/services/profile");
  ui = await import("@/lib/foods-ui");
  ({ sqlite } = await import("@/db"));
  profile.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run("Asia/Manila");
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM food_log").run();
  sqlite.prepare("DELETE FROM foods").run();
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function savedFood(overrides: Record<string, unknown> = {}) {
  return nutrition.addFood({
    name: "Test food",
    servingGrams: 60,
    per100g: { kcal: 120, proteinG: 25, carbsG: 10, fatG: 3, fibreG: 1, sodiumMg: 40 },
    ...overrides,
  });
}

describe("draft helpers", () => {
  test("a picked food supplies its own serving grams, basis and household units", () => {
    const food = ui.toLoggingFoodOption(
      savedFood({ name: "Egg", servingGrams: 60, measures: { piece: 60 }, state: "raw" }),
    );
    const item = ui.draftItemFromFood(food, "k1");
    expect(item.kind).toBe("food");
    expect(item.foodId).toBe(food.id);
    expect(item.label).toBe("Egg");
    expect(item.quantity).toBe("60"); // the food's serving, never a hard-coded 100
    expect(item.unit).toBe("g");
    expect(item.basis).toBe("raw");
    expect(item.food).toEqual(food);
    expect(ui.unitsForFood(food)).toContain("piece");
    expect(ui.unitsForFood(food)[0]).toBe("g");
  });

  test("basis options follow the food state; dry/whole foods log in their stored basis", () => {
    expect(ui.basisOptionsForFood("raw").map((option) => option.value)).toEqual(["raw", "cooked"]);
    expect(ui.defaultBasisForFood("dry")).toBe("");
    expect(ui.basisOptionsForFood("none")).toEqual([{ value: "", label: "As sold" }]);
  });

  test("the entry payload records gramsAs for weigh-ins and counted for measures", () => {
    const food = ui.toLoggingFoodOption(savedFood({ name: "Chicken", yieldFactor: 0.75, state: "raw" }));
    const base = ui.draftItemFromFood(food, "k2");
    expect(ui.mealItemToEntry({ ...base, quantity: "215", basis: "cooked" })).toMatchObject({
      foodId: food.id,
      grams: "215",
      gramsAs: "cooked",
      weightSource: "weighed",
    });
    expect(ui.mealItemToEntry({ ...base, unit: "piece", quantity: "2" })).toMatchObject({
      foodId: food.id,
      measure: { name: "piece", count: "2" },
      weightSource: "counted",
    });
  });

  test("custom entries carry absolute portion macros and recipe lines produce no entry", () => {
    expect(
      ui.mealItemToEntry({
        key: "k3",
        kind: "custom",
        label: "Snack",
        quantity: "80",
        unit: "g",
        basis: "",
        weightSource: "guessed",
        kcal: "200",
        proteinG: "5",
      }),
    ).toMatchObject({ name: "Snack", grams: "80", kcal: "200", proteinG: "5", weightSource: "guessed" });
    expect(
      ui.mealItemToEntry({ key: "k4", kind: "recipe", label: "Dinner", quantity: "1", unit: "serving", basis: "", weightSource: "counted" }),
    ).toBeNull();
  });

  test("stored drafts are scoped to a day and ignore malformed payloads", () => {
    const draft: import("@/lib/foods-ui").MealDraft = {
      day: DAY,
      meal: "lunch",
      time: "12:30",
      items: [{ key: "k5", kind: "food", label: "Rice", quantity: "100", unit: "g", basis: "", weightSource: "weighed" }],
    };
    const raw = ui.serializeMealDraft(draft);
    expect(ui.parseStoredMealDraft(raw, DAY)).toEqual(draft);
    expect(ui.parseStoredMealDraft(raw, "2026-11-13")).toBeNull();
    expect(ui.parseStoredMealDraft("{broken", DAY)).toBeNull();
    expect(ui.parseStoredMealDraft(null, DAY)).toBeNull();
  });
});

describe("previewEntry shares logMeal arithmetic", () => {
  test("215 g cooked chicken converts to the raw basis and matches the saved entry", () => {
    const food = savedFood({ name: "Chicken breast, raw", state: "raw", yieldFactor: 0.75 });
    const entry = { foodId: food.id, grams: 215, gramsAs: "cooked" };
    const preview = nutrition.previewEntry(entry);
    expect(preview.rawEquivalentGrams).toBeCloseTo(215 / 0.75, 4);
    expect(preview.macros.kcal).toBeCloseTo(344, 0);
    expect(preview.gramsAs).toBe("cooked");

    const saved = nutrition.logMeal({ day: DAY, meal: "lunch", entries: [entry] });
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].kcal).toBeCloseTo(preview.macros.kcal, 6);
    expect(saved.entries[0].proteinG).toBeCloseTo(preview.macros.proteinG, 6);
    expect(saved.entries[0].rawEquivalentGrams).toBeCloseTo(preview.rawEquivalentGrams, 6);
    expect(saved.entries[0].gramsAs).toBe("cooked");
  });

  test("a household measure resolves to grams with counted provenance", () => {
    const food = savedFood({ name: "Jumbo egg", measures: { piece: 60 } });
    const entry = { foodId: food.id, measure: { name: "piece", count: 2 } };
    const preview = nutrition.previewEntry(entry);
    expect(preview.grams).toBe(120);
    expect(preview.weightSource).toBe("counted");
    expect(preview.macros.kcal).toBeCloseTo(144, 0);
    const saved = nutrition.logMeal({ day: DAY, meal: "breakfast", entries: [entry] });
    expect(saved.entries[0].kcal).toBeCloseTo(preview.macros.kcal, 6);
  });

  test("a mismatched state is rejected rather than silently reinterpreting nutrition", () => {
    const food = savedFood({ name: "Raw item", state: "raw", yieldFactor: 0.75 });
    expect(() => nutrition.previewEntry({ foodId: food.id, grams: 100, state: "cooked" })).toThrow(
      /gramsAs/,
    );
  });

  test("custom absolute macros are not rescaled by grams", () => {
    const preview = nutrition.previewEntry({
      name: "Coffee",
      grams: 200,
      kcal: 7,
      proteinG: 0.4,
      estimated: false,
    });
    expect(preview.macros.kcal).toBe(7);
    expect(preview.macros.proteinG).toBe(0.4);
    expect(preview.macroSource).toBe("label");
  });

  test("one final save logs a whole multi-item draft to its meal and date", () => {
    const a = savedFood({ name: "Oats" });
    const b = savedFood({ name: "Milk" });
    const saved = nutrition.logMeal({
      day: DAY,
      meal: "breakfast",
      eatenAt: new Date(`${DAY}T08:15:00+08:00`).getTime(),
      entries: [
        { foodId: a.id, grams: 40 },
        { foodId: b.id, grams: 200 },
      ],
    });
    expect(saved.day).toBe(DAY);
    expect(saved.meal).toBe("breakfast");
    expect(saved.entries).toHaveLength(2);
    expect(new Set(saved.entries.map((entry) => entry.eatenAtMs)).size).toBe(2);
  });
});
