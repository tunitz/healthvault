/**
 * Explicit, opt-in food templates for standard household measures and cooking yield factors.
 *
 * These are deliberately *not* applied by name inference: a saved food whose name merely looks
 * like "honey" may be a different product, and silently rewriting its measures would corrupt
 * every future entry that resolves through it. A caller lists these templates and applies one to
 * a specific food id (or reads the values straight out of this catalogue). Applying is editable
 * afterwards through `food_add`.
 *
 * Nothing here stores nutrition values: a template only carries physical facts (grams per
 * household unit, and the weight conversion for raw/dry foods), never invented macros.
 */
import { fail } from "@/lib/validate";

export type TemplateState = "raw" | "cooked" | "dry" | "rehydrated" | "none";

export type FoodTemplate = {
  /** Stable id a caller passes to `food_template_apply`. */
  slug: string;
  label: string;
  description: string;
  /** The basis the food's per-100 g values must already be in. */
  state?: TemplateState;
  /** Cooked g per raw g (raw foods) or cooked g per dry g (dry foods). */
  yieldFactor?: number;
  /** Grams per household unit, e.g. { tsp: 18 }. */
  measures?: Record<string, number>;
};

export type TemplateDefaults = {
  state: TemplateState;
  yieldFactor: number;
  measures: Record<string, number>;
};

/** Fixed catalogue of editable household measure defaults and yield factors. */
const TEMPLATES: readonly FoodTemplate[] = [
  {
    slug: "honey",
    label: "Honey",
    description: "1 kutsarita = 7 g; 1 tbsp = 21 g (household default).",
    measures: { kutsarita: 7, tbsp: 21 },
  },
  {
    slug: "nescafe-gold",
    label: "NESCAFÉ Gold instant coffee",
    description: "1 rounded tbsp = 6 g; 1 tsp = 1.8 g (household default).",
    measures: { tbsp: 6, tsp: 1.8 },
  },
  {
    slug: "jumbo-egg",
    label: "Jumbo egg",
    description: "1 piece = 60 g (household default).",
    measures: { piece: 60 },
  },
  {
    slug: "kfc-fry",
    label: "KFC fry strip",
    description: "1 strip = 2 g (household default).",
    measures: { strip: 2 },
  },
  {
    slug: "active-whey",
    label: "Active whey",
    description: "1 scoop = 32.4 g (household default).",
    measures: { scoop: 32.4 },
  },
  {
    slug: "chicken-breast-skinless",
    label: "Skinless chicken breast",
    description: "Cooked yield 0.75 g per raw g; per-100 g values must be raw.",
    state: "raw",
    yieldFactor: 0.75,
  },
  {
    slug: "chicken-thigh-skinless",
    label: "Skinless chicken thigh",
    description: "Cooked yield 0.70 g per raw g; per-100 g values must be raw.",
    state: "raw",
    yieldFactor: 0.7,
  },
  {
    slug: "ground-beef",
    label: "Ground beef",
    description: "Cooked yield 0.70 g per raw g; per-100 g values must be raw.",
    state: "raw",
    yieldFactor: 0.7,
  },
  {
    slug: "white-rice-dry",
    label: "White rice (dry)",
    description: "Cooked yield 2.3 g per dry g; per-100 g values must be dry.",
    state: "dry",
    yieldFactor: 2.3,
  },
  {
    slug: "dried-pulses-dry",
    label: "Dried pulses (dry)",
    description: "Cooked yield 2.4 g per dry g; per-100 g values must be dry.",
    state: "dry",
    yieldFactor: 2.4,
  },
  {
    slug: "pasta-dry",
    label: "Pasta (dry)",
    description: "Cooked yield 1.8 g per dry g; per-100 g values must be dry.",
    state: "dry",
    yieldFactor: 1.8,
  },
  {
    slug: "oats-dry",
    label: "Oats (dry)",
    description: "Cooked yield 2.3 g per dry g; per-100 g values must be dry.",
    state: "dry",
    yieldFactor: 2.3,
  },
];

export function listFoodTemplates(): FoodTemplate[] {
  return TEMPLATES.map((template) => ({ ...template, measures: template.measures ? { ...template.measures } : undefined }));
}

/** Exact slug lookup (trimmed, case-insensitive); never a fuzzy name match. */
export function findFoodTemplate(value: unknown): FoodTemplate {
  if (typeof value !== "string" || value.trim() === "") {
    fail(
      `template is required; available: ${TEMPLATES.map((template) => template.slug).join(", ")}`,
    );
  }
  const slug = value.trim().toLowerCase();
  const found = TEMPLATES.find((template) => template.slug === slug);
  if (!found) {
    fail(`unknown food template "${slug}"; available: ${TEMPLATES.map((template) => template.slug).join(", ")}`, 404);
  }
  return found;
}

function existingMeasures(measuresJson: string | null | undefined): Record<string, number> {
  if (!measuresJson) return {};
  try {
    const parsed = JSON.parse(measuresJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && value > 0) out[key.trim().toLowerCase()] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * True when applying this template would reinterpret the food's per-100 g values (a different
 * stated basis). A caller must pass `overwrite` to acknowledge that the values are already on
 * the new basis.
 */
export function templateChangesBasis(existing: { state: string }, template: FoodTemplate): boolean {
  return template.state !== undefined && template.state !== existing.state;
}

/**
 * Merge a template into an existing food definition.
 *
 * Default behaviour is non-destructive: a per-unit override the user already set wins, and a
 * custom state/yield factor is kept. `overwrite` replaces both. The template never touches the
 * food's name or per-100 g nutrition.
 */
export function applyTemplateDefaults(
  existing: { state: string; yieldFactor: number; measuresJson: string | null } | undefined,
  template: FoodTemplate,
  overwrite = false,
): TemplateDefaults {
  const measures = existing ? existingMeasures(existing.measuresJson) : {};
  for (const [name, grams] of Object.entries(template.measures ?? {})) {
    if (overwrite || measures[name] === undefined) measures[name] = grams;
  }

  const customBasis = existing !== undefined && !(existing.state === "raw" && existing.yieldFactor === 1);
  const maySetBasis = overwrite || !customBasis;
  return {
    state:
      template.state !== undefined && maySetBasis ? template.state : ((existing?.state ?? "raw") as TemplateState),
    yieldFactor:
      template.yieldFactor !== undefined && maySetBasis
        ? template.yieldFactor
        : existing?.yieldFactor ?? 1,
    measures,
  };
}
