/**
 * Pure helpers for the logged-meal review cards (Nutrition day view).
 *
 * The day service already returns every stored snapshot, so nothing here reads the database or
 * recomputes nutrition. These helpers only turn stored JSON into display values, and label the
 * three honest states a snapshot can be in:
 *
 *  - a complete ingredient snapshot (recipe logged after snapshots existed),
 *  - a legacy aggregate-only row whose ingredients were never recorded, and
 *  - a plain food entry, which has no ingredient breakdown at all.
 *
 * Missing data is always shown as missing. A legacy row is never reconstructed from today's
 * recipe, and an unresolved ingredient is never rendered as zero nutrition.
 */
import type { Macros } from "@/lib/services/nutrition";

export type StoredServingSnapshot = Macros & {
  grams: number;
  estimated: boolean;
};

/**
 * The per-one-serving values captured when a recipe row was logged.
 *
 * This mirrors `parseServingSnapshot` in `src/lib/services/nutrition.ts` (which stays the write
 * path's authority) so the client can decide whether a portion edit is safe without importing a
 * server module.
 *
 * Returns null when the JSON is absent or unreadable: that entry predates the per-serving
 * snapshot, so its historical arithmetic was never recorded and it cannot be rescaled.
 */
export function parseStoredServing(json: string | null | undefined): StoredServingSnapshot | null {
  if (!json) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw.grams !== "number" || typeof raw.kcal !== "number") return null;
  const value = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
  return {
    grams: raw.grams,
    kcal: raw.kcal,
    proteinG: value("proteinG"),
    carbsG: value("carbsG"),
    fatG: value("fatG"),
    fibreG: value("fibreG"),
    sodiumMg: value("sodiumMg"),
    estimated: raw.estimated === true,
  };
}

/** A stored household measure ("2 × tbsp") or null when the ingredient had none. */
export function parseStoredMeasure(json: string | null | undefined): { name: string; count: number } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.name !== "string" || typeof parsed.count !== "number") return null;
    if (parsed.name.trim() === "" || !Number.isFinite(parsed.count)) return null;
    return { name: parsed.name, count: parsed.count };
  } catch {
    return null;
  }
}

const BASIS_LABEL: Record<string, string> = {
  raw: "raw",
  cooked: "cooked",
  dry: "dry",
  rehydrated: "rehydrated",
  none: "as sold",
};

/** "weighed as cooked" only when it says something the stored basis does not. */
export function weighedBasisLabel(
  gramsAs: string | null,
  foodState: string | null,
): string | null {
  if (gramsAs === null || gramsAs === "") return null;
  if (gramsAs === foodState) return null;
  return `weighed as ${BASIS_LABEL[gramsAs] ?? gramsAs}`;
}

export function basisLabel(state: string | null): string | null {
  if (state === null || state === "") return null;
  return BASIS_LABEL[state] ?? state;
}

const REVISION_REASONS: Record<string, string> = {
  serving_rescale: "Portion changed",
  food_history_refresh: "Nutrition corrected from the saved food",
  recipe_snapshot_recomputed: "Recipe entry totals recomputed",
};

/** Plain-language reason for an audit row; an unknown reason is shown verbatim, never guessed. */
export function revisionReasonLabel(reason: string): string {
  return REVISION_REASONS[reason] ?? reason;
}

/** How an ingredient amount was stated in the recipe: batch grams or one serving. */
export function amountBasisLabel(amountBasis: string | null): string | null {
  if (amountBasis === "batch") return "batch amount";
  if (amountBasis === "serving") return "one-serving amount";
  return null;
}
