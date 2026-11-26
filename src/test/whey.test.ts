/**
 * One-tap whey on a scratch database.
 *
 * Covers the exact serving snapshot, the immutable action association, duplicate protection,
 * transactional supplement logging, Undo across link edits/removal, and rollback on failure.
 * Never reads real health data and never opens `data/health.db`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-whey-test-"));
process.env.DATABASE_PATH = join(scratchDir, "health.db");

const TZ = "Asia/Manila";

let whey: typeof import("@/lib/services/whey");
let nutrition: typeof import("@/lib/services/nutrition");
let supplements: typeof import("@/lib/services/supplements");
let profileService: typeof import("@/lib/services/profile");
let ValidationError: typeof import("@/lib/validate").ValidationError;
let sqlite: import("better-sqlite3").Database;

let today = "";

function count(table: "food_log" | "supplement_logs"): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function addWheyFood() {
  return nutrition.addFood({
    name: "Whey protein isolate",
    brand: "Test",
    servingGrams: 32.4,
    state: "dry",
    per100g: { kcal: 382.716, proteinG: 74.074, carbsG: 6.173, fatG: 4.938 },
    source: "label",
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

function setWheyLink(value: Record<string, unknown> | null) {
  sqlite
    .prepare("UPDATE profile SET whey_link_json = ? WHERE id = 1")
    .run(value === null ? null : JSON.stringify(value));
}

beforeAll(async () => {
  whey = await import("@/lib/services/whey");
  nutrition = await import("@/lib/services/nutrition");
  supplements = await import("@/lib/services/supplements");
  profileService = await import("@/lib/services/profile");
  ({ ValidationError } = await import("@/lib/validate"));
  ({ sqlite } = await import("@/db"));

  profileService.getProfile();
  sqlite.prepare("UPDATE profile SET timezone = ? WHERE id = 1").run(TZ);
  today = (await import("@/lib/day")).localDay(Date.now(), TZ);
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM food_log_ingredients").run();
  sqlite.prepare("DELETE FROM food_log").run();
  sqlite.prepare("DELETE FROM supplement_logs").run();
  sqlite.prepare("DELETE FROM supplements").run();
  sqlite.prepare("DELETE FROM foods").run();
  setWheyLink(null);
});

afterAll(() => {
  // Never close the shared `@/db` handle; only remove this suite's scratch directory.
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("logWhey", () => {
  test("logs the configured serving once and marks the linked supplement", () => {
    const food = addWheyFood();
    const supplement = supplements.createSupplement({ name: "Whey dose", dose: 1, unit: "scoop" });
    profileService.updateProfile({
      wheyLink: { foodId: food.id, supplementId: supplement.id, grams: 32.4, meal: "snack" },
    });

    const result = whey.logWhey();
    expect(result.day).toBe(today);
    expect(result.entry.foodId).toBe(food.id);
    expect(result.entry.meal).toBe("snack");
    expect(result.entry.grams).toBe(32.4);
    expect(result.entry.kcal).toBeCloseTo(124, 3);
    expect(result.entry.proteinG).toBeCloseTo(24, 3);
    expect(result.entry.note).toBeNull();
    expect(result.entry.weightSource).toBe("counted");
    expect(result.entry.macroSource).toBe("label");
    expect(result.entry.estimated).toBe(0);
    expect(result.entry).not.toHaveProperty("wheyActionJson");
    expect(result.entry).not.toHaveProperty("wheyActionDay");
    expect(nutrition.getEntry(result.entry.id)).not.toHaveProperty("wheyActionJson");
    expect(result.supplementId).toBe(supplement.id);

    expect(count("food_log")).toBe(1);
    expect(count("supplement_logs")).toBe(1);
  });

  test("a repeat tap aborts instead of duplicating either record", () => {
    const food = addWheyFood();
    const supplement = supplements.createSupplement({ name: "Whey dose" });
    profileService.updateProfile({ wheyLink: { foodId: food.id, supplementId: supplement.id, grams: 32.4 } });

    whey.logWhey();
    expectValidation(() => whey.logWhey(), 409, /Already logged at .+ — use Undo first/);

    expect(count("food_log")).toBe(1);
    expect(count("supplement_logs")).toBe(1);
  });

  test("the immutable association blocks duplicates after the profile link is removed", () => {
    const food = addWheyFood();
    profileService.updateProfile({ wheyLink: { foodId: food.id, supplementId: null, grams: 32.4 } });
    whey.logWhey();
    profileService.updateProfile({ wheyLink: null });

    expect(whey.hasWheyAction(today)).toBe(true);
    expectValidation(() => whey.logWhey(), 409, /Already logged at .+ — use Undo first/);
  });

  test("Undo remains available and targets the captured supplement after the link is removed", () => {
    const food = addWheyFood();
    const supplement = supplements.createSupplement({ name: "Linked dose" });
    profileService.updateProfile({ wheyLink: { foodId: food.id, supplementId: supplement.id, grams: 32.4 } });
    whey.logWhey();
    profileService.updateProfile({ wheyLink: null });

    expect(whey.hasWheyAction(today)).toBe(true);
    expect(whey.undoWhey()).toMatchObject({ undone: true, supplementId: supplement.id });
    expect(count("food_log")).toBe(0);
    expect(count("supplement_logs")).toBe(0);
  });

  test("undo clears the tagged entry and the supplement log, and is safe to repeat", () => {
    const food = addWheyFood();
    const supplement = supplements.createSupplement({ name: "Whey dose" });
    profileService.updateProfile({ wheyLink: { foodId: food.id, supplementId: supplement.id, grams: 32.4 } });

    whey.logWhey();
    expect(whey.undoWhey()).toMatchObject({ undone: true, day: today, supplementId: supplement.id });
    expect(count("food_log")).toBe(0);
    expect(count("supplement_logs")).toBe(0);

    expect(whey.undoWhey()).toMatchObject({ undone: false, day: today });
    expect(count("food_log")).toBe(0);
    expect(count("supplement_logs")).toBe(0);
  });

  test("undo leaves a separate manual entry for the same food alone", () => {
    const food = addWheyFood();
    profileService.updateProfile({ wheyLink: { foodId: food.id, supplementId: null, grams: 32.4 } });

    nutrition.logMeal({ day: today, meal: "lunch", entries: [{ foodId: food.id, grams: 30 }] });
    whey.logWhey();
    expect(count("food_log")).toBe(2);

    expect(whey.undoWhey().undone).toBe(true);
    expect(count("food_log")).toBe(1);
    const remaining = sqlite.prepare("SELECT note FROM food_log").get() as { note: string | null };
    expect(remaining.note).toBeNull();
  });

  test("Undo uses the captured food and supplement when the link changes or is removed", () => {
    const originalFood = addWheyFood();
    const originalSupplement = supplements.createSupplement({ name: "Original linked dose" });
    const replacementFood = nutrition.addFood({
      name: "Replacement whey",
      per100g: { kcal: 300, proteinG: 60, carbsG: 10, fatG: 4 },
    });
    const replacementSupplement = supplements.createSupplement({ name: "Replacement linked dose" });
    profileService.updateProfile({
      wheyLink: { foodId: originalFood.id, supplementId: originalSupplement.id, grams: 32.4 },
    });
    const originalEntry = whey.logWhey().entry;
    nutrition.updateEntry(originalEntry.id, { note: "note changed after logging" });
    nutrition.logMeal({ day: today, meal: "lunch", entries: [{ foodId: replacementFood.id, grams: 25 }] });
    supplements.logSupplement({ supplementId: replacementSupplement.id, day: today, taken: true, note: "manual" });
    profileService.updateProfile({
      wheyLink: { foodId: replacementFood.id, supplementId: replacementSupplement.id, grams: 30 },
    });

    expect(whey.undoWhey()).toMatchObject({ undone: true, supplementId: originalSupplement.id });
    expect(sqlite.prepare("SELECT id FROM food_log ORDER BY id").all()).toHaveLength(1);
    expect(sqlite.prepare("SELECT id FROM food_log").get()).not.toEqual({ id: originalEntry.id });
    expect(sqlite.prepare("SELECT COUNT(*) AS c FROM supplement_logs WHERE supplement_id = ?").get(originalSupplement.id))
      .toEqual({ c: 0 });
    expect(sqlite.prepare("SELECT note FROM supplement_logs WHERE supplement_id = ?").get(replacementSupplement.id))
      .toEqual({ note: "manual" });

    profileService.updateProfile({ wheyLink: null });
    expect(whey.hasWheyAction(today)).toBe(false);
  });

  test("Undo restores a prior manual dose and leaves a later manual upsert alone", () => {
    const food = addWheyFood();
    const supplement = supplements.createSupplement({ name: "Whey dose", dose: 1, unit: "scoop" });
    profileService.updateProfile({ wheyLink: { foodId: food.id, supplementId: supplement.id, grams: 32.4 } });
    supplements.logSupplement({
      supplementId: supplement.id,
      day: today,
      dose: 2,
      unit: "capsules",
      note: "pre-existing intake",
    });

    whey.logWhey();
    whey.undoWhey();
    expect(sqlite.prepare("SELECT dose, unit, note FROM supplement_logs WHERE supplement_id = ?").get(supplement.id))
      .toEqual({ dose: 2, unit: "capsules", note: "pre-existing intake" });

    whey.logWhey();
    supplements.logSupplement({
      supplementId: supplement.id,
      day: today,
      dose: 3,
      unit: "capsules",
      note: "edited after whey",
    });
    whey.undoWhey();
    expect(sqlite.prepare("SELECT dose, note FROM supplement_logs WHERE supplement_id = ?").get(supplement.id))
      .toEqual({ dose: 3, note: "edited after whey" });
  });

  test("a failure after the food insert rolls the whole transaction back", () => {
    const food = addWheyFood();
    // Bypasses profile validation on purpose: the supplement disappears between setup and tap.
    setWheyLink({ foodId: food.id, supplementId: 999_999, grams: 32.4, meal: "snack" });

    expectValidation(() => whey.logWhey(), 404, /supplement not found/);
    expect(count("food_log")).toBe(0);
    expect(count("supplement_logs")).toBe(0);
  });

  test("an unconfigured or dangling link fails with a clear message", () => {
    expectValidation(() => whey.logWhey(), 409, /not configured/);

    const food = addWheyFood();
    const supplement = supplements.createSupplement({ name: "Linked Whey" });
    profileService.updateProfile({ wheyLink: { foodId: food.id, supplementId: supplement.id, grams: 32.4 } });
    // Linked food and supplement cannot be deleted while pointed to by one-tap whey.
    expectValidation(() => nutrition.deleteFood(food.id), 409, /one-tap whey/);
    expectValidation(() => supplements.deleteSupplement(supplement.id), 409, /one-tap whey/);

    // Simulate a dangling link (bypassing service validation).
    setWheyLink({ foodId: 999_999, supplementId: null, grams: 32.4, meal: "snack" });
    expectValidation(() => whey.logWhey(), 409, /no longer exists/);
    expect(count("food_log")).toBe(0);
  });
});
