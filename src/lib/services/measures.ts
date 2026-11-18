import { sql } from "drizzle-orm";
import { db } from "@/db";
import { measures } from "@/db/schema";
import { fail, numField, str } from "@/lib/validate";

/**
 * Household measures (tbsp, tsp, kutsarita, piece, scoop, strip).
 *
 * Grams resolve as `count × (per-food override ?? measure default)`: bulk density differs per
 * product, so a tbsp of honey is 21 g while a tbsp of instant coffee is 6 g. A unit with no
 * universal mass (piece, scoop, strip) must be overridden on the food or logged in grams.
 */

export type MeasureInput = { name: string; count: number };

/** A positive grams-per-unit override map keyed by lower-case measure name. */
export type MeasuresMap = Record<string, number>;

/**
 * Volume-only units have no universal mass. Never resolve them by assuming water density
 * (1 ml = 1 g) — only a verified per-food grams-per-unit override may do that, and grams are
 * always accepted. Kept as an explicit set so a future row in `measures` cannot reintroduce
 * the assumption by accident.
 */
const VOLUME_ONLY_UNITS = new Set([
  "ml",
  "l",
  "liter",
  "litre",
  "fl oz",
  "floz",
  "fluid ounce",
  "gallon",
  "pint",
  "quart",
]);

export function parseMeasure(value: unknown, label = "measure"): MeasureInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object like { name, count }`);
  }
  const raw = value as Record<string, unknown>;
  const name = str(raw.name, `${label}.name`, { required: true, max: 40 })!.toLowerCase();
  const count = numField(raw.count, `${label}.count`, { required: true, min: 0.01, max: 10_000 })!;
  return { name, count };
}

/** Accepts an object or JSON string and returns a validated, lower-case-keyed map. */
export function measuresMap(value: unknown, label = "measures"): MeasuresMap | null {
  if (value === null || value === undefined || value === "") return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      fail(`${label} must be valid JSON`);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be an object`);
  const out: MeasuresMap = {};
  for (const [key, grams] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim().toLowerCase();
    if (!name || name.length > 40) fail(`${label} keys must be measure names (max 40 characters)`);
    const value = numField(grams, `${label}.${name}`, { required: true, min: 0.01, max: 100_000 })!;
    out[name] = value;
  }
  return out;
}

export function foodMeasureOverrides(measuresJson: string | null | undefined): MeasuresMap {
  if (!measuresJson) return {};
  try {
    return measuresMap(measuresJson, "food measures") ?? {};
  } catch {
    // A malformed stored override must not make food_search fail; resolveMeasureGrams falls
    // back to the shared defaults, and addFood validates before writing.
    return {};
  }
}

/**
 * Resolve `measure: { name, count }` to grams for one food.
 * `foodMeasuresJson` is the food's override map; null for an inline (food-less) entry.
 */
export function resolveMeasureGrams(
  measure: unknown,
  foodMeasuresJson: string | null | undefined,
  label = "measure",
): MeasureInput & { grams: number; source: "food" | "default" } {
  const { name, count } = parseMeasure(measure, label);
  const override = foodMeasureOverrides(foodMeasuresJson)[name];
  if (typeof override === "number") {
    return { name, count, grams: cappedGrams(count * override, name, label), source: "food" };
  }
  if (VOLUME_ONLY_UNITS.has(name)) {
    fail(
      `measure "${name}" has no verified mass for this food; configure a grams-per-${name} value on the food or use grams (never assumes 1 ml = 1 g)`,
      400,
    );
  }
  const row = db
    .select()
    .from(measures)
    .where(sql`lower(${measures.name}) = ${name}`)
    .get();
  if (row && typeof row.gramsDefault === "number" && row.gramsDefault > 0) {
    return {
      name,
      count,
      grams: cappedGrams(count * row.gramsDefault, name, label),
      source: "default",
    };
  }
  fail(
    `measure "${name}" has no gram default; set it on the food (measures) or send grams`,
    400,
  );
}

/** A measure must resolve to a loggable portion, not an accidental 500 kg of honey. */
function cappedGrams(grams: number, name: string, label: string): number {
  if (!Number.isFinite(grams) || grams <= 0) fail(`${label}: ${name} resolves to an invalid weight`);
  if (grams > 20_000) {
    fail(`${label}: ${name} resolves to ${grams} g; use grams (max 20000 g per entry)`);
  }
  return grams;
}

/** Shared defaults only (units with a universal mass). */
export function measureDefaults(): MeasuresMap {
  const out: MeasuresMap = {};
  for (const row of db.select().from(measures).all()) {
    if (typeof row.gramsDefault === "number" && row.gramsDefault > 0) {
      out[row.name.toLowerCase()] = row.gramsDefault;
    }
  }
  return out;
}

/** Effective grams-per-unit map for a food: shared defaults with per-food overrides applied. */
export function effectiveMeasures(
  measuresJson: string | null | undefined,
  defaults: MeasuresMap = measureDefaults(),
): MeasuresMap {
  return { ...defaults, ...foodMeasureOverrides(measuresJson) };
}

export function listMeasures() {
  return db.select().from(measures).orderBy(measures.name).all();
}
