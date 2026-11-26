/**
 * Pure Foods-library helpers: measure rows, the estimate marker and revision labels.
 *
 * These functions sit between the form and `addFood` / `updateFood`, so the tests pin the cases
 * that would otherwise silently corrupt a definition: a half-filled measure row, duplicate unit
 * names, and an extra-metadata merge that drops an unrelated key. No database is imported.
 */
import { describe, expect, test } from "bun:test";
import {
  changedFoodFields,
  foodExtraWithEstimated,
  foodIsEstimated,
  parseMeasureRows,
  storedMeasureRows,
} from "@/lib/foods-ui";
import { ValidationError } from "@/lib/validate";

function expectValidation(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { status: number }).status).toBe(400);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected a ValidationError");
}

describe("parseMeasureRows", () => {
  test("pairs names with grams, trims, lower-cases and skips blank pairs", () => {
    expect(
      parseMeasureRows([" TBSP ", "", "Piece"], ["21", "", "60"]),
    ).toEqual({ tbsp: 21, piece: 60 });
    expect(parseMeasureRows([], [])).toEqual({});
  });

  test("rejects a row with only a name or only grams", () => {
    expectValidation(() => parseMeasureRows(["tbsp"], [""]), /grams are required/);
    expectValidation(() => parseMeasureRows([""], ["21"]), /name is required/);
  });

  test("rejects duplicate unit names case-insensitively", () => {
    expectValidation(
      () => parseMeasureRows(["tbsp", "TBSP"], ["21", "22"]),
      /listed twice/,
    );
  });

  test("rejects a non-positive or absurd weight and an over-long name", () => {
    expectValidation(() => parseMeasureRows(["tbsp"], ["0"]), /positive/);
    expectValidation(() => parseMeasureRows(["tbsp"], ["-1"]), /positive/);
    expectValidation(() => parseMeasureRows(["tbsp"], ["100001"]), /≤ 100000/);
    expectValidation(() => parseMeasureRows(["x".repeat(41)], ["10"]), /at most 40/);
  });
});

describe("storedMeasureRows", () => {
  test("returns only positive numeric per-food overrides", () => {
    expect(storedMeasureRows('{"tbsp":21,"broken":"nope","zero":0}')).toEqual([
      { name: "tbsp", grams: 21 },
    ]);
    expect(storedMeasureRows(null)).toEqual([]);
    expect(storedMeasureRows("null")).toEqual([]);
    expect(storedMeasureRows("{not json")).toEqual([]);
  });
});

describe("foodExtraWithEstimated", () => {
  test("sets and clears only the estimate marker", () => {
    expect(foodExtraWithEstimated('{"note":"kept"}', true)).toEqual({
      note: "kept",
      estimated: true,
    });
    expect(foodExtraWithEstimated('{"note":"kept","estimated":true}', false)).toEqual({
      note: "kept",
    });
    expect(foodExtraWithEstimated(null, true)).toEqual({ estimated: true });
    expect(foodExtraWithEstimated("not json", false)).toEqual({});
  });
});

describe("foodIsEstimated", () => {
  test("accepts either an estimated source or the extra marker", () => {
    expect(foodIsEstimated({ source: "estimated", extraJson: null })).toBe(true);
    expect(foodIsEstimated({ source: "label", extraJson: '{"estimated":true}' })).toBe(true);
    expect(foodIsEstimated({ source: "label", extraJson: '{"estimated":false}' })).toBe(false);
    expect(foodIsEstimated({ source: "label", extraJson: null })).toBe(false);
  });
});

describe("changedFoodFields", () => {
  test("names the fields an edit actually changed", () => {
    const before = JSON.stringify({ name: "Oats", brand: "Acme", kcalPer100g: 100, state: "raw" });
    const after = JSON.stringify({ name: "Rolled oats", brand: "Acme", kcalPer100g: 120, state: "raw" });
    expect(changedFoodFields(before, after)).toEqual(["Name", "kcal / 100 g"]);
    expect(changedFoodFields(before, before)).toEqual([]);
  });

  test("returns an empty list for malformed revision JSON", () => {
    expect(changedFoodFields("not json", "{}")).toEqual([]);
    expect(changedFoodFields("{}", "[]")).toEqual([]);
  });
});
