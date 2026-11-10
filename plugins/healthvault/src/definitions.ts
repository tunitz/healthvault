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
  FoodSearchInput,
  HealthVaultClient,
  MealDeleteInput,
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
      name: "healthvault_meal_log",
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
      name: "healthvault_meal_update",
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
  ];
}
