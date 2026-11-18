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
  HealthContextInput,
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
  RecipeListInput,
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

/**
 * Server identity and instructions are shared by the stdio entry (`mcp.ts`) and the in-app
 * Streamable HTTP transport. This module stays free of the MCP SDK so both transports can import
 * the exact same text and tool list without drifting. The instructions deliberately make the
 * context call conditional, confirm destructive actions, and keep imports manual.
 */
export const SERVER_NAME = "healthvault";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = [
  "Call healthvault_context only when the user asks a question that needs stored HealthVault data (profile, timezone, today's local day, nutrition, weight, supplements, strength, training, data freshness); do not call it for greetings or questions that need no stored data. Pass its optional `sections` array to fetch just the parts you need.",
  "Confirm destructive actions with the user first: deletes (healthvault_meal_delete, healthvault_food_delete, healthvault_measurement_delete, healthvault_supplement_delete) and the target day of healthvault_copy_day. healthvault_recipe_delete archives a recipe that has logged history instead of deleting it. For past-meal corrections after a food's nutrition changed, run healthvault_food_history_preview and confirm the exact rows before healthvault_food_history_refresh.",
  "Apple Health imports stay a manual user action: tools only read imported data, and healthvault_uploads_recent shows import history.",
].join(" ");

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

const CONTEXT_SECTIONS_SCHEMA = {
  type: "array",
  items: {
    type: "string",
    enum: ["today", "profile", "nutrition", "weight", "supplements", "training", "data"],
  },
  description: "Only these parts to return; unknown names are ignored, and omitted or empty returns everything.",
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
    defineTool<HealthContextInput>({
      name: "healthvault_context",
      description: "Return stored HealthVault data; `sections` limits the response (unknown names ignored; omitted/empty = all).",
      input: {
        type: "object",
        properties: { sections: CONTEXT_SECTIONS_SCHEMA },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.healthvaultContext(input, signal),
    }),

    defineTool<Record<string, never>>({
      name: "healthvault_profile_get",
      description: "Read the user's profile, parsed schedule, 5K goal, whey link and suggested nutrition targets.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.profileGet(signal),
    }),

    defineTool<ProfileUpdateInput>({
      name: "healthvault_profile_update",
      description: "Update only the supplied profile fields; null or an empty string clears a field.",
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
          goal: {
            type: ["object", "null"],
            properties: {
              type: { type: "string", enum: ["run5k"] },
              targetSeconds: { type: "integer", minimum: 1200, maximum: 3599 },
            },
            additionalProperties: false,
          },
          wheyLink: {
            type: ["object", "null"],
            properties: {
              foodId: { type: "integer", minimum: 1 },
              supplementId: { type: ["integer", "null"], minimum: 1 },
              grams: { type: "number", minimum: 0.1, maximum: 5000 },
              meal: MEAL_SCHEMA,
            },
            required: ["foodId"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      run: (input, signal) => client.profileUpdate(input, signal),
    }),

    defineTool<MeasurementAddInput>({
      name: "healthvault_measurement_add",
      description: "Record a manual body measurement, merged with Apple weight on read.",
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
      description: "Read a measurement series, merging manual entries with Apple BodyMass for weight.",
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
      description: "Find reusable foods by name or brand.",
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
      description: "Create or update a reusable food with per-100 g nutrition; never invent values.",
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
      description: "Log one or more foods or a recipe serving into a meal.",
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
      description: "Change an already logged meal entry.",
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
      description: "Permanently delete a logged meal entry; confirm with the user first.",
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
      description: "Read one day's meals, totals, targets and remaining macros.",
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
      description: "Read per-day nutrition totals over a range.",
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
      description: "Create or change an effective-dated nutrition target.",
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
      description: "List supplements with today's checklist and taken state.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.supplementList(signal),
    }),

    defineTool<SupplementCreateInput>({
      name: "healthvault_supplement_create",
      description: "Create a supplement regimen.",
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
      description: "Change an existing supplement regimen; only supplied fields change.",
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
      description: "Mark a supplement taken or untaken for a day.",
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
      description: "Read an Apple Health time series, one source per day.",
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
      description: "Read recent workouts, newest first.",
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
      description: "Permanently delete a manual body measurement; confirm with the user first.",
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
      description: "Permanently delete a reusable food; confirm with the user first.",
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
      description: "Copy a day's logged meals onto another day; confirm the target day first.",
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
      description: "Read Apple record-type statistics (counts, dates, sums, averages, maxima).",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.recordTypes(signal),
    }),

    defineTool<RecordsRecentInput>({
      name: "healthvault_records_recent",
      description: "Read raw Apple Health rows for one record type, newest first.",
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
      description: "Read import history, newest first; imports stay manual.",
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
      description: "Read supplement adherence days and doses taken.",
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
      description: "Remove a supplement regimen (archives it when it has intake history).",
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
      description: "Create a reusable composite dish from ingredients.",
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
      description: "Read a recipe with resolved ingredients, total and per-serving macros.",
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
      description: "Log one serving of a recipe as an immutable snapshot.",
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
      description: "Change a recipe; only the supplied fields change.",
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
      description: "Remove a recipe (archives it when it has logged references).",
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
      description: "List the saved household-measure and yield-factor food templates.",
      input: NO_INPUT,
      readOnly: true,
      run: (_input, signal) => client.foodTemplateList(signal),
    }),

    defineTool<FoodTemplateApplyInput>({
      name: "healthvault_food_template_apply",
      description: "Apply one named template to a saved food id.",
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
      description: "Read one logged meal entry with its full historical snapshot.",
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
      description: "Preview corrections to logged snapshots after a food's nutrition changed.",
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
      description: "Apply a previewed correction by scope and previewHash.",
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

    defineTool<RecipeListInput>({
      name: "healthvault_recipe_list",
      description: "List saved recipes without loading their ingredients.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 120 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          includeArchived: { type: "boolean" },
        },
        additionalProperties: false,
      },
      readOnly: true,
      run: (input, signal) => client.recipeList(input, signal),
    }),
  ];
}
