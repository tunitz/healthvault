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

/* ---------------------------------------------------------------------------------------------
 * Add-food logging
 *
 * Pure types and helpers shared by the diary panel, the server actions that back it and its
 * tests. Nothing here reads the database or computes nutrition — the service layer remains the
 * single source of arithmetic. These helpers only narrow a food to the picker's needs, build the
 * service entry payload from the draft, and persist that plain payload in local storage (no
 * credentials or derived secrets are ever stored).
 * ------------------------------------------------------------------------------------------- */

/** A saved food as the unified picker needs it (never the whole row). */
export type LoggingFoodOption = {
  id: number;
  name: string;
  brand: string | null;
  servingGrams: number;
  state: string;
  yieldFactor: number;
  kcalPer100g: number;
  proteinPer100g: number;
  measures: Record<string, number>;
};

export type LoggingRecipeOption = {
  id: number;
  name: string;
  servingsTotal: number;
  complete: boolean;
  unresolvedCount: number;
};

export type RecentFoodOption = {
  name: string;
  foodId: number | null;
  grams: number;
  kcal: number;
  /** The saved food when still in the library, so a recent chip can log with full defaults. */
  food?: LoggingFoodOption;
};

/** One line of the multi-item draft. Values stay as strings, exactly as the inputs hold them. */
export type MealDraftItem = {
  key: string;
  kind: "food" | "custom" | "recipe";
  label: string;
  /** The picked saved food, kept so its own measures and basis stay available for the editor. */
  food?: LoggingFoodOption;
  foodId?: number;
  recipeId?: number;
  /** Grams when `unit === "g"`, otherwise the household-measure count. */
  quantity: string;
  /** "g" or a measure name valid for that food. */
  unit: string;
  /** gramsAs to send, or "" for "as stored" (no raw/cooked conversion). */
  basis: string;
  weightSource: "weighed" | "counted" | "guessed";
  /** Custom-entry absolute macros for the portion. */
  kcal?: string;
  proteinG?: string;
  carbsG?: string;
  fatG?: string;
  fibreG?: string;
  sodiumMg?: string;
  estimated?: boolean;
  note?: string;
  /** Recipe-only fraction of one serving. */
  servingFraction?: string;
};

export type MealDraft = { meal: string; day: string; time: string; items: MealDraftItem[] };

/** Shape returned by the read-only preview action (arithmetic comes from the service layer). */
export type LoggingPreview = {
  name: string;
  grams: number;
  foodId: number | null;
  weightSource: string;
  macroSource: string;
  gramsAs: string;
  rawEquivalentGrams: number;
  basisState: string;
  basisYieldFactor: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
};

export type FoodSearchResult = { ok: true; items: LoggingFoodOption[] } | { ok: false; error: string };
export type EntryPreviewResult = { ok: true; preview: LoggingPreview } | { ok: false; error: string };
export type SaveDraftResult =
  | { ok: true; message: string; count: number }
  | { ok: false; error: string; itemKey?: string };

export function toLoggingFoodOption(food: {
  id: number;
  name: string;
  brand: string | null;
  servingGrams: number;
  state: string;
  yieldFactor: number;
  kcalPer100g: number;
  proteinPer100g: number;
  measures: Record<string, number>;
}): LoggingFoodOption {
  return {
    id: food.id,
    name: food.name,
    brand: food.brand,
    servingGrams: food.servingGrams,
    state: food.state,
    yieldFactor: food.yieldFactor,
    kcalPer100g: food.kcalPer100g,
    proteinPer100g: food.proteinPer100g,
    measures: { ...food.measures },
  };
}

/** Only states the service can convert are offered; others log in their stored basis. */
export function basisOptionsForFood(state: string): { value: string; label: string }[] {
  if (state === "raw") {
    return [
      { value: "raw", label: "Raw" },
      { value: "cooked", label: "Cooked" },
    ];
  }
  if (state === "cooked") {
    return [
      { value: "cooked", label: "Cooked" },
      { value: "raw", label: "Raw" },
    ];
  }
  if (state === "dry") {
    return [
      { value: "", label: "Dry (as stored)" },
      { value: "cooked", label: "Cooked" },
    ];
  }
  if (state === "rehydrated") {
    return [{ value: "", label: "Rehydrated (as stored)" }];
  }
  return [{ value: "", label: "As sold" }];
}

export function defaultBasisForFood(state: string): string {
  return state === "raw" || state === "cooked" ? state : "";
}

/** Grams plus only the units this food actually has (shared defaults already merged in). */
export function unitsForFood(food: LoggingFoodOption): string[] {
  return ["g", ...Object.keys(food.measures).filter((name) => name !== "g").sort()];
}

export function draftItemFromFood(food: LoggingFoodOption, key: string): MealDraftItem {
  return {
    key,
    kind: "food",
    label: food.name,
    food,
    foodId: food.id,
    quantity: String(food.servingGrams),
    unit: "g",
    basis: defaultBasisForFood(food.state),
    weightSource: "weighed",
  };
}

/** Build the service entry payload for one draft line; `null` for recipe lines. */
export function mealItemToEntry(item: MealDraftItem): Record<string, unknown> | null {
  if (item.kind === "recipe") return null;
  const amount =
    item.unit === "g"
      ? { grams: item.quantity }
      : { measure: { name: item.unit, count: item.quantity } };
  const basis = item.basis ? { gramsAs: item.basis } : {};
  // `key` is a client-only correlation id: the service ignores it, but the save action uses it
  // to attach a validation error to the exact draft line that caused it.
  if (item.kind === "custom") {
    return {
      key: item.key,
      name: item.label,
      ...amount,
      ...basis,
      weightSource: item.unit === "g" ? item.weightSource : "counted",
      kcal: item.kcal ?? "0",
      proteinG: item.proteinG ?? "0",
      carbsG: item.carbsG ?? "0",
      fatG: item.fatG ?? "0",
      fibreG: item.fibreG ?? "0",
      sodiumMg: item.sodiumMg ?? "0",
      estimated: item.estimated === true,
      ...(item.note ? { note: item.note } : {}),
    };
  }
  return {
    key: item.key,
    foodId: item.foodId,
    ...amount,
    ...basis,
    // A household measure is counted, not weighed; grams are weighed. The service also
    // derives this, but stating it keeps the logged provenance explicit.
    weightSource: item.unit === "g" ? "weighed" : "counted",
    ...(item.note ? { note: item.note } : {}),
  };
}

export function mealDraftStorageKey(day: string): string {
  return `hv:meal-draft:${day}`;
}

/** Persist only the plain draft; a malformed or foreign payload is ignored, never trusted. */
export function serializeMealDraft(draft: MealDraft): string {
  return JSON.stringify(draft);
}

export function parseStoredMealDraft(raw: string | null, day: string): MealDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const draft = parsed as Partial<MealDraft>;
    if (draft.day !== day || !Array.isArray(draft.items)) return null;
    const items = draft.items.filter(
      (item): item is MealDraftItem =>
        !!item &&
        typeof item === "object" &&
        typeof item.key === "string" &&
        (item.kind === "food" || item.kind === "custom" || item.kind === "recipe") &&
        typeof item.label === "string",
    );
    return {
      day,
      meal: typeof draft.meal === "string" ? draft.meal : "breakfast",
      time: typeof draft.time === "string" ? draft.time : "",
      items,
    };
  } catch {
    return null;
  }
}
