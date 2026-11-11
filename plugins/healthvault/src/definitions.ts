/**
 * Tool definitions for the HealthVault MCP server.
 *
 * Names are the same model-facing names the OpenCode plugin exposes
 * (`healthvault_<tool>`). `run` talks to the typed client only, so this module
 * stays independent of the MCP SDK and can be exercised without a transport.
 */

import type {
  CopyDayInput,
  FoodAddInput,
  FoodDeleteInput,
  FoodHistoryPreviewInput,
  FoodHistoryRefreshInput,
  FoodSearchInput,
  FoodTemplateApplyInput,
  HealthVaultClient,
  MealDeleteInput,
  MealGetInput,
  MealLogInput,
  MealUpdateInput,
  MeasurementAddInput,
  MeasurementDeleteInput,
  MeasurementHistoryInput,
  MetricsSeriesInput,
  NutritionDayInput,
  NutritionSummaryInput,
  NutritionTargetSetInput,
  ProfileUpdateInput,
  RecipeCreateInput,
  RecipeDeleteInput,
  RecipeGetInput,
  RecipeLogInput,
  RecipeUpdateInput,
  RecordsRecentInput,
  SupplementCreateInput,
  SupplementDeleteInput,
  SupplementHistoryInput,
  SupplementLogInput,
  SupplementUpdateInput,
  UploadsRecentInput,
  WorkoutsRecentInput,
} from "./client";

export const TOOL_NAMESPACE = "healthvault";

/** MCP tool annotations, kept as plain data so this file needs no SDK import. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: ToolAnnotations;
  run(input: unknown, signal: AbortSignal): Promise<unknown>;
}

const DAY_SCHEMA = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description:
    "Local calendar day (YYYY-MM-DD). Defaults to today in the profile timezone.",
};

const KIND_SCHEMA = {
  type: "string",
  enum: ["weight", "bodyFat", "waist"],
};

const MEAL_SCHEMA = {
  type: "string",
  enum: ["breakfast", "lunch", "dinner", "snack"],
};

const MACROS_PER_100G_SCHEMA = {
  type: "object",
  properties: {
    kcal: { type: "number", minimum: 0 },
    proteinG: { type: "number", minimum: 0 },
    carbsG: { type: "number", minimum: 0 },
    fatG: { type: "number", minimum: 0 },
    fibreG: { type: "number", minimum: 0 },
    sodiumMg: { type: "number", minimum: 0 },
  },
  required: ["kcal"],
  additionalProperties: false,
};

const MEASURE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 40 },
    count: { type: "number", minimum: 0.01 },
  },
  required: ["name", "count"],
  additionalProperties: false,
};

const PROVENANCE_PROPS = {
  gramsAs: { type: "string", enum: ["raw", "cooked"] },
  state: { type: "string", enum: ["raw", "cooked", "dry", "rehydrated", "none"] },
  weightSource: { type: "string", enum: ["weighed", "counted", "guessed"] },
  macroSource: { type: "string", enum: ["label", "usda", "recipe", "estimated"] },
};

const INGREDIENT_OVERRIDE_SCHEMA = {
  type: "object",
  properties: {
    ingredientId: {
      type: "integer",
      minimum: 1,
      description:
        "Recipe ingredient id from recipe_get. Preferred when the same food appears twice.",
    },
    foodId: { type: "integer", minimum: 1 },
    grams: {
      type: "number",
      minimum: 0.1,
      description:
        "Amount in the units named by amountBasis: batch grams or one-serving grams. Use grams or measure, never both.",
    },
    measure: MEASURE_SCHEMA,
    gramsAs: { type: "string", enum: ["raw", "cooked"] },
  },
  description: "At least one of ingredientId or foodId is required.",
  additionalProperties: false,
};

const HISTORY_SCOPE_PROPS = {
  foodIds: {
    type: "array",
    maxItems: 200,
    items: { type: "integer", minimum: 1 },
    description: "Saved food ids to correct. At least one of foodIds or entryIds is required.",
  },
  entryIds: {
    type: "array",
    maxItems: 500,
    items: { type: "integer", minimum: 1 },
    description: "Logged entry ids to correct, including all their ingredient snapshots.",
  },
  fromDay: { ...DAY_SCHEMA, description: "Optional lower bound (YYYY-MM-DD), inclusive." },
  toDay: { ...DAY_SCHEMA, description: "Optional upper bound (YYYY-MM-DD), inclusive." },
};

/**
 * The first three variants are the original shapes, with their required fields untouched; the
 * new optional provenance fields are additive. The last three accept a household measure instead
 * of grams, which the server resolves from the food (or the shared measure defaults).
 */
const MEAL_ENTRY_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        foodId: { type: "integer", minimum: 1 },
        grams: { type: "number", minimum: 0.1 },
        note: { type: "string", maxLength: 1000 },
        estimated: { type: "boolean" },
        ...PROVENANCE_PROPS,
      },
      required: ["foodId", "grams"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 200 },
        grams: { type: "number", minimum: 0.1 },
        per100g: MACROS_PER_100G_SCHEMA,
        note: { type: "string", maxLength: 1000 },
        estimated: { type: "boolean" },
        ...PROVENANCE_PROPS,
      },
      required: ["name", "grams", "per100g"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 200 },
        grams: { type: "number", minimum: 0.1 },
        kcal: { type: "number", minimum: 0 },
        proteinG: { type: "number", minimum: 0 },
        carbsG: { type: "number", minimum: 0 },
        fatG: { type: "number", minimum: 0 },
        fibreG: { type: "number", minimum: 0 },
        sodiumMg: { type: "number", minimum: 0 },
        note: { type: "string", maxLength: 1000 },
        estimated: { type: "boolean" },
        ...PROVENANCE_PROPS,
      },
      required: ["name", "grams", "kcal"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        foodId: { type: "integer", minimum: 1 },
        measure: MEASURE_SCHEMA,
        note: { type: "string", maxLength: 1000 },
        estimated: { type: "boolean" },
        ...PROVENANCE_PROPS,
      },
      required: ["foodId", "measure"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 200 },
        measure: MEASURE_SCHEMA,
        per100g: MACROS_PER_100G_SCHEMA,
        note: { type: "string", maxLength: 1000 },
        estimated: { type: "boolean" },
        ...PROVENANCE_PROPS,
      },
      required: ["name", "measure", "per100g"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 200 },
        measure: MEASURE_SCHEMA,
        kcal: { type: "number", minimum: 0 },
        proteinG: { type: "number", minimum: 0 },
        carbsG: { type: "number", minimum: 0 },
        fatG: { type: "number", minimum: 0 },
        fibreG: { type: "number", minimum: 0 },
        sodiumMg: { type: "number", minimum: 0 },
        note: { type: "string", maxLength: 1000 },
        estimated: { type: "boolean" },
        ...PROVENANCE_PROPS,
      },
      required: ["name", "measure", "kcal"],
      additionalProperties: false,
    },
  ],
};

const NO_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const DAY_PATTERN = DAY_SCHEMA.pattern;

function defineTool<Input>(definition: {
  name: string;
  description: string;
  input: Record<string, unknown>;
  /** True only for tools that do not change stored data. */
  readOnly?: boolean;
  /** True for tools whose call permanently removes data. */
  destructive?: boolean;
  run: (input: Input, signal: AbortSignal) => Promise<unknown>;
}): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.input,
    annotations: definition.destructive
      ? { readOnlyHint: false, destructiveHint: true }
      : { readOnlyHint: definition.readOnly === true },
    run: (input, signal) => definition.run(input as Input, signal),
  };
}

export function createToolDefinitions(client: HealthVaultClient): ToolDefinition[] {
  return [
    defineTool<Record<string, never>>({
      name: "healthvault_context",
      description:
        "Return everything HealthVault knows before answering: the profile, timezone and today's local day, today's nutrition, weight trend, supplements, recent training, and data freshness (last upload and latest data day). No inputs.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.healthvaultContext(signal),
    }),

    defineTool<Record<string, never>>({
      name: "healthvault_profile_get",
      description:
        "Read the user's profile together with their age and suggested nutrition targets. No inputs.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.profileGet(signal),
    }),

    defineTool<ProfileUpdateInput>({
      name: "healthvault_profile_update",
      description:
        "Update only the profile fields supplied; null or an empty string clears a field. This changes stored profile data. Inputs: name, birthDate (YYYY-MM-DD), sex (male|female|other), heightCm, timezone (IANA, e.g. Asia/Shanghai), units (metric|imperial), workSchedule ({ days: [{ weekday: 0-6, start: HH:MM, end: HH:MM }], note }), goalWeightKg, goalsNote, dietNote, activityNote.",
      input: {
        type: "object",
        properties: {
          name: { type: ["string", "null"], maxLength: 120 },
          birthDate: {
            type: ["string", "null"],
            pattern: DAY_PATTERN,
            description: "YYYY-MM-DD",
          },
          sex: { type: ["string", "null"], enum: ["male", "female", "other", null] },
          heightCm: { type: ["number", "null"], minimum: 50, maximum: 260 },
          timezone: { type: "string", description: "IANA timezone, e.g. Asia/Shanghai" },
          units: { type: "string", enum: ["metric", "imperial"] },
          workSchedule: {
            type: ["object", "null"],
            properties: {
              days: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    weekday: { type: "integer", minimum: 0, maximum: 6 },
                    start: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
                    end: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
                  },
                  required: ["weekday", "start", "end"],
                  additionalProperties: false,
                },
              },
              note: { type: "string" },
            },
            required: ["days"],
            additionalProperties: false,
          },
          goalWeightKg: { type: ["number", "null"], minimum: 20, maximum: 400 },
          goalsNote: { type: ["string", "null"], maxLength: 4000 },
          dietNote: { type: ["string", "null"], maxLength: 4000 },
          activityNote: { type: ["string", "null"], maxLength: 4000 },
        },
        additionalProperties: false,
      },
      run: (input, signal) => client.profileUpdate(input, signal),
    }),

    defineTool<MeasurementAddInput>({
      name: "healthvault_measurement_add",
      description:
        "Record a manual body measurement (merged with Apple weight on read). Inputs: kind (weight|bodyFat|waist), value, optional unit (kg|lb for weight, cm|in for waist, % for bodyFat), optional day (YYYY-MM-DD), takenAt (ISO timestamp or epoch ms), note. day defaults to today in the profile timezone.",
      input: {
        type: "object",
        properties: {
          kind: KIND_SCHEMA,
          value: { type: "number", minimum: 0 },
          unit: { type: "string" },
          day: DAY_SCHEMA,
          takenAt: { type: ["string", "number"] },
          note: { type: "string", maxLength: 1000 },
        },
        required: ["kind", "value"],
        additionalProperties: false,
      },
      run: (input, signal) => client.measurementAdd(input, signal),
    }),

    defineTool<MeasurementHistoryInput>({
      name: "healthvault_measurement_history",
      description:
        "Read one measurement series, merging manual entries with Apple BodyMass for weight. Inputs: kind (weight|bodyFat|waist, default weight) and days (default 365).",
      input: {
        type: "object",
        properties: {
          kind: KIND_SCHEMA,
          days: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.measurementHistory(input, signal),
    }),

    defineTool<FoodSearchInput>({
      name: "healthvault_food_search",
      description:
        "Find reusable foods by name or brand. Inputs: query (optional; when omitted, recently updated foods are returned) and limit (default 20).",
      input: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 120 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.foodSearch(input, signal),
    }),

    defineTool<FoodAddInput>({
      name: "healthvault_food_add",
      description:
        "Create or update a reusable food with nutrition per 100 g. Never invent nutrition values; ask the user when unsure. Inputs: name, optional brand, barcode, servingGrams, state (raw|cooked|dry|rehydrated|none — the basis of the per-100 g values), yieldFactor (cooked g per raw g, or per dry g), measures (grams per household unit, e.g. {\"tbsp\":6}), source, sourceUrl, sourceDate (YYYY-MM-DD), extra, and per100g { kcal (required), proteinG, carbsG, fatG, fibreG, sodiumMg }. This is a manual entry surface: it does not fetch or infer values.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 200 },
          brand: { type: "string", maxLength: 200 },
          barcode: { type: "string", maxLength: 64 },
          servingGrams: { type: "number", minimum: 1, maximum: 10000 },
          per100g: MACROS_PER_100G_SCHEMA,
          state: { type: "string", enum: ["raw", "cooked", "dry", "rehydrated", "none"] },
          yieldFactor: { type: "number", minimum: 0.01, maximum: 10 },
          measures: {
            type: "object",
            additionalProperties: { type: "number", minimum: 0.01 },
          },
          extra: {},
          source: { type: "string" },
          sourceUrl: { type: "string", maxLength: 500 },
          sourceDate: { type: "string", pattern: DAY_PATTERN },
        },
        required: ["name", "per100g"],
        additionalProperties: false,
      },
      run: (input, signal) => client.foodAdd(input, signal),
    }),

    defineTool<MealLogInput>({
      name: "healthvault_meal_log",
      description:
        "Log a whole meal in one call. Each entry may reference a foodId, give a name with per100g values, or give a name with absolute macros for the portion. A household measure ({ name, count }) may replace grams. Inputs: meal (breakfast|lunch|dinner|snack), entries (non-empty, at most 100), optional day (YYYY-MM-DD) and eatenAt (ISO timestamp or epoch ms; a timestamp without an offset is read in the profile timezone, and day defaults to the eatenAt day, then today). For a saved food, state must match the food's own basis — use gramsAs to say what you weighed; an inline entry may declare its state. Mark estimated: true when nutrition values are approximate; weightSource/macroSource state provenance precisely.",
      input: {
        type: "object",
        properties: {
          day: DAY_SCHEMA,
          meal: MEAL_SCHEMA,
          eatenAt: { type: ["string", "number"] },
          entries: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: MEAL_ENTRY_SCHEMA,
          },
        },
        required: ["meal", "entries"],
        additionalProperties: false,
      },
      run: (input, signal) => client.mealLog(input, signal),
    }),

    defineTool<MealUpdateInput>({
      name: "healthvault_meal_update",
      description:
        "Change an already logged meal entry, so this edits logged data. Inputs: id (required), plus any of meal, name, grams, kcal, proteinG, carbsG, fatG, fibreG, sodiumMg, estimated, note, day, eatenAt (ISO timestamp or epoch ms; no offset = profile timezone), gramsAs (raw|cooked), weightSource, macroSource. Recipe-sourced entries also accept servingNo and servingFraction; a grams or servingFraction edit rescales from the recipe's stored per-serving snapshot. Changing only grams on a food entry recomputes the macros from the food rather than compounding.",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          meal: MEAL_SCHEMA,
          name: { type: "string", maxLength: 200 },
          grams: { type: "number", minimum: 0.1, maximum: 20000 },
          kcal: { type: "number", minimum: 0 },
          proteinG: { type: "number", minimum: 0 },
          carbsG: { type: "number", minimum: 0 },
          fatG: { type: "number", minimum: 0 },
          fibreG: { type: "number", minimum: 0 },
          sodiumMg: { type: "number", minimum: 0 },
          estimated: { type: "boolean" },
          note: { type: ["string", "null"], maxLength: 1000 },
          day: DAY_SCHEMA,
          eatenAt: { type: ["string", "number"] },
          servingNo: { type: "integer", minimum: 1 },
          servingFraction: { type: "number", minimum: 0.01, maximum: 100 },
          gramsAs: { type: "string", enum: ["raw", "cooked"] },
          state: { type: "string", enum: ["raw", "cooked", "dry", "rehydrated", "none"] },
          weightSource: { type: "string", enum: ["weighed", "counted", "guessed"] },
          macroSource: { type: "string", enum: ["label", "usda", "recipe", "estimated"] },
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input, signal) => client.mealUpdate(input, signal),
    }),

    defineTool<MealDeleteInput>({
      name: "healthvault_meal_delete",
      description:
        "Permanently delete a logged meal entry, so this changes logged data; confirm the deletion with the user first. Inputs: id (required).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      destructive: true,
      run: (input, signal) => client.mealDelete(input, signal),
    }),

    defineTool<NutritionDayInput>({
      name: "healthvault_nutrition_day",
      description:
        "Read one day's meals, totals, targets and remaining macros. Inputs: optional day (YYYY-MM-DD); day defaults to today in the profile timezone.",
      input: {
        type: "object",
        properties: { day: DAY_SCHEMA },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.nutritionDay(input, signal),
    }),

    defineTool<NutritionSummaryInput>({
      name: "healthvault_nutrition_summary",
      description:
        "Read per-day nutrition totals over a range. Inputs: days (default 7, max 366) and optional endDay (YYYY-MM-DD); endDay defaults to today in the profile timezone.",
      input: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 366 },
          endDay: DAY_SCHEMA,
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.nutritionSummary(input, signal),
    }),

    defineTool<NutritionTargetSetInput>({
      name: "healthvault_nutrition_target_set",
      description:
        "Create or change an effective-dated nutrition target. Only the fields supplied change; omitted fields inherit the previous target and then the suggestion, so a partial update never zeroes the plan. This changes stored targets. Inputs: effectiveFrom (YYYY-MM-DD, defaults to today in the profile timezone), kcal, proteinG, carbsG, fatG, fibreG, sodiumMg.",
      input: {
        type: "object",
        properties: {
          effectiveFrom: DAY_SCHEMA,
          kcal: { type: "number", minimum: 0, maximum: 100000 },
          proteinG: { type: "number", minimum: 0, maximum: 100000 },
          carbsG: { type: "number", minimum: 0, maximum: 100000 },
          fatG: { type: "number", minimum: 0, maximum: 100000 },
          fibreG: { type: "number", minimum: 0, maximum: 100000 },
          sodiumMg: { type: "number", minimum: 0, maximum: 100000 },
        },
        additionalProperties: false,
      },
      run: (input, signal) => client.nutritionTargetSet(input, signal),
    }),

    defineTool<Record<string, never>>({
      name: "healthvault_supplement_list",
      description:
        "List supplements together with today's checklist and taken state. No inputs.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.supplementList(signal),
    }),

    defineTool<SupplementCreateInput>({
      name: "healthvault_supplement_create",
      description:
        "Create a supplement. Inputs: name, optional dose, unit, schedule ({ time: HH:MM, days: 0-6[], note }), nutrients, notes, active.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 160 },
          dose: { type: "number", minimum: 0.01, maximum: 10000 },
          unit: { type: "string", maxLength: 40 },
          schedule: {
            type: ["object", "null"],
            properties: {
              time: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" },
              days: {
                type: ["array", "null"],
                items: { type: "integer", minimum: 0, maximum: 6 },
              },
              note: { type: "string" },
            },
            additionalProperties: false,
          },
          nutrients: {},
          notes: { type: "string", maxLength: 2000 },
          active: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      run: (input, signal) => client.supplementCreate(input, signal),
    }),

    defineTool<SupplementUpdateInput>({
      name: "healthvault_supplement_update",
      description:
        "Change an existing supplement regimen; only the fields supplied change. This alters stored regimen data. Inputs: supplementId (required), and any of name, dose, unit, schedule ({ time: HH:MM, days: 0-6[], note } or null), nutrients, notes, active (false archives it).",
      input: {
        type: "object",
        properties: {
          supplementId: { type: "integer", minimum: 1 },
          name: { type: "string", maxLength: 160 },
          dose: { type: "number", minimum: 0.01, maximum: 10000 },
          unit: { type: "string", maxLength: 40 },
          schedule: {
            type: ["object", "null"],
            properties: {
              time: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" },
              days: {
                type: ["array", "null"],
                items: { type: "integer", minimum: 0, maximum: 6 },
              },
              note: { type: "string" },
            },
            additionalProperties: false,
          },
          nutrients: {},
          notes: { type: "string", maxLength: 2000 },
          active: { type: "boolean" },
        },
        required: ["supplementId"],
        additionalProperties: false,
      },
      run: (input, signal) => client.supplementUpdate(input, signal),
    }),

    defineTool<SupplementLogInput>({
      name: "healthvault_supplement_log",
      description:
        "Mark a supplement taken or untaken for a day. Inputs: supplementId (required), optional day (YYYY-MM-DD), taken (default true; false removes the log), dose, unit, takenAt (ISO timestamp or epoch ms), note. day defaults to today in the profile timezone.",
      input: {
        type: "object",
        properties: {
          supplementId: { type: "integer", minimum: 1 },
          day: DAY_SCHEMA,
          taken: { type: "boolean" },
          dose: { type: "number", minimum: 0.01, maximum: 10000 },
          unit: { type: "string", maxLength: 40 },
          takenAt: { type: ["string", "number"] },
          note: { type: "string", maxLength: 1000 },
        },
        required: ["supplementId"],
        additionalProperties: false,
      },
      run: (input, signal) => client.supplementLog(input, signal),
    }),

    defineTool<MetricsSeriesInput>({
      name: "healthvault_metrics_series",
      description:
        "Read an Apple Health time series, one source per day where sources overlap. Inputs: metric (steps|heart_rate|resting_heart_rate|vo2max|weight|sleep|active_energy) and days (default 30, max 730).",
      input: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: [
              "steps",
              "heart_rate",
              "resting_heart_rate",
              "vo2max",
              "weight",
              "sleep",
              "active_energy",
            ],
          },
          days: { type: "integer", minimum: 1, maximum: 730 },
        },
        required: ["metric"],
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.metricsSeries(input, signal),
    }),

    defineTool<WorkoutsRecentInput>({
      name: "healthvault_workouts_recent",
      description:
        "Read recent workouts, newest first, with duration, distance, energy, pace, speed and heart rate. Inputs: limit (default 10).",
      input: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.workoutsRecent(input, signal),
    }),

    defineTool<MeasurementDeleteInput>({
      name: "healthvault_measurement_delete",
      description:
        "Permanently delete a manual body measurement, so this changes stored data; confirm the deletion with the user first. Only manual entries are removed — Apple BodyMass rows stay. Inputs: id (required).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      destructive: true,
      run: (input, signal) => client.measurementDelete(input, signal),
    }),

    defineTool<FoodDeleteInput>({
      name: "healthvault_food_delete",
      description:
        "Permanently delete a reusable food, so this changes stored data; confirm the deletion with the user first. Fails with 409 when the food is still used by a logged meal. Inputs: id (required).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      destructive: true,
      run: (input, signal) => client.foodDelete(input, signal),
    }),

    defineTool<CopyDayInput>({
      name: "healthvault_copy_day",
      description:
        "Copy a day's logged meals onto another day, so this writes logged data; confirm the target day with the user first. Rows already present on toDay are skipped, so the call is idempotent, and the result reports the copied count. Inputs: fromDay and toDay (YYYY-MM-DD, must differ); fails with 404 when fromDay has no entries.",
      input: {
        type: "object",
        properties: {
          fromDay: DAY_SCHEMA,
          toDay: DAY_SCHEMA,
        },
        required: ["fromDay", "toDay"],
        additionalProperties: false,
      },
      run: (input, signal) => client.copyDay(input, signal),
    }),

    defineTool<Record<string, never>>({
      name: "healthvault_record_types",
      description:
        "Read-only Apple record-type statistics: each type's unit, record count, first and last day, sum, average and maximum. No inputs.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.recordTypes(signal),
    }),

    defineTool<RecordsRecentInput>({
      name: "healthvault_records_recent",
      description:
        "Read raw Apple Health rows for one record type, newest first. Rows are NOT de-duplicated across phone and watch — use metrics_series for daily totals. Inputs: type (record type identifier, required) and limit (default 50, max 500).",
      input: {
        type: "object",
        properties: {
          type: { type: "string", minLength: 1, maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["type"],
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.recordsRecent(input, signal),
    }),

    defineTool<UploadsRecentInput>({
      name: "healthvault_uploads_recent",
      description:
        "Read import history, newest first. Read-only: importing an Apple Health export stays a manual action. Inputs: limit (default 50, max 500).",
      input: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.uploadsRecent(input, signal),
    }),

    defineTool<SupplementHistoryInput>({
      name: "healthvault_supplement_history",
      description:
        "Read supplement adherence: days with at least one logged dose, newest first, each with the doses taken. Read-only. Inputs: days (default 30, max 366).",
      input: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 366 },
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.supplementHistory(input, signal),
    }),

    defineTool<SupplementDeleteInput>({
      name: "healthvault_supplement_delete",
      description:
        "Remove a supplement regimen, so this changes stored data; confirm with the user first. Archives the supplement when intake history exists (deleted false, archived true), otherwise permanently deletes it. Inputs: id (required).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      destructive: true,
      run: (input, signal) => client.supplementDelete(input, signal),
    }),

    defineTool<RecipeCreateInput>({
      name: "healthvault_recipe_create",
      description:
        "Create a reusable composite dish. Totals are computed from the ingredients (per-100 g × grams), never stored twice; per serving = total / servings. Inputs: name, servings (default 2), note, ingredients (non-empty array of { foodId?, name?, grams, measure? }). Each ingredient needs grams or a household measure; foodId supplies its nutrition, while a name-only ingredient keeps its weight but is exposed as unresolved, marks the recipe incomplete, and makes logged servings estimated. Returns the recipe with total, perServing, complete and unresolvedIngredients.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 200 },
          servings: { type: "integer", minimum: 1, maximum: 100 },
          note: { type: "string", maxLength: 2000 },
          ingredients: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                foodId: { type: "integer", minimum: 1 },
                name: { type: "string", maxLength: 200 },
                grams: { type: "number", minimum: 0.1 },
                measure: MEASURE_SCHEMA,
              },
              additionalProperties: false,
            },
          },
        },
        required: ["name", "ingredients"],
        additionalProperties: false,
      },
      run: (input, signal) => client.recipeCreate(input, signal),
    }),

    defineTool<RecipeGetInput>({
      name: "healthvault_recipe_get",
      description:
        "Read one recipe with its resolved ingredients, total and per-serving macros, remaining servings and the servings already logged. Inputs: id (required).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.recipeGet(input, signal),
    }),

    defineTool<RecipeLogInput>({
      name: "healthvault_recipe_log",
      description:
        "Log one serving of a recipe as an immutable snapshot with one row per ingredient. Inputs: recipeId, meal, optional day (YYYY-MM-DD), servingNo (defaults to the next unlogged serving), servingFraction (default 1), eatenAt (ISO timestamp or epoch ms; no offset = profile timezone), note, and optional ingredientOverrides (this meal only; the recipe definition is not edited) plus amountBasis. amountBasis is required with overrides: 'batch' means override grams are for the whole recipe (divided by servings), 'serving' means they are already one serving. The per-serving values and every ingredient (food id, grams, measure, state, source, macros) are captured on the row, so later recipe edits or archiving never rewrite history. If the recipe has name-only ingredients the entry is saved with estimated macros and reports incomplete/unresolvedIngredients; a recipe with no food-resolved ingredients is rejected. This writes logged data.",
      input: {
        type: "object",
        properties: {
          recipeId: { type: "integer", minimum: 1 },
          day: DAY_SCHEMA,
          meal: MEAL_SCHEMA,
          servingNo: { type: "integer", minimum: 1 },
          servingFraction: { type: "number", minimum: 0.01, maximum: 100 },
          eatenAt: { type: ["string", "number"] },
          name: { type: "string", maxLength: 200 },
          note: { type: "string", maxLength: 1000 },
          weightSource: { type: "string", enum: ["weighed", "counted", "guessed"] },
          ingredientOverrides: {
            type: "array",
            maxItems: 100,
            items: INGREDIENT_OVERRIDE_SCHEMA,
          },
          amountBasis: {
            type: "string",
            enum: ["batch", "serving"],
            description:
              "Required with ingredientOverrides. 'batch' = grams for the whole recipe; 'serving' = grams for one serving.",
          },
        },
        required: ["recipeId", "meal"],
        additionalProperties: false,
      },
      run: (input, signal) => client.recipeLog(input, signal),
    }),

    defineTool<RecipeUpdateInput>({
      name: "healthvault_recipe_update",
      description:
        "Change a recipe; only the fields supplied change. Replacing ingredients never rewrites already logged entries. Inputs: id (required), name, servings, note, ingredients (replaces the whole list; each needs grams or measure, with foodId for nutrition, or name-only to store an unresolved ingredient). This edits stored recipe data.",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          name: { type: "string", maxLength: 200 },
          servings: { type: "integer", minimum: 1, maximum: 100 },
          note: { type: "string", maxLength: 2000 },
          ingredients: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                foodId: { type: "integer", minimum: 1 },
                name: { type: "string", maxLength: 200 },
                grams: { type: "number", minimum: 0.1 },
                measure: MEASURE_SCHEMA,
              },
              additionalProperties: false,
            },
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input, signal) => client.recipeUpdate(input, signal),
    }),

    defineTool<RecipeDeleteInput>({
      name: "healthvault_recipe_delete",
      description:
        "Remove a recipe. A recipe still referenced by logged entries or by historical child snapshots (for example a copy_day copy whose parent recipeId was cleared) is archived instead of destroyed (result: deleted false, archived true, with the reason, loggedEntries and snapshotIngredients): it leaves the active surface, but the logged snapshots stay readable and rescalable. An unreferenced recipe is deleted with its own ingredient rows. Inputs: id (required).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      destructive: true,
      run: (input, signal) => client.recipeDelete(input, signal),
    }),

    defineTool<Record<string, never>>({
      name: "healthvault_food_template_list",
      description:
        "Read the explicit food templates distilled from the real log: household grams (honey 1 kutsarita = 7 g, NESCAFÉ Gold 1 tbsp = 6 g, jumbo egg 1 piece = 60 g, KFC fry 1 strip = 2 g, whey 1 scoop = 32.4 g) and raw/dry yield factors (chicken breast 0.75, thigh/ground beef 0.70, rice 2.3, pulses 2.4, pasta 1.8, oats 2.3). Read-only; nothing is applied by name inference. No inputs.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.foodTemplateList(signal),
    }),

    defineTool<FoodTemplateApplyInput>({
      name: "healthvault_food_template_apply",
      description:
        "Apply one named template to a specific saved food id: its household-measure grams and/or state + yield factor. This edits the food definition (never its macros or logged history). Existing per-unit overrides and a custom state/yield are kept unless overwrite is true. Use food_template_list for the exact template names; matching is exact, never by food name. Inputs: id (required), template (required slug), overwrite (default false).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          template: { type: "string", minLength: 1, maxLength: 80 },
          overwrite: { type: "boolean" },
        },
        required: ["id", "template"],
        additionalProperties: false,
      },
      run: (input, signal) => client.foodTemplateApply(input, signal),
    }),

    defineTool<MealGetInput>({
      name: "healthvault_meal_get",
      description:
        "Read one logged meal entry with its full historical snapshot: the aggregate row plus every ingredient (food id, grams, household measure, state, per-100 g values, macros, source metadata) captured at log time. `ingredientSnapshotComplete` is null for a plain food entry, true when the ingredient snapshot exists, and false for a legacy aggregate-only recipe row whose ingredients were never recorded. Inputs: id (required).",
      input: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.mealGet(input, signal),
    }),

    defineTool<FoodHistoryPreviewInput>({
      name: "healthvault_food_history_preview",
      description:
        "Preview corrections to already logged snapshots after a saved food's nutrition changed. Read-only: nothing is written. Scope with foodIds and/or entryIds (at least one), optionally fromDay/toDay. Returns each affected entry/ingredient with previous and proposed macros, plus a previewHash. Rows are skipped (never guessed) when the food is missing, the stored basis is unknown, or the food's state basis changed. Legacy aggregate-only recipe rows are not refreshed and are labelled incomplete by meal_get/nutrition_day.",
      input: {
        type: "object",
        properties: HISTORY_SCOPE_PROPS,
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.foodHistoryPreview(input, signal),
    }),

    defineTool<FoodHistoryRefreshInput>({
      name: "healthvault_food_history_refresh",
      description:
        "Apply exactly the corrections a prior food_history_preview showed. Requires the same scope plus its previewHash; a stale or unseen preview is rejected with 409, and nothing outside the stated scope changes. Each changed row keeps a revision with its previous and new values. This edits logged data, so run the preview and confirm with the user first.",
      input: {
        type: "object",
        properties: {
          ...HISTORY_SCOPE_PROPS,
          previewHash: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "previewHash returned by food_history_preview for the same scope.",
          },
        },
        required: ["previewHash"],
        additionalProperties: false,
      },
      run: (input, signal) => client.foodHistoryRefresh(input, signal),
    }),
  ];
}
