/**
 * Token-efficient shaping and consistent numeric rounding for agent/MCP responses.
 *
 * The underlying TypeScript service layer keeps its full shapes for UI pages and internal
 * callers; this module compacts and rounds the JSON sent over `/api/agent/*` and `/api/mcp`:
 *  - Drops redundant raw `*Json` columns when parsed objects are already present
 *  - Avoids duplicating full 29-column ingredient snapshots in both `entries` and `meals`
 *  - Avoids repeating the shared default household measures on every `food_search` row
 *  - Avoids triplicating the full `supplement` row across `supplements`, `checklist`, and `nextSupplement`
 *  - Rounds floating-point aggregates consistently (never emitting 15-digit IEEE-754 mantissas)
 */
import type { HealthContext } from "@/lib/services/context";
import { measureDefaults } from "@/lib/services/measures";
import type { DayNutrition, FoodWithMeasures, Meal } from "@/lib/services/nutrition";
import type { LoggedIngredientEntry } from "@/lib/services/food-log-snapshots";
import type { ChecklistItem, NextSupplement, Supplement, todayChecklist } from "@/lib/services/supplements";
import { sanitizeAgentNumbers } from "@/lib/round";

type Checklist = ReturnType<typeof todayChecklist>;

function compactIngredient(entry: LoggedIngredientEntry, includeIngredients: boolean) {
  if (!entry.ingredients || entry.ingredients.length === 0) {
    const { ingredients: _ing, ...rest } = entry;
    void _ing;
    return rest;
  }
  if (includeIngredients) return entry;
  return {
    ...entry,
    ingredients: entry.ingredients.map((i) => ({
      id: i.id,
      foodId: i.foodId,
      name: i.name,
      grams: i.grams,
      kcal: i.kcal,
      proteinG: i.proteinG,
      carbsG: i.carbsG,
      fatG: i.fatG,
      resolved: i.resolved === 1,
    })),
  };
}

/** Deduplicate `dayNutrition` for agent output: keep grouped `meals` + `entryCount`, omit duplicate `entries`. */
export function compactDayNutrition(
  data: DayNutrition,
  options: { includeIngredients?: boolean } = {},
) {
  const includeIngredients = options.includeIngredients === true;
  const meals: Record<Meal, ReturnType<typeof compactIngredient>[]> = {
    breakfast: data.meals.breakfast.map((e) => compactIngredient(e, includeIngredients)),
    lunch: data.meals.lunch.map((e) => compactIngredient(e, includeIngredients)),
    dinner: data.meals.dinner.map((e) => compactIngredient(e, includeIngredients)),
    snack: data.meals.snack.map((e) => compactIngredient(e, includeIngredients)),
  };
  return sanitizeAgentNumbers({
    day: data.day,
    timezone: data.timezone,
    targets: data.targets,
    entryCount: data.entries.length,
    meals,
    totals: data.totals,
    remaining: data.remaining,
    progress: data.progress,
    estimatedEntries: data.estimatedEntries,
    estimatedKcal: data.estimatedKcal,
    estimatedKcalShare: data.estimatedKcalShare,
  });
}

/** Trim raw `*Json` columns from profile objects when parsed equivalents are present. */
export function compactProfile<T extends { workScheduleJson?: unknown; goalJson?: unknown; wheyLinkJson?: unknown }>(
  profile: T,
  includeRawJson = false,
) {
  if (includeRawJson) return sanitizeAgentNumbers(profile);
  const { workScheduleJson: _ws, goalJson: _g, wheyLinkJson: _wl, ...rest } = profile;
  void _ws;
  void _g;
  void _wl;
  return sanitizeAgentNumbers(rest);
}

/** Omit shared default household measures unless overridden on the food row. */
export function compactFoodSearch(rows: FoodWithMeasures[]) {
  const defaults = measureDefaults();
  return sanitizeAgentNumbers(
    rows.map((row) => {
      const { measuresJson: _mj, extraJson, measures, ...rest } = row;
      void _mj;
      const customMeasures: Record<string, number> = {};
      for (const [k, v] of Object.entries(measures)) {
        if (defaults[k] !== v) customMeasures[k] = v;
      }
      return {
        ...rest,
        ...(extraJson ? { extraJson } : {}),
        ...(Object.keys(customMeasures).length > 0 ? { measures: customMeasures } : {}),
      };
    }),
  );
}

function compactChecklistItem(item: ChecklistItem) {
  return {
    supplementId: item.supplement.id,
    name: item.supplement.name,
    dose: item.supplement.dose,
    unit: item.supplement.unit,
    schedule: item.schedule,
    logged: item.logged,
    log: item.log,
  };
}

export function compactChecklist(checklist: Checklist) {
  return sanitizeAgentNumbers({
    day: checklist.day,
    taken: checklist.taken,
    total: checklist.total,
    items: checklist.items.map(compactChecklistItem),
  });
}

export function compactNextSupplement(next: NextSupplement | null) {
  if (!next) return null;
  return sanitizeAgentNumbers({
    supplementId: next.supplement.id,
    name: next.supplement.name,
    dose: next.supplement.dose,
    unit: next.supplement.unit,
    schedule: next.schedule,
    due: next.due,
    dueAtMs: next.dueAtMs,
  });
}

export function compactSupplementList(data: { supplements: Supplement[]; checklist: Checklist }) {
  return sanitizeAgentNumbers({
    supplements: data.supplements,
    checklist: compactChecklist(data.checklist),
  });
}

export function compactAgentContext(
  ctx: Partial<HealthContext>,
  options: { includeRawJson?: boolean; includeIngredients?: boolean } = {},
) {
  const out: Record<string, unknown> = { ...ctx };
  if (ctx.profile) {
    out.profile = compactProfile(ctx.profile, options.includeRawJson === true);
  }
  if (ctx.nutrition) {
    out.nutrition = compactDayNutrition(ctx.nutrition, {
      includeIngredients: options.includeIngredients === true,
    });
  }
  if (ctx.supplements) {
    out.supplements = compactChecklist(ctx.supplements);
  }
  if ("nextSupplement" in ctx) {
    out.nextSupplement = compactNextSupplement(ctx.nextSupplement ?? null);
  }
  return sanitizeAgentNumbers(out);
}
