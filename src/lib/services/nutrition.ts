import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { foodLog, foods, nutritionTargets } from "@/db/schema";
import { addDays, formatClock, isDay, localDay, localTimeMs } from "@/lib/day";
import { latestMeasurement } from "@/lib/services/measurements";
import { getProfile, getTimezone, suggestedTargets } from "@/lib/services/profile";
import { dayField, enumField, fail, idField, numField, str } from "@/lib/validate";

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type Meal = (typeof MEALS)[number];

export type Macros = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number;
  sodiumMg: number;
};

export type Targets = Macros & { effectiveFrom: string; source: "manual" | "suggested" };
export type Food = typeof foods.$inferSelect;
export type FoodEntry = typeof foodLog.$inferSelect;

const EMPTY: Macros = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, sodiumMg: 0 };

export function sumMacros(rows: Macros[]): Macros {
  return rows.reduce<Macros>(
    (a, r) => ({
      kcal: a.kcal + r.kcal,
      proteinG: a.proteinG + r.proteinG,
      carbsG: a.carbsG + r.carbsG,
      fatG: a.fatG + r.fatG,
      fibreG: a.fibreG + r.fibreG,
      sodiumMg: a.sodiumMg + r.sodiumMg,
    }),
    { ...EMPTY },
  );
}

/** Accepts the common aliases an agent or a form may send. */
function macrosOf(input: Record<string, unknown>, { required = false } = {}): Macros {
  const pick = (...names: string[]) => {
    for (const n of names) if (input[n] !== undefined && input[n] !== null && input[n] !== "") return input[n];
    return undefined;
  };
  const value = (names: string[], label: string, min = 0, max = 100_000) =>
    numField(pick(...names) ?? 0, label, { min, max }) ?? 0;
  const kcal = numField(pick("kcal", "calories"), "kcal", { required, min: 0, max: 100_000 }) ?? 0;
  return {
    kcal,
    proteinG: value(["proteinG", "protein"], "proteinG"),
    carbsG: value(["carbsG", "carbs", "carbohydrateG"], "carbsG"),
    fatG: value(["fatG", "fat"], "fatG"),
    fibreG: value(["fibreG", "fiberG", "fibre", "fiber"], "fibreG"),
    sodiumMg: value(["sodiumMg", "sodium"], "sodiumMg"),
  };
}

/** Only the fields the caller actually sent — a partial target update must not zero the rest. */
function providedMacros(input: Record<string, unknown>): Partial<Macros> {
  const fields: [keyof Macros, string[], number][] = [
    ["kcal", ["kcal", "calories"], 0],
    ["proteinG", ["proteinG", "protein"], 0],
    ["carbsG", ["carbsG", "carbs", "carbohydrateG"], 0],
    ["fatG", ["fatG", "fat"], 0],
    ["fibreG", ["fibreG", "fiberG", "fibre", "fiber"], 0],
    ["sodiumMg", ["sodiumMg", "sodium"], 0],
  ];
  const out: Partial<Macros> = {};
  for (const [key, names, min] of fields) {
    const name = names.find((n) => n in input && input[n] !== undefined && input[n] !== null && input[n] !== "");
    if (name !== undefined) {
      const value = numField(input[name], names[0], { min, max: 100_000 });
      if (value !== null) out[key] = value;
    }
  }
  return out;
}

function per100Macros(input: Record<string, unknown>): Macros {
  const nested = (input.per100g ?? input.per100 ?? {}) as Record<string, unknown>;
  return macrosOf({ ...input, ...nested }, { required: true });
}

/* ---------------------------------------------------------------------------------------------
 * Targets
 * ------------------------------------------------------------------------------------------- */

export function resolveTargets(day: string = localDay(Date.now(), getTimezone())): Targets {
  const rows = db
    .select()
    .from(nutritionTargets)
    .where(sql`${nutritionTargets.effectiveFrom} <= ${day}`)
    .orderBy(desc(nutritionTargets.effectiveFrom))
    .all();
  const profile = getProfile();
  const weight = latestMeasurement("weight")?.value ?? 75;
  const suggested = suggestedTargets(profile, weight);
  const newest = rows[0];

  // Effective-dated rows inherit any field they leave NULL from the newest earlier row that
  // has it, and then from the suggestion. A partial update therefore never zeroes the plan.
  const pick = (key: keyof Macros): number => {
    for (const row of rows) {
      const value = row[key];
      if (typeof value === "number") return value;
    }
    return suggested[key];
  };

  if (!newest) {
    return { ...suggested, effectiveFrom: day, source: "suggested" };
  }
  return {
    effectiveFrom: newest.effectiveFrom,
    source: "manual",
    kcal: pick("kcal"),
    proteinG: pick("proteinG"),
    carbsG: pick("carbsG"),
    fatG: pick("fatG"),
    fibreG: pick("fibreG"),
    sodiumMg: pick("sodiumMg"),
  };
}

export function setTargets(input: Record<string, unknown>): Targets {
  const day =
    input.effectiveFrom === undefined || input.effectiveFrom === null || input.effectiveFrom === ""
      ? localDay(Date.now(), getTimezone())
      : dayField(input.effectiveFrom, "effectiveFrom");
  const patch = providedMacros(input);
  if (Object.keys(patch).length === 0) fail("at least one target value is required (e.g. kcal)");

  const existing = db
    .select()
    .from(nutritionTargets)
    .where(eq(nutritionTargets.effectiveFrom, day))
    .get();
  const now = Date.now();

  if (existing) {
    db.update(nutritionTargets).set({ ...patch, updatedAtMs: now }).where(eq(nutritionTargets.id, existing.id)).run();
  } else {
    db.insert(nutritionTargets)
      .values({ effectiveFrom: day, ...patch, createdAtMs: now, updatedAtMs: now })
      .run();
  }
  return resolveTargets(day);
}

export function targetHistory(limit = 24) {
  return db
    .select()
    .from(nutritionTargets)
    .orderBy(desc(nutritionTargets.effectiveFrom))
    .limit(limit)
    .all();
}

/* ---------------------------------------------------------------------------------------------
 * Foods
 * ------------------------------------------------------------------------------------------- */

export function searchFoods(query: unknown, limit = 20): Food[] {
  const q = str(query, "query", { max: 120 });
  const capped = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 100) : 20;
  if (!q) return db.select().from(foods).orderBy(desc(foods.updatedAtMs)).limit(capped).all();
  const needle = `%${q.replace(/[%_]/g, "")}%`;
  return db
    .select()
    .from(foods)
    .where(or(like(foods.name, needle), like(foods.brand, needle)))
    .orderBy(desc(foods.updatedAtMs))
    .limit(capped)
    .all();
}

export function getFood(id: unknown): Food {
  const row = db.select().from(foods).where(eq(foods.id, idField(id))).get();
  if (!row) fail("food not found", 404);
  return row;
}

export function addFood(input: Record<string, unknown>): Food {
  const name = str(input.name, "name", { required: true, max: 200 })!;
  const brand = str(input.brand, "brand", { max: 200 });
  const m = per100Macros(input);
  const servingGrams = numField(input.servingGrams ?? 100, "servingGrams", { min: 1, max: 10_000 }) ?? 100;
  const now = Date.now();
  const existing = db
    .select()
    .from(foods)
    .where(and(eq(foods.name, name), brand === null ? sql`${foods.brand} IS NULL` : eq(foods.brand, brand)))
    .get();

  if (existing) {
    return db
      .update(foods)
      .set({
        servingGrams,
        kcalPer100g: m.kcal,
        proteinPer100g: m.proteinG,
        carbsPer100g: m.carbsG,
        fatPer100g: m.fatG,
        fibrePer100g: m.fibreG,
        sodiumPer100g: m.sodiumMg,
        barcode: str(input.barcode, "barcode", { max: 64 }),
        extraJson: input.extra === undefined ? existing.extraJson : JSON.stringify(input.extra),
        source: typeof input.source === "string" ? input.source : existing.source,
        updatedAtMs: now,
      })
      .where(eq(foods.id, existing.id))
      .returning()
      .get()!;
  }

  return db
    .insert(foods)
    .values({
      name,
      brand,
      barcode: str(input.barcode, "barcode", { max: 64 }),
      servingGrams,
      kcalPer100g: m.kcal,
      proteinPer100g: m.proteinG,
      carbsPer100g: m.carbsG,
      fatPer100g: m.fatG,
      fibrePer100g: m.fibreG,
      sodiumPer100g: m.sodiumMg,
      extraJson: input.extra === undefined ? null : JSON.stringify(input.extra),
      source: typeof input.source === "string" ? input.source : "manual",
      createdAtMs: now,
      updatedAtMs: now,
    })
    .returning()
    .get()!;
}

export function deleteFood(id: unknown): { deleted: boolean } {
  const foodId = idField(id);
  const used = sqlite.prepare("SELECT COUNT(*) AS c FROM food_log WHERE food_id = ?").get(foodId) as { c: number };
  if (used.c > 0) fail("food is used by logged meals; it cannot be deleted", 409);
  const row = db.delete(foods).where(eq(foods.id, foodId)).returning().get();
  return { deleted: Boolean(row) };
}

function entryMacros(entry: Record<string, unknown>): { name: string; grams: number; macros: Macros; foodId: number | null; estimated: boolean } {
  const grams = numField(entry.grams, "grams", { required: true, min: 0.1, max: 20_000 })!;
  const foodId = entry.foodId === undefined || entry.foodId === null ? null : idField(entry.foodId, "foodId");

  if (foodId !== null) {
    const food = getFood(foodId);
    const factor = grams / 100;
    return {
      name: food.name,
      grams,
      foodId,
      estimated: entry.estimated === true,
      macros: {
        kcal: food.kcalPer100g * factor,
        proteinG: food.proteinPer100g * factor,
        carbsG: food.carbsPer100g * factor,
        fatG: food.fatPer100g * factor,
        fibreG: food.fibrePer100g * factor,
        sodiumMg: food.sodiumPer100g * factor,
      },
    };
  }

  const name = str(entry.name, "name", { required: true, max: 200 })!;
  const hasPer100 = entry.per100g !== undefined || entry.per100 !== undefined;
  if (hasPer100) {
    const per100 = per100Macros(entry);
    const factor = grams / 100;
    return {
      name,
      grams,
      foodId: null,
      estimated: entry.estimated !== false, // per-100 g hand entries are estimates unless stated
      macros: {
        kcal: per100.kcal * factor,
        proteinG: per100.proteinG * factor,
        carbsG: per100.carbsG * factor,
        fatG: per100.fatG * factor,
        fibreG: per100.fibreG * factor,
        sodiumMg: per100.sodiumMg * factor,
      },
    };
  }
  return {
    name,
    grams,
    foodId: null,
    // Hand-entered macros are eyeballed unless the caller explicitly says otherwise.
    estimated: entry.estimated !== false,
    macros: macrosOf(entry, { required: true }),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Food log
 * ------------------------------------------------------------------------------------------- */

export function logMeal(input: Record<string, unknown>): { day: string; meal: Meal; entries: FoodEntry[] } {
  const tz = getTimezone();
  const today = localDay(Date.now(), tz);
  const day =
    input.day === undefined || input.day === null || input.day === ""
      ? today
      : dayField(input.day, "day");
  const meal = enumField(input.meal, "meal", MEALS)!;
  const rawEntries = input.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) fail("entries must be a non-empty array");
  if (rawEntries.length > 100) fail("at most 100 entries per call");

  const now = Date.now();
  const baseTime =
    day === today ? now : localTimeMs(day, "12:00", tz);
  const values = rawEntries.map((raw, i) => {
    if (!raw || typeof raw !== "object") fail("each entry must be an object");
    const entry = raw as Record<string, unknown>;
    const { name, grams, macros, foodId, estimated } = entryMacros(entry);
    return {
      day,
      meal,
      eatenAtMs: baseTime + i,
      foodId,
      name,
      grams,
      ...macros,
      estimated: estimated ? 1 : 0,
      note: str(entry.note, "note", { max: 1000 }),
      createdAtMs: now,
      updatedAtMs: now,
    };
  });

  // One transaction: a partially inserted meal must never be committed (an agent retry would
  // duplicate the rows that did land).
  const insertAll = sqlite.transaction((rows: (typeof values)[number][]) => {
    const out: FoodEntry[] = [];
    for (const value of rows) {
      // The unique key is (day, meal, eaten_at_ms, name). Two identical quick-adds in one call
      // would collide, so nudge the timestamp instead of silently dropping the second one.
      let attempt = 0;
      for (;;) {
        try {
          const row = db
            .insert(foodLog)
            .values({ ...value, eatenAtMs: value.eatenAtMs + attempt * 1000 })
            .returning()
            .get();
          if (row) out.push(row);
          break;
        } catch (e) {
          const unique = e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
          if (!unique || attempt >= 5) throw e;
          attempt += 1;
        }
      }
    }
    return out;
  });

  return { day, meal, entries: insertAll(values) };
}

export function updateEntry(id: unknown, input: Record<string, unknown>): FoodEntry {
  const entryId = idField(id);
  const existing = db.select().from(foodLog).where(eq(foodLog.id, entryId)).get();
  if (!existing) fail("meal entry not found", 404);

  const patch: Partial<typeof foodLog.$inferInsert> = { updatedAtMs: Date.now() };
  if ("meal" in input) patch.meal = enumField(input.meal, "meal", MEALS)!;
  if ("name" in input) patch.name = str(input.name, "name", { required: true, max: 200 })!;
  if ("note" in input) patch.note = str(input.note, "note", { max: 1000 });
  if ("estimated" in input) patch.estimated = input.estimated ? 1 : 0;

  const hasMacros = ["kcal", "calories", "proteinG", "protein", "carbsG", "carbs", "fatG", "fat"].some((k) => k in input);
  if ("grams" in input || hasMacros) {
    const grams = numField(input.grams ?? existing.grams, "grams", { required: true, min: 0.1, max: 20_000 })!;
    if (hasMacros) {
      const pick = (names: string[], fallback: number) => {
        const key = names.find((n) => n in input);
        return key === undefined ? fallback : numField(input[key], names[0], { min: 0 }) ?? fallback;
      };
      patch.grams = grams;
      patch.kcal = pick(["kcal", "calories"], existing.kcal);
      patch.proteinG = pick(["proteinG", "protein"], existing.proteinG);
      patch.carbsG = pick(["carbsG", "carbs"], existing.carbsG);
      patch.fatG = pick(["fatG", "fat"], existing.fatG);
      patch.fibreG = pick(["fibreG", "fiberG", "fibre", "fiber"], existing.fibreG);
      patch.sodiumMg = pick(["sodiumMg", "sodium"], existing.sodiumMg);
    } else {
      // Proportional edit: only grams changed, so scale the snapshot rather than asking again.
      const factor = grams / existing.grams;
      patch.grams = grams;
      patch.kcal = existing.kcal * factor;
      patch.proteinG = existing.proteinG * factor;
      patch.carbsG = existing.carbsG * factor;
      patch.fatG = existing.fatG * factor;
      patch.fibreG = existing.fibreG * factor;
      patch.sodiumMg = existing.sodiumMg * factor;
    }
  }

  return db.update(foodLog).set(patch).where(eq(foodLog.id, entryId)).returning().get()!;
}

export function deleteEntry(id: unknown): { deleted: boolean } {
  const row = db.delete(foodLog).where(eq(foodLog.id, idField(id))).returning().get();
  if (!row) fail("meal entry not found", 404);
  return { deleted: true };
}

export type DayNutrition = {
  day: string;
  timezone: string;
  targets: Targets;
  entries: FoodEntry[];
  meals: Record<Meal, FoodEntry[]>;
  totals: Macros;
  remaining: Macros;
  progress: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  estimatedEntries: number;
};

export function dayNutrition(day: string = localDay(Date.now(), getTimezone())): DayNutrition {
  const tz = getTimezone();
  if (!isDay(day)) fail("day must be YYYY-MM-DD");
  const entries = db
    .select()
    .from(foodLog)
    .where(eq(foodLog.day, day))
    .orderBy(foodLog.eatenAtMs)
    .all();
  const targets = resolveTargets(day);
  const totals = sumMacros(entries);
  const meals = {
    breakfast: entries.filter((e) => e.meal === "breakfast"),
    lunch: entries.filter((e) => e.meal === "lunch"),
    dinner: entries.filter((e) => e.meal === "dinner"),
    snack: entries.filter((e) => e.meal === "snack"),
  };
  const pct = (value: number, target: number) => (target > 0 ? (value / target) * 100 : 0);
  return {
    day,
    timezone: tz,
    targets,
    entries,
    meals,
    totals,
    remaining: {
      kcal: Math.round((targets.kcal - totals.kcal) * 100) / 100,
      proteinG: Math.round((targets.proteinG - totals.proteinG) * 100) / 100,
      carbsG: Math.round((targets.carbsG - totals.carbsG) * 100) / 100,
      fatG: Math.round((targets.fatG - totals.fatG) * 100) / 100,
      fibreG: Math.round((targets.fibreG - totals.fibreG) * 100) / 100,
      sodiumMg: Math.round((targets.sodiumMg - totals.sodiumMg) * 100) / 100,
    },
    progress: {
      kcal: pct(totals.kcal, targets.kcal),
      proteinG: pct(totals.proteinG, targets.proteinG),
      carbsG: pct(totals.carbsG, targets.carbsG),
      fatG: pct(totals.fatG, targets.fatG),
    },
    estimatedEntries: entries.filter((e) => e.estimated === 1).length,
  };
}

export type NutritionDayTotals = Macros & {
  day: string;
  entries: number;
  targetKcal: number;
};

export function nutritionRange(days = 7, endDay?: string): NutritionDayTotals[] {
  const tz = getTimezone();
  const end = endDay === undefined || endDay === "" ? localDay(Date.now(), tz) : dayField(endDay, "endDay");
  const capped = Number.isFinite(days) && days >= 1 ? Math.min(Math.trunc(days), 366) : 7;
  const start = addDays(end, -(capped - 1));
  const rows = sqlite
    .prepare(
      `SELECT day, COUNT(*) AS entries, SUM(kcal) AS kcal, SUM(protein_g) AS proteinG,
              SUM(carbs_g) AS carbsG, SUM(fat_g) AS fatG, SUM(fibre_g) AS fibreG, SUM(sodium_mg) AS sodiumMg
       FROM food_log WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`,
    )
    .all(start, end) as (Macros & { day: string; entries: number })[];
  return rows.map((r) => ({ ...r, targetKcal: resolveTargets(r.day).kcal }));
}

/** Recent distinct foods eaten, for the quick-add list. */
export function recentFoods(limit = 12): { name: string; foodId: number | null; grams: number; kcal: number }[] {
  const capped = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 50) : 12;
  return sqlite
    .prepare(
      `SELECT name, food_id AS foodId, grams, kcal FROM food_log
       WHERE id IN (SELECT MAX(id) FROM food_log GROUP BY name)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(capped) as { name: string; foodId: number | null; grams: number; kcal: number }[];
}

/** Duplicate a day's entries onto `toDay`; existing rows are left alone. */
export function copyDay(fromDay: string, toDay: string): { copied: number; toDay: string } {
  if (!isDay(fromDay) || !isDay(toDay)) fail("fromDay and toDay must be YYYY-MM-DD");
  if (fromDay === toDay) fail("fromDay and toDay must differ");
  const tz = getTimezone();
  const source = db.select().from(foodLog).where(eq(foodLog.day, fromDay)).orderBy(foodLog.eatenAtMs).all();
  if (source.length === 0) fail(`no food logged on ${fromDay}`, 404);

  const now = Date.now();
  const insertAll = sqlite.transaction(() => {
    let copied = 0;
    for (const [index, entry] of source.entries()) {
      // Keep the wall-clock time of the source entry but move it to the target day. The
      // millisecond offset keeps same-minute entries distinct under the unique key.
      const hh = formatClock(entry.eatenAtMs, tz);
      const eatenAtMs = localTimeMs(toDay, hh, tz) + index;
      try {
        db.insert(foodLog)
          .values({
            day: toDay,
            meal: entry.meal,
            eatenAtMs,
            foodId: entry.foodId,
            name: entry.name,
            grams: entry.grams,
            kcal: entry.kcal,
            proteinG: entry.proteinG,
            carbsG: entry.carbsG,
            fatG: entry.fatG,
            fibreG: entry.fibreG,
            sodiumMg: entry.sodiumMg,
            estimated: entry.estimated,
            note: entry.note,
            createdAtMs: now,
            updatedAtMs: now,
          })
          .run();
        copied += 1;
      } catch (e) {
        // Only "already copied" is expected. Anything else must abort the whole copy.
        if (!(e instanceof Error) || !/UNIQUE constraint failed/i.test(e.message)) throw e;
      }
    }
    return copied;
  });

  return { copied: insertAll(), toDay };
}
