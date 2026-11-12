/**
 * Pure helpers for the Foods library form and revision list.
 *
 * Server actions, the page and the client form share these so a measure row, the "estimate"
 * marker and the audit summary cannot drift between the write path and what is rendered. Nothing
 * here reads the database, so it is safe to unit test without a scratch database.
 */
import { fail } from "@/lib/validate";

export type FoodMeasureValue = { name: string; grams: number };

export type FoodFormValues = {
  id: number;
  name: string;
  brand: string | null;
  barcode: string | null;
  servingGrams: number;
  kcalPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  fibrePer100g: number;
  sodiumPer100g: number;
  state: string;
  yieldFactor: number;
  measures: FoodMeasureValue[];
  source: string;
  sourceUrl: string | null;
  sourceDate: string | null;
  estimated: boolean;
};

export type FoodRevisionSummary = {
  id: number;
  at: number;
  changed: string[];
};

/** Keys written by `foodRevisionJson` in the nutrition service, with UI labels. */
const REVISION_FIELDS: [string, string][] = [
  ["name", "Name"],
  ["brand", "Brand"],
  ["barcode", "Barcode"],
  ["servingGrams", "Serving weight"],
  ["kcalPer100g", "kcal / 100 g"],
  ["proteinPer100g", "Protein / 100 g"],
  ["carbsPer100g", "Carbs / 100 g"],
  ["fatPer100g", "Fat / 100 g"],
  ["fibrePer100g", "Fibre / 100 g"],
  ["sodiumPer100g", "Sodium / 100 g"],
  ["state", "Basis"],
  ["yieldFactor", "Yield factor"],
  ["measuresJson", "Household measures"],
  ["source", "Source"],
  ["sourceUrl", "Source URL"],
  ["sourceDate", "Source date"],
  ["extraJson", "Extra"],
];

function parseObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * FormData helpers arrive as parallel arrays (`measureName` / `measureGrams`). Blank pairs are
 * skipped, a half-filled row is an error rather than a silent drop, and duplicate names are
 * rejected because an object map would otherwise keep only the last one.
 */
export function parseMeasureRows(names: unknown[], grams: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = Math.max(names.length, grams.length);
  for (let index = 0; index < rows; index += 1) {
    const nameValue = names[index];
    const gramValue = grams[index];
    const rawName = typeof nameValue === "string" ? nameValue.trim() : "";
    const rawGrams = typeof gramValue === "string" ? gramValue.trim() : "";
    if (rawName === "" && rawGrams === "") continue;
    if (rawName === "") fail(`measure ${index + 1}: name is required`);
    const name = rawName.toLowerCase();
    if (name.length > 40) fail(`measure "${rawName}": name must be at most 40 characters`);
    if (out[name] !== undefined) fail(`measure "${name}" is listed twice`);
    if (rawGrams === "") fail(`measure "${name}": grams are required`);
    const value = Number(rawGrams);
    if (!Number.isFinite(value) || value <= 0) {
      fail(`measure "${name}": grams must be a positive number`);
    }
    if (value > 100_000) fail(`measure "${name}": grams must be ≤ 100000`);
    out[name] = value;
  }
  return out;
}

/** Only the per-food overrides stored on this row; shared measure defaults are not persisted. */
export function storedMeasureRows(measuresJson: string | null | undefined): FoodMeasureValue[] {
  const raw = parseObject(measuresJson);
  if (!raw) return [];
  return Object.entries(raw)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([name, grams]) => ({ name, grams }));
}

/** Parse `foods.extra_json`, tolerating a malformed or `"null"` legacy value. */
export function parseFoodExtra(extraJson: string | null | undefined): Record<string, unknown> {
  return parseObject(extraJson) ?? {};
}

/** A food is flagged estimated when its source says so or its extra metadata carries the marker. */
export function foodIsEstimated(food: { source: string; extraJson: string | null }): boolean {
  return food.source === "estimated" || parseFoodExtra(food.extraJson).estimated === true;
}

/**
 * Set or clear the explicit estimate marker without dropping any other `extra_json` key the
 * agent or an earlier edit stored.
 */
export function foodExtraWithEstimated(
  extraJson: string | null | undefined,
  estimated: boolean,
): Record<string, unknown> {
  const extra = { ...parseFoodExtra(extraJson) };
  if (estimated) {
    extra.estimated = true;
  } else {
    delete extra.estimated;
  }
  return extra;
}

/** Human labels for the fields an edit actually changed, from the stored revision JSON pair. */
export function changedFoodFields(previousJson: string, currentJson: string): string[] {
  const before = parseObject(previousJson);
  const after = parseObject(currentJson);
  if (!before || !after) return [];
  return REVISION_FIELDS.filter(
    ([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  ).map(([, label]) => label);
}
