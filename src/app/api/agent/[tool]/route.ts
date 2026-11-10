import { NextResponse } from "next/server";
import {
  healthvaultContext,
  metricsSeries,
} from "@/lib/services/context";
import {
  addMeasurement,
  KINDS,
  latestMeasurement,
  measurementHistory,
} from "@/lib/services/measurements";
import {
  addFood,
  dayNutrition,
  deleteEntry,
  logMeal,
  nutritionRange,
  resolveTargets,
  searchFoods,
  updateEntry,
} from "@/lib/services/nutrition";
import { ageOf, getProfile, suggestedTargets, updateProfile } from "@/lib/services/profile";
import {
  createSupplement,
  listSupplements,
  logSupplement,
  todayChecklist,
} from "@/lib/services/supplements";
import { workoutHistory } from "@/db/queries";
import { currentDay } from "@/lib/services/context";
import { AGENT_TOOLS, type AgentTool } from "@/lib/agent-tools";
import { ValidationError, dayField, enumField, numField, readJson } from "@/lib/validate";

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

  nutrition_day: (body: Record<string, unknown>) => dayNutrition(dayField(body.day, "day", currentDay())),
  nutrition_summary: (body: Record<string, unknown>) => {
    const days = daysField(body.days, 7, 366);
    const perDay = nutritionRange(
      days,
      body.endDay === undefined || body.endDay === "" ? undefined : dayField(body.endDay, "endDay"),
    );
    return { days, targets: resolveTargets(currentDay()), perDay };
  },

  supplement_list: () => ({ supplements: listSupplements(false), checklist: todayChecklist() }),
  supplement_create: (body: Record<string, unknown>) => createSupplement(body),
  supplement_log: (body: Record<string, unknown>) => logSupplement(body),

  metrics_series: (body: Record<string, unknown>) => metricsSeries(body.metric, daysField(body.days, 30, 730)),
  workouts_recent: (body: Record<string, unknown>) => workoutHistory(limitField(body.limit, 10, 500)),
} satisfies Record<AgentTool, (body: Record<string, unknown>) => unknown>;

export async function GET() {
  return NextResponse.json({
    tools: AGENT_TOOLS,
    posture: "single-user, local-only; no authentication by design",
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ tool: string }> }) {
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
