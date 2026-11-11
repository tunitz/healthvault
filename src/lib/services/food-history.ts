import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { foodLog, foodLogIngredients, foods } from "@/db/schema";
import { dayField, fail, idField, str } from "@/lib/validate";
import {
  entryJson,
  ingredientJson,
  ingredientsForEntry,
  totalsFromIngredients,
  writeRevision,
  type LoggedIngredient,
} from "@/lib/services/food-log-snapshots";
import type { Food, Macros } from "@/lib/services/nutrition";

/**
 * Explicit history refresh: when a saved food's nutrition changes, already logged snapshots
 * stay untouched until the user asks for a correction.
 *
 * The flow is preview -> apply. Preview never writes; it returns a hash of the exact change set.
 * Apply must present that hash, so a stale preview cannot silently correct rows the user did not
 * see. Rows are scoped by food id and/or entry id, never corrected globally by default.
 *
 * A row is skipped, never guessed, when the food is gone, the snapshot has no basis metadata, or
 * the food's per-100 g basis state changed. Legacy aggregate-only recipe rows have no ingredient
 * rows to refresh, so they are left untouched and the day view labels them incomplete.
 */

export type HistoryScopeInput = {
  foodIds?: unknown;
  entryIds?: unknown;
  fromDay?: unknown;
  toDay?: unknown;
};

export type HistoryScope = {
  foodIds: number[];
  entryIds: number[];
  fromDay: string | null;
  toDay: string | null;
};

export type SnapshotValues = Macros & {
  grams: number;
  rawEquivalentGrams: number | null;
};

export type HistoryChange = {
  kind: "entry" | "ingredient";
  entryId: number;
  ingredientId: number | null;
  foodId: number | null;
  name: string;
  day: string;
  meal: string;
  status: "changed" | "unchanged" | "skipped";
  reason: string | null;
  previous: SnapshotValues | null;
  proposed: SnapshotValues | null;
};

export type HistoryPreview = {
  scope: HistoryScope;
  /** Deterministic hash of the change set; `food_history_refresh` requires it. */
  previewHash: string;
  changed: number;
  unchanged: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  changes: HistoryChange[];
};

export type HistoryRefreshResult = {
  applied: number;
  entriesTouched: number;
  revisions: number;
  skipped: number;
  previewHash: string;
};

const MACRO_KEYS: (keyof Macros)[] = [
  "kcal",
  "proteinG",
  "carbsG",
  "fatG",
  "fibreG",
  "sodiumMg",
];

/** A scope matching more snapshots than this is rejected instead of partially corrected. */
export const MAX_HISTORY_REFRESH_ROWS = 500;

function idList(value: unknown, name: string, max: number): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${name} must be an array of ids`);
  if (value.length > max) fail(`${name} accepts at most ${max} ids`);
  return [...new Set(value.map((item, index) => idField(item, `${name}[${index}]`)))];
}

function parseScope(input: HistoryScopeInput): HistoryScope {
  const foodIds = idList(input.foodIds, "foodIds", 200);
  const entryIds = idList(input.entryIds, "entryIds", 500);
  if (foodIds.length === 0 && entryIds.length === 0) {
    fail("scope the refresh with foodIds and/or entryIds; a global past-meal rewrite is never implicit");
  }
  const fromDay =
    input.fromDay === undefined || input.fromDay === null || input.fromDay === ""
      ? null
      : dayField(input.fromDay, "fromDay");
  const toDay =
    input.toDay === undefined || input.toDay === null || input.toDay === ""
      ? null
      : dayField(input.toDay, "toDay");
  if (fromDay !== null && toDay !== null && fromDay > toDay) {
    fail("fromDay must be on or before toDay");
  }
  return { foodIds, entryIds, fromDay, toDay };
}

function sameMacros(a: Macros, b: Macros, epsilon = 1e-6): boolean {
  return MACRO_KEYS.every((key) => Math.abs(a[key] - b[key]) <= epsilon);
}

function valuesOf(row: {
  grams: number;
  rawEquivalentGrams: number | null;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
}): SnapshotValues {
  return {
    grams: row.grams,
    rawEquivalentGrams: row.rawEquivalentGrams,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    fibreG: row.fibreG,
    sodiumMg: row.sodiumMg,
  };
}

function macrosFromFood(food: Food, basisGrams: number): Macros {
  const factor = basisGrams / 100;
  return {
    kcal: food.kcalPer100g * factor,
    proteinG: food.proteinPer100g * factor,
    carbsG: food.carbsPer100g * factor,
    fatG: food.fatPer100g * factor,
    fibreG: food.fibrePer100g * factor,
    sodiumMg: food.sodiumPer100g * factor,
  };
}

/** A history correction fixes values, never provenance: the logged source is left exactly as is. */

function changeKey(change: HistoryChange): string {
  return `${change.kind}:${change.entryId}:${change.ingredientId ?? 0}`;
}

function hashChanges(scope: HistoryScope, changes: HistoryChange[]): string {
  const stable = [...changes]
    .sort((a, b) => {
      const left = changeKey(a);
      const right = changeKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((change) => ({
      kind: change.kind,
      entryId: change.entryId,
      ingredientId: change.ingredientId,
      foodId: change.foodId,
      name: change.name,
      day: change.day,
      meal: change.meal,
      status: change.status,
      reason: change.reason,
      previous: change.previous,
      proposed: change.proposed,
    }));
  return createHash("sha256")
    .update(JSON.stringify({ scope, changes: stable }))
    .digest("hex");
}

type PlainCandidate = typeof foodLog.$inferSelect;

function plainCandidates(scope: HistoryScope): PlainCandidate[] {
  const conditions = [
    isNotNull(foodLog.foodId),
    isNull(foodLog.recipeId),
    isNull(foodLog.recipeServingJson),
  ];
  if (scope.foodIds.length > 0) conditions.push(inArray(foodLog.foodId, scope.foodIds));
  if (scope.entryIds.length > 0) conditions.push(inArray(foodLog.id, scope.entryIds));
  if (scope.fromDay !== null) conditions.push(gte(foodLog.day, scope.fromDay));
  if (scope.toDay !== null) conditions.push(lte(foodLog.day, scope.toDay));
  return db
    .select()
    .from(foodLog)
    .where(and(...conditions))
    .orderBy(foodLog.day, foodLog.eatenAtMs)
    .all();
}

type ChildCandidate = LoggedIngredient;

function childCandidates(scope: HistoryScope): ChildCandidate[] {
  const conditions = [];
  if (scope.foodIds.length > 0) conditions.push(inArray(foodLogIngredients.foodId, scope.foodIds));
  if (scope.entryIds.length > 0) {
    conditions.push(inArray(foodLogIngredients.foodLogId, scope.entryIds));
  }
  if (scope.fromDay !== null || scope.toDay !== null) {
    const dayConditions = [];
    if (scope.fromDay !== null) dayConditions.push(gte(foodLog.day, scope.fromDay));
    if (scope.toDay !== null) dayConditions.push(lte(foodLog.day, scope.toDay));
    conditions.push(
      inArray(
        foodLogIngredients.foodLogId,
        db.select({ id: foodLog.id }).from(foodLog).where(and(...dayConditions)),
      ),
    );
  }
  return db
    .select()
    .from(foodLogIngredients)
    .where(and(...conditions))
    .orderBy(foodLogIngredients.foodLogId, foodLogIngredients.position, foodLogIngredients.id)
    .all();
}

/**
 * Build the preview. Read-only: no `food_log`, ingredient, or revision row is written here.
 */
export function previewHistoryRefresh(input: HistoryScopeInput): HistoryPreview {
  const scope = parseScope(input);
  const foodIdSet = new Set(scope.foodIds);
  const foodById = new Map<number, Food>();
  const loadFood = (id: number): Food | null => {
    const cached = foodById.get(id);
    if (cached) return cached;
    const row = db.select().from(foods).where(eq(foods.id, id)).get();
    if (!row) return null;
    foodById.set(id, row);
    return row;
  };

  // Entries with child snapshots are corrected ingredient by ingredient; never both ways.
  const children = childCandidates(scope);
  const childEntryIds = new Set(children.map((child) => child.foodLogId));
  const entriesWithChildren = new Set<number>();
  if (scope.entryIds.length > 0) {
    for (const row of db
      .select({ foodLogId: foodLogIngredients.foodLogId })
      .from(foodLogIngredients)
      .where(inArray(foodLogIngredients.foodLogId, scope.entryIds))
      .all()) {
      entriesWithChildren.add(row.foodLogId);
    }
  }
  const plain = plainCandidates(scope).filter((entry) => !childEntryIds.has(entry.id));
  const candidateCount = plain.length + children.length;
  if (candidateCount > MAX_HISTORY_REFRESH_ROWS) {
    fail(
      `scope matches ${candidateCount} snapshots; narrow foodIds/entryIds or the day range to at most ${MAX_HISTORY_REFRESH_ROWS}`,
      400,
    );
  }

  const changes: HistoryChange[] = [];
  const skippedReasons: Record<string, number> = {};
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;

  const skip = (change: HistoryChange, reason: string) => {
    skipped += 1;
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    changes.push({ ...change, status: "skipped", reason });
  };

  const entrySkipChange = (entry: PlainCandidate): HistoryChange => ({
    kind: "entry",
    entryId: entry.id,
    ingredientId: null,
    foodId: entry.foodId,
    name: entry.name,
    day: entry.day,
    meal: entry.meal,
    status: "unchanged",
    reason: null,
    previous: valuesOf(entry),
    proposed: null,
  });

  for (const entry of plain) {
    const previous = valuesOf(entry);
    if (entry.foodId === null) continue;
    if (scope.foodIds.length > 0 && !foodIdSet.has(entry.foodId)) continue;
    const food = loadFood(entry.foodId);
    if (!food) {
      skip(
        {
          kind: "entry",
          entryId: entry.id,
          ingredientId: null,
          foodId: entry.foodId,
          name: entry.name,
          day: entry.day,
          meal: entry.meal,
          status: "unchanged",
          reason: null,
          previous,
          proposed: null,
        },
        "food_missing",
      );
      continue;
    }
    const basisState =
      entry.basisState ??
      (entry.gramsAs !== null && entry.gramsAs === food.state ? food.state : null);
    if (basisState === null) {
      skip(
        {
          kind: "entry",
          entryId: entry.id,
          ingredientId: null,
          foodId: entry.foodId,
          name: entry.name,
          day: entry.day,
          meal: entry.meal,
          status: "unchanged",
          reason: null,
          previous,
          proposed: null,
        },
        "basis_unknown",
      );
      continue;
    }
    if (basisState !== food.state) {
      skip(
        {
          kind: "entry",
          entryId: entry.id,
          ingredientId: null,
          foodId: entry.foodId,
          name: entry.name,
          day: entry.day,
          meal: entry.meal,
          status: "unchanged",
          reason: null,
          previous,
          proposed: null,
        },
        "basis_changed",
      );
      continue;
    }
    const conversionInPlay = entry.gramsAs !== null && entry.gramsAs !== food.state;
    if (conversionInPlay) {
      if (entry.basisYieldFactor === null) {
        skip(entrySkipChange(entry), "basis_unknown");
        continue;
      }
      if (entry.basisYieldFactor !== food.yieldFactor) {
        skip(entrySkipChange(entry), "yield_changed");
        continue;
      }
    }
    const basisGrams =
      entry.rawEquivalentGrams ??
      (entry.gramsAs === food.state || entry.gramsAs === null ? entry.grams : null);
    if (basisGrams === null) {
      skip(
        {
          kind: "entry",
          entryId: entry.id,
          ingredientId: null,
          foodId: entry.foodId,
          name: entry.name,
          day: entry.day,
          meal: entry.meal,
          status: "unchanged",
          reason: null,
          previous,
          proposed: null,
        },
        "basis_unknown",
      );
      continue;
    }
    const proposedMacros = macrosFromFood(food, basisGrams);
    const proposed: SnapshotValues = {
      grams: entry.grams,
      rawEquivalentGrams: entry.rawEquivalentGrams,
      ...proposedMacros,
    };
    if (sameMacros(previous, proposed)) {
      unchanged += 1;
      changes.push({
        kind: "entry",
        entryId: entry.id,
        ingredientId: null,
        foodId: entry.foodId,
        name: entry.name,
        day: entry.day,
        meal: entry.meal,
        status: "unchanged",
        reason: null,
        previous,
        proposed,
      });
    } else {
      changed += 1;
      changes.push({
        kind: "entry",
        entryId: entry.id,
        ingredientId: null,
        foodId: entry.foodId,
        name: entry.name,
        day: entry.day,
        meal: entry.meal,
        status: "changed",
        reason: null,
        previous,
        proposed,
      });
    }
  }

  for (const child of children) {
    const previous = valuesOf(child);
    const entry = db.select().from(foodLog).where(eq(foodLog.id, child.foodLogId)).get();
    if (!entry) continue;
    const base = {
      kind: "ingredient" as const,
      entryId: child.foodLogId,
      ingredientId: child.id,
      foodId: child.foodId,
      name: child.name,
      day: entry.day,
      meal: entry.meal,
      status: "unchanged" as const,
      reason: null,
      previous,
      proposed: null,
    };
    if (child.foodId === null) {
      skip(base, "unresolved_ingredient");
      continue;
    }
    if (scope.foodIds.length > 0 && !foodIdSet.has(child.foodId)) continue;
    const food = loadFood(child.foodId);
    if (!food) {
      skip(base, "food_missing");
      continue;
    }
    if (child.resolved === 0) {
      skip(base, "unresolved_ingredient");
      continue;
    }
    if (child.foodState === null) {
      skip(base, "basis_unknown");
      continue;
    }
    if (child.foodState !== food.state) {
      skip(base, "basis_changed");
      continue;
    }
    const conversionInPlay = child.gramsAs !== null && child.gramsAs !== child.foodState;
    if (conversionInPlay) {
      if (child.yieldFactor === null) {
        skip(base, "basis_unknown");
        continue;
      }
      if (child.yieldFactor !== food.yieldFactor) {
        skip(base, "yield_changed");
        continue;
      }
    }
    if (child.rawEquivalentGrams === null) {
      skip(base, "basis_unknown");
      continue;
    }
    const proposed: SnapshotValues = {
      grams: child.grams,
      rawEquivalentGrams: child.rawEquivalentGrams,
      ...macrosFromFood(food, child.rawEquivalentGrams),
    };
    if (sameMacros(previous, proposed)) {
      unchanged += 1;
      changes.push({ ...base, status: "unchanged", proposed });
    } else {
      changed += 1;
      changes.push({ ...base, status: "changed", proposed });
    }
  }

  // A legacy aggregate-only recipe row in an explicitly scoped entry list has no child snapshot
  // to correct. Surface it as skipped rather than silently omitting it from the preview.
  if (scope.entryIds.length > 0) {
    const legacyConditions = [
      inArray(foodLog.id, scope.entryIds),
      or(isNotNull(foodLog.recipeId), isNotNull(foodLog.recipeServingJson))!,
    ];
    if (scope.fromDay !== null) legacyConditions.push(gte(foodLog.day, scope.fromDay));
    if (scope.toDay !== null) legacyConditions.push(lte(foodLog.day, scope.toDay));
    const legacyRows = db
      .select()
      .from(foodLog)
      .where(and(...legacyConditions))
      .all();
    for (const entry of legacyRows) {
      if (entriesWithChildren.has(entry.id)) continue;
      if (changes.some((change) => change.entryId === entry.id)) continue;
      skip(entrySkipChange(entry), "aggregate_snapshot_without_ingredients");
    }
  }

  return {
    scope,
    previewHash: hashChanges(scope, changes),
    changed,
    unchanged,
    skipped,
    skippedReasons,
    changes,
  };
}

function recomputeRecipeEntry(
  entryId: number,
  now: number,
): { updated: boolean; revisions: number } {
  const entry = db.select().from(foodLog).where(eq(foodLog.id, entryId)).get();
  if (!entry) return { updated: false, revisions: 0 };
  const children = ingredientsForEntry(entryId);
  if (children.length === 0) return { updated: false, revisions: 0 };
  const totals = totalsFromIngredients(children);
  const fraction = entry.servingFraction && entry.servingFraction > 0 ? entry.servingFraction : 1;
  const next = {
    grams: totals.grams,
    rawEquivalentGrams: totals.rawEquivalentGrams,
    kcal: totals.macros.kcal,
    proteinG: totals.macros.proteinG,
    carbsG: totals.macros.carbsG,
    fatG: totals.macros.fatG,
    fibreG: totals.macros.fibreG,
    sodiumMg: totals.macros.sodiumMg,
    estimated: totals.estimated ? 1 : 0,
    macroSource: totals.estimated ? ("estimated" as const) : ("recipe" as const),
    recipeServingJson: JSON.stringify({
      grams: totals.grams / fraction,
      kcal: totals.macros.kcal / fraction,
      proteinG: totals.macros.proteinG / fraction,
      carbsG: totals.macros.carbsG / fraction,
      fatG: totals.macros.fatG / fraction,
      fibreG: totals.macros.fibreG / fraction,
      sodiumMg: totals.macros.sodiumMg / fraction,
      estimated: totals.estimated,
      snapshotVersion: 2,
      ingredientCount: children.length,
    }),
    updatedAtMs: now,
  };
  const current = valuesOf(entry);
  const proposed = valuesOf(next);
  if (
    sameMacros(current, proposed) &&
    entry.grams === next.grams &&
    entry.recipeServingJson === next.recipeServingJson
  ) {
    return { updated: false, revisions: 0 };
  }
  const row = db.update(foodLog).set(next).where(eq(foodLog.id, entryId)).returning().get()!;
  writeRevision({
    foodLogId: entryId,
    reason: "recipe_snapshot_recomputed",
    previousJson: entryJson(entry),
    newJson: entryJson(row),
    createdAtMs: now,
  });
  return { updated: true, revisions: 1 };
}

/**
 * Apply a previewed correction. The preview hash must match the current change set exactly.
 */
export function applyHistoryRefresh(
  input: HistoryScopeInput & { previewHash?: unknown },
): HistoryRefreshResult {
  const previewHash = str(input.previewHash, "previewHash", { required: true, max: 128 })!;
  const preview = previewHistoryRefresh(input);
  if (preview.previewHash !== previewHash) {
    fail(
      "history preview is stale: the food or scope changed since it was generated; run food_history_preview again",
      409,
    );
  }

  const changed = preview.changes.filter((change) => change.status === "changed");
  const now = Date.now();
  let applied = 0;
  let revisions = 0;
  const touchedEntries = new Set<number>();

  sqlite.transaction(() => {
    for (const change of changed) {
      if (change.proposed === null) continue;
      if (change.kind === "ingredient" && change.ingredientId !== null) {
        const row = db
          .select()
          .from(foodLogIngredients)
          .where(eq(foodLogIngredients.id, change.ingredientId))
          .get();
        if (!row) continue;
        const food = row.foodId === null ? null : db.select().from(foods).where(eq(foods.id, row.foodId)).get();
        if (!food) continue;
        const next = {
          ...row,
          kcalPer100g: food.kcalPer100g,
          proteinPer100g: food.proteinPer100g,
          carbsPer100g: food.carbsPer100g,
          fatPer100g: food.fatPer100g,
          fibrePer100g: food.fibrePer100g,
          sodiumPer100g: food.sodiumPer100g,
          kcal: change.proposed.kcal,
          proteinG: change.proposed.proteinG,
          carbsG: change.proposed.carbsG,
          fatG: change.proposed.fatG,
          fibreG: change.proposed.fibreG,
          sodiumMg: change.proposed.sodiumMg,
          source: food.source,
          sourceUrl: food.sourceUrl,
          sourceDate: food.sourceDate,
        };
        db.update(foodLogIngredients)
          .set({
            kcalPer100g: next.kcalPer100g,
            proteinPer100g: next.proteinPer100g,
            carbsPer100g: next.carbsPer100g,
            fatPer100g: next.fatPer100g,
            fibrePer100g: next.fibrePer100g,
            sodiumPer100g: next.sodiumPer100g,
            kcal: next.kcal,
            proteinG: next.proteinG,
            carbsG: next.carbsG,
            fatG: next.fatG,
            fibreG: next.fibreG,
            sodiumMg: next.sodiumMg,
            source: next.source,
            sourceUrl: next.sourceUrl,
            sourceDate: next.sourceDate,
          })
          .where(eq(foodLogIngredients.id, row.id))
          .run();
        writeRevision({
          foodLogId: row.foodLogId,
          foodLogIngredientId: row.id,
          foodId: row.foodId,
          reason: "food_history_refresh",
          previousJson: ingredientJson(row),
          newJson: ingredientJson(next),
          createdAtMs: now,
        });
        applied += 1;
        revisions += 1;
        touchedEntries.add(row.foodLogId);
      } else {
        const entry = db.select().from(foodLog).where(eq(foodLog.id, change.entryId)).get();
        if (!entry || entry.foodId === null) continue;
        const food = db.select().from(foods).where(eq(foods.id, entry.foodId)).get();
        if (!food) continue;
        const next = {
          ...entry,
          kcal: change.proposed.kcal,
          proteinG: change.proposed.proteinG,
          carbsG: change.proposed.carbsG,
          fatG: change.proposed.fatG,
          fibreG: change.proposed.fibreG,
          sodiumMg: change.proposed.sodiumMg,
          updatedAtMs: now,
        };
        const row = db
          .update(foodLog)
          .set({
            kcal: next.kcal,
            proteinG: next.proteinG,
            carbsG: next.carbsG,
            fatG: next.fatG,
            fibreG: next.fibreG,
            sodiumMg: next.sodiumMg,
            updatedAtMs: now,
          })
          .where(eq(foodLog.id, entry.id))
          .returning()
          .get()!;
        writeRevision({
          foodLogId: entry.id,
          reason: "food_history_refresh",
          foodId: entry.foodId,
          previousJson: entryJson(entry),
          newJson: entryJson(row),
          createdAtMs: now,
        });
        applied += 1;
        revisions += 1;
        touchedEntries.add(entry.id);
      }
    }

    // A child correction changes the parent's aggregate; recompute it from the stored children.
    for (const entryId of touchedEntries) {
      const result = recomputeRecipeEntry(entryId, now);
      revisions += result.revisions;
    }
  })();

  return {
    applied,
    entriesTouched: touchedEntries.size,
    revisions,
    skipped: preview.skipped,
    previewHash: preview.previewHash,
  };
}
