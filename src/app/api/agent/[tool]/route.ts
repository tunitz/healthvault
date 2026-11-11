import { NextResponse } from "next/server";
import {
  healthvaultContext,
  metricsSeries,
} from "@/lib/services/context";
import {
  addMeasurement,
  deleteMeasurement,
  KINDS,
  latestMeasurement,
  measurementHistory,
} from "@/lib/services/measurements";
import {
  addFood,
  applyFoodTemplate,
  copyDay,
  dayNutrition,
  deleteEntry,
  deleteFood,
  getEntry,
  logMeal,
  logRecipe,
  nutritionRange,
  resolveTargets,
  searchFoods,
  setTargets,
  updateEntry,
} from "@/lib/services/nutrition";
import {
  applyHistoryRefresh,
  previewHistoryRefresh,
} from "@/lib/services/food-history";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  updateRecipe,
} from "@/lib/services/recipes";
import { listFoodTemplates } from "@/lib/services/food-templates";
import {
  ageOf,
  getProfile,
  suggestedTargets,
  updateProfile,
  workSchedule,
} from "@/lib/services/profile";
import {
  createSupplement,
  deleteSupplement,
  listSupplements,
  logSupplement,
  supplementHistory,
  todayChecklist,
  updateSupplement,
} from "@/lib/services/supplements";
import { recentUploads, recordsForType, typeStats, workoutHistory } from "@/db/queries";
import { currentDay } from "@/lib/services/context";
import { AGENT_TOOLS, type AgentTool } from "@/lib/agent-tools";
import { ValidationError, dayField, enumField, fail, numField, readJson, str } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Numeric query inputs are validated here, not deep inside SQL, so a bad value is a 400
 * instead of a RangeError/SqliteError 500 (and `LIMIT NULL` cannot mean "unbounded"). */
const daysField = (value: unknown, fallback: number, max: number) =>
  numField(value ?? fallback, "days", { integer: true, min: 1, max }) ?? fallback;
const limitField = (value: unknown, fallback: number, max: number) =>
  numField(value ?? fallback, "limit", { integer: true, min: 1, max }) ?? fallback;

/**
 * Every handler receives the JSON body and returns a JSON-safe value. The agent plugin and the
 * UI's own writes go through the same service layer, so both validate identically.
 */
const TOOLS = {
  healthvault_context: () => healthvaultContext(),

  profile_get: () => {
    const profile = getProfile();
    return {
      profile,
      workSchedule: workSchedule(profile),
      age: ageOf(profile, currentDay()),
      suggestedTargets: suggestedTargets(profile, latestMeasurement("weight")?.value ?? 75),
    };
  },
  profile_update: (body: Record<string, unknown>) => updateProfile(body),

  measurement_add: (body: Record<string, unknown>) => addMeasurement(body),
  measurement_history: (body: Record<string, unknown>) =>
    measurementHistory(
      enumField(body.kind ?? "weight", "kind", KINDS, false) ?? "weight",
      daysField(body.days, 365, 3650),
    ),

  food_search: (body: Record<string, unknown>) =>
    searchFoods(body.query, limitField(body.limit, 20, 100)),
  food_add: (body: Record<string, unknown>) => addFood(body),

  meal_log: (body: Record<string, unknown>) => logMeal(body),
  meal_update: (body: Record<string, unknown>) => updateEntry(body.id, body),
  meal_delete: (body: Record<string, unknown>) => deleteEntry(body.id),
  meal_get: (body: Record<string, unknown>) => getEntry(body.id),

  nutrition_day: (body: Record<string, unknown>) => dayNutrition(dayField(body.day, "day", currentDay())),
  nutrition_summary: (body: Record<string, unknown>) => {
    const days = daysField(body.days, 7, 366);
    const perDay = nutritionRange(
      days,
      body.endDay === undefined || body.endDay === "" ? undefined : dayField(body.endDay, "endDay"),
    );
    return { days, targets: resolveTargets(currentDay()), perDay };
  },

  nutrition_target_set: (body: Record<string, unknown>) => setTargets(body),

  supplement_list: () => ({ supplements: listSupplements(false), checklist: todayChecklist() }),
  supplement_create: (body: Record<string, unknown>) => createSupplement(body),
  supplement_update: (body: Record<string, unknown>) => updateSupplement(body.supplementId ?? body.id, body),
  supplement_log: (body: Record<string, unknown>) => logSupplement(body),

  metrics_series: (body: Record<string, unknown>) => metricsSeries(body.metric, daysField(body.days, 30, 730)),
  workouts_recent: (body: Record<string, unknown>) => workoutHistory(limitField(body.limit, 10, 500)),

  measurement_delete: (body: Record<string, unknown>) => {
    const result = deleteMeasurement(body.id);
    if (!result.deleted) fail("measurement not found", 404);
    return result;
  },
  food_delete: (body: Record<string, unknown>) => {
    const result = deleteFood(body.id);
    if (!result.deleted) fail("food not found", 404);
    return result;
  },
  copy_day: (body: Record<string, unknown>) =>
    copyDay(dayField(body.fromDay, "fromDay"), dayField(body.toDay, "toDay")),

  record_types: () => typeStats(),
  records_recent: (body: Record<string, unknown>) => {
    const type = str(body.type, "type", { required: true, max: 200 })!;
    return { type, rows: recordsForType(type, limitField(body.limit, 50, 500)) };
  },
  uploads_recent: (body: Record<string, unknown>) => recentUploads(limitField(body.limit, 50, 500)),

  supplement_history: (body: Record<string, unknown>) => supplementHistory(daysField(body.days, 30, 366)),
  supplement_delete: (body: Record<string, unknown>) => {
    const result = deleteSupplement(body.id);
    if (!result.deleted && !result.archived) fail("supplement not found", 404);
    return result;
  },

  recipe_create: (body: Record<string, unknown>) => createRecipe(body),
  recipe_get: (body: Record<string, unknown>) => getRecipe(body.id ?? body.recipeId),
  recipe_log: (body: Record<string, unknown>) => logRecipe(body),
  recipe_update: (body: Record<string, unknown>) => updateRecipe(body.id ?? body.recipeId, body),
  recipe_delete: (body: Record<string, unknown>) => {
    const result = deleteRecipe(body.id ?? body.recipeId);
    if (!result.deleted && !result.archived) fail("recipe not found", 404);
    return result;
  },

  food_template_list: () => ({ templates: listFoodTemplates() }),
  food_template_apply: (body: Record<string, unknown>) =>
    applyFoodTemplate(body.id, body.template, { overwrite: body.overwrite === true }),

  food_history_preview: (body: Record<string, unknown>) => previewHistoryRefresh(body),
  food_history_refresh: (body: Record<string, unknown>) => applyHistoryRefresh(body),
} satisfies Record<AgentTool, (body: Record<string, unknown>) => unknown>;

export async function GET() {
  return NextResponse.json({
    tools: AGENT_TOOLS,
    posture: "single-user; local agent surface, no token required (trusted LAN only)",
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ tool: string }> }) {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "content-type must be application/json" }, { status: 415 });
  }

  const { tool } = await ctx.params;
  const handler = TOOLS[tool as AgentTool];
  if (!handler) {
    return NextResponse.json({ error: `unknown tool: ${tool}`, tools: Object.keys(TOOLS) }, { status: 404 });
  }
  try {
    const body = await readJson(req);
    const result = await handler(body);
    return NextResponse.json({ ok: true, tool, result });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ ok: false, tool, error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, tool, error: message }, { status: 500 });
  }
}
