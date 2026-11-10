/**
 * V2 tool definitions for the HealthVault agent API.
 *
 * `createToolDefinitions` is pure: it only closes over the client. OpenCode
 * registers the returned definitions through `ctx.tool.transform`.
 */

import type {
  FoodAddInput,
  FoodSearchInput,
  HealthVaultClient,
  MealDeleteInput,
  MealLogInput,
  MealUpdateInput,
  MeasurementAddInput,
  MeasurementHistoryInput,
  MetricsSeriesInput,
  NutritionDayInput,
  NutritionSummaryInput,
  NutritionTargetSetInput,
  ProfileUpdateInput,
  SupplementCreateInput,
  SupplementLogInput,
  SupplementUpdateInput,
  WorkoutsRecentInput,
} from "./client";

export const TOOL_NAMESPACE = "healthvault";
export const TOOL_NAMESPACE_DESCRIPTION =
  "Read and update the user's local HealthVault data: profile, measurements, food, meals, nutrition, supplements and Apple Health metrics.";

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  progress(update: Record<string, unknown>): Promise<void>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly options: { readonly namespace: string };
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<{ content: string }>;
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

const MEAL_ENTRY_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        foodId: { type: "integer", minimum: 1 },
        grams: { type: "number", minimum: 0.1 },
        note: { type: "string", maxLength: 1000 },
        estimated: { type: "boolean" },
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
      },
      required: ["name", "grams", "kcal"],
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
  run: (input: Input, signal: AbortSignal) => Promise<unknown>;
}): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    options: { namespace: TOOL_NAMESPACE },
    execute: async (input, context) => {
      try {
        const result = await definition.run(input as Input, context.signal);
        return { content: JSON.stringify(result, null, 2) ?? "null" };
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error(
          `HealthVault tool ${definition.name} failed: ${String(error)}`,
        );
      }
    },
  };
}

export function createToolDefinitions(client: HealthVaultClient): ToolDefinition[] {
  return [
    defineTool<Record<string, never>>({
      name: "context",
      description:
        "Return everything HealthVault knows before answering: the profile, timezone and today's local day, today's nutrition, weight trend, supplements, recent training, and data freshness (last upload and latest data day). No inputs.",
      input: NO_INPUT,
      run: (_input, signal) => client.healthvaultContext(signal),
    }),

    defineTool<Record<string, never>>({
      name: "profile_get",
      description:
        "Read the user's profile together with their age and suggested nutrition targets. No inputs.",
      input: NO_INPUT,
      run: (_input, signal) => client.profileGet(signal),
    }),

    defineTool<ProfileUpdateInput>({
      name: "profile_update",
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
      name: "measurement_add",
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
      name: "measurement_history",
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
      run: (input, signal) => client.measurementHistory(input, signal),
    }),

    defineTool<FoodSearchInput>({
      name: "food_search",
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
      run: (input, signal) => client.foodSearch(input, signal),
    }),

    defineTool<FoodAddInput>({
      name: "food_add",
      description:
        "Create or update a reusable food with nutrition per 100 g. Never invent nutrition values; ask the user when unsure. Inputs: name, optional brand, barcode, servingGrams, source, extra, and per100g { kcal (required), proteinG, carbsG, fatG, fibreG, sodiumMg }.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 200 },
          brand: { type: "string", maxLength: 200 },
          barcode: { type: "string", maxLength: 64 },
          servingGrams: { type: "number", minimum: 1, maximum: 10000 },
          per100g: MACROS_PER_100G_SCHEMA,
          extra: {},
          source: { type: "string" },
        },
        required: ["name", "per100g"],
        additionalProperties: false,
      },
      run: (input, signal) => client.foodAdd(input, signal),
    }),

    defineTool<MealLogInput>({
      name: "meal_log",
      description:
        "Log a whole meal in one call. Each entry may reference a foodId, give a name with per100g values, or give a name with absolute macros for the portion. Inputs: meal (breakfast|lunch|dinner|snack), entries (non-empty, at most 100), optional day (YYYY-MM-DD). day defaults to today in the profile timezone. Mark estimated: true when nutrition values are approximate.",
      input: {
        type: "object",
        properties: {
          day: DAY_SCHEMA,
          meal: MEAL_SCHEMA,
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
      name: "meal_update",
      description:
        "Change an already logged meal entry, so this edits logged data. Inputs: id (required), plus any of meal, name, grams, kcal, proteinG, carbsG, fatG, fibreG, sodiumMg, estimated, note. Changing only grams scales the existing macros proportionally.",
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
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input, signal) => client.mealUpdate(input, signal),
    }),

    defineTool<MealDeleteInput>({
      name: "meal_delete",
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
      run: (input, signal) => client.mealDelete(input, signal),
    }),

    defineTool<NutritionDayInput>({
      name: "nutrition_day",
      description:
        "Read one day's meals, totals, targets and remaining macros. Inputs: optional day (YYYY-MM-DD); day defaults to today in the profile timezone.",
      input: {
        type: "object",
        properties: { day: DAY_SCHEMA },
        additionalProperties: false,
      },
      run: (input, signal) => client.nutritionDay(input, signal),
    }),

    defineTool<NutritionSummaryInput>({
      name: "nutrition_summary",
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
      run: (input, signal) => client.nutritionSummary(input, signal),
    }),

    defineTool<NutritionTargetSetInput>({
      name: "nutrition_target_set",
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
      name: "supplement_list",
      description:
        "List supplements together with today's checklist and taken state. No inputs.",
      input: NO_INPUT,
      run: (_input, signal) => client.supplementList(signal),
    }),

    defineTool<SupplementCreateInput>({
      name: "supplement_create",
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
      name: "supplement_update",
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
      name: "supplement_log",
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
      name: "metrics_series",
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
      run: (input, signal) => client.metricsSeries(input, signal),
    }),

    defineTool<WorkoutsRecentInput>({
      name: "workouts_recent",
      description:
        "Read recent workouts, newest first, with duration, distance, energy, pace, speed and heart rate. Inputs: limit (default 10).",
      input: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      run: (input, signal) => client.workoutsRecent(input, signal),
    }),
  ];
}

/** Tool names as the model sees them, after the namespace is applied. */
export const TOOL_NAMES = [
  "healthvault_context",
  "healthvault_profile_get",
  "healthvault_profile_update",
  "healthvault_measurement_add",
  "healthvault_measurement_history",
  "healthvault_food_search",
  "healthvault_food_add",
  "healthvault_meal_log",
  "healthvault_meal_update",
  "healthvault_meal_delete",
  "healthvault_nutrition_day",
  "healthvault_nutrition_summary",
  "healthvault_nutrition_target_set",
  "healthvault_supplement_list",
  "healthvault_supplement_create",
  "healthvault_supplement_update",
  "healthvault_supplement_log",
  "healthvault_metrics_series",
  "healthvault_workouts_recent",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
