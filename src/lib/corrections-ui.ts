/**
 * Pure helpers for the past-meal correction screen (`/nutrition/corrections`).
 *
 * The correction arithmetic and the scope rules live in `src/lib/services/food-history.ts`;
 * nothing here decides what changes. These helpers only describe a preview the service already
 * produced, so the screen cannot drift from what `applyHistoryRefresh` will do:
 *
 *  - plain-language reasons for skipped rows (the service's own reason codes),
 *  - day/meal grouping for the change list,
 *  - before -> after values for the macro row.
 */
import type { HistoryChange, HistoryScope, SnapshotValues } from "@/lib/services/food-history";

/** The service's skip codes, in the user's words. A new code is shown verbatim, never guessed. */
const SKIP_REASONS: Record<string, string> = {
  food_missing: "The saved food no longer exists, so there is nothing to copy from.",
  basis_unknown: "The entry does not record which basis (raw/cooked) its values used.",
  basis_changed: "The saved food's basis changed since this entry was logged.",
  yield_changed: "The saved food's yield factor changed since this entry was logged.",
  unresolved_ingredient: "This ingredient was never linked to a saved food.",
  aggregate_snapshot_without_ingredients: "This older entry has no recorded ingredients.",
};

export function skipReasonLabel(reason: string | null): string {
  if (reason === null || reason === "") return "Skipped";
  return SKIP_REASONS[reason] ?? reason;
}

export type ChangeGroup = {
  day: string;
  meal: string;
  changes: HistoryChange[];
};

const MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack"];

/** Group a preview's rows by day, then meal, keeping the service's order inside a group. */
export function groupChanges(changes: HistoryChange[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const change of changes) {
    const key = `${change.day}\u0000${change.meal}`;
    let group = groups.get(key);
    if (!group) {
      group = { day: change.day, meal: change.meal, changes: [] };
      groups.set(key, group);
    }
    group.changes.push(change);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return MEAL_ORDER.indexOf(a.meal) - MEAL_ORDER.indexOf(b.meal);
  });
}

export type MacroDelta = { label: string; from: number; to: number; digits: number; unit: string };

const MACRO_FIELDS: { key: keyof SnapshotValues; label: string; digits: number; unit: string }[] = [
  { key: "kcal", label: "kcal", digits: 0, unit: "" },
  { key: "proteinG", label: "protein", digits: 1, unit: "g" },
  { key: "carbsG", label: "carbs", digits: 1, unit: "g" },
  { key: "fatG", label: "fat", digits: 1, unit: "g" },
  { key: "fibreG", label: "fibre", digits: 1, unit: "g" },
  { key: "sodiumMg", label: "sodium", digits: 0, unit: "mg" },
];

/** Only the fields that actually differ, so a preview row shows the change, not six lines. */
export function macroDeltas(
  previous: SnapshotValues | null,
  proposed: SnapshotValues | null,
  epsilon = 1e-6,
): MacroDelta[] {
  if (!previous || !proposed) return [];
  return MACRO_FIELDS.filter(
    (field) => Math.abs(Number(previous[field.key]) - Number(proposed[field.key])) > epsilon,
  ).map((field) => ({
    label: field.label,
    from: Number(previous[field.key]),
    to: Number(proposed[field.key]),
    digits: field.digits,
    unit: field.unit,
  }));
}

/**
 * The exact scope being previewed, as one sentence. The apply confirmation repeats this text so
 * the user confirms a named scope rather than a vague "apply".
 */
export function scopeDescription(scope: HistoryScope, foodName: string | null): string {
  const parts: string[] = [];
  if (scope.foodIds.length > 0) {
    const foods =
      scope.foodIds.length === 1 && foodName !== null
        ? foodName
        : scope.foodIds.map((id) => `food #${id}`).join(", ");
    parts.push(`meals logged from ${foods}`);
  }
  if (scope.entryIds.length > 0) {
    parts.push(
      scope.entryIds.length === 1
        ? `entry ${scope.entryIds[0]}`
        : `${scope.entryIds.length} selected entries (${scope.entryIds.join(", ")})`,
    );
  }
  if (scope.fromDay !== null && scope.toDay !== null) {
    parts.push(`${scope.fromDay} to ${scope.toDay}`);
  } else if (scope.fromDay !== null) {
    parts.push(`on or after ${scope.fromDay}`);
  } else if (scope.toDay !== null) {
    parts.push(`on or before ${scope.toDay}`);
  } else {
    parts.push("all logged days");
  }
  return parts.join(" · ");
}

export type ScopeCounts = {
  changed: number;
  unchanged: number;
  skipped: number;
};

/** The counts line, stated exactly as the preview counted them. */
export function changeSummary(counts: ScopeCounts): string {
  const parts = [`${counts.changed} to correct`];
  if (counts.unchanged > 0) parts.push(`${counts.unchanged} already up to date`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return parts.join(" · ");
}

/**
 * True when applying this scope would write nothing. Applying an empty change set is harmless,
 * but the screen should say so instead of offering a pointless confirmation.
 */
export function nothingToApply(preview: { changed: number }): boolean {
  return preview.changed === 0;
}

/** A stale preview must be re-run, never re-applied; the service enforces this with a 409. */
export function isStalePreviewError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /stale/i.test(message) && /preview/i.test(message);
}

/**
 * True when the service refused the scope for size. The service's own message already names the
 * limit, so the screen adds the action to take rather than replacing the reason.
 */
export function scopeTooLarge(message: string | null | undefined): boolean {
  if (!message) return false;
  return /narrow/i.test(message);
}
