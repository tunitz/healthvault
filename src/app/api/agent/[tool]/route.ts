import { NextResponse } from "next/server";
import { agentRequestFailure } from "@/lib/auth";
import {
  compactAgentContext,
  compactDayNutrition,
  compactFoodSearch,
  compactProfile,
  compactSupplementList,
} from "@/lib/agent-format";
import { sanitizeAgentNumbers } from "@/lib/round";
import {
  currentDay,
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
  updateFood,
} from "@/lib/services/nutrition";
import {
  applyHistoryRefresh,
  previewHistoryRefresh,
} from "@/lib/services/food-history";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  previewRecipeServing,
  updateRecipe,
} from "@/lib/services/recipes";
import { listFoodTemplates } from "@/lib/services/food-templates";
import {
  ageOf,
  getProfile,
  parseWheyLink,
  suggestedTargets,
  trainingGoal,
  updateProfile,
  workSchedule,
} from "@/lib/services/profile";
import {
  createSupplement,
  deleteSupplement,
  listSupplements,
  logSupplement,
  logSupplementsBatch,
  supplementHistory,
  todayChecklist,
  updateSupplement,
  weeklyAdherence,
} from "@/lib/services/supplements";
import {
  addStrengthSets,
  deleteStrengthSet,
  exerciseProgression,
  listStrengthSessions,
} from "@/lib/services/strength";
import { MAX_WEEK_OFFSET, weeklySummary } from "@/lib/services/training";
import { currentBlock, setSessionStatus, startBlock } from "@/lib/services/training-plan";
import { logWhey, undoWhey } from "@/lib/services/whey";
import {
  fiveKAttempts,
  pickBestFiveK,
  recentUploads,
  recordsForType,
  sleepByDayStage,
  typeStats,
  workoutHistory,
} from "@/db/queries";
import { AGENT_TOOLS, type AgentTool } from "@/lib/agent-tools";
import { mcpAccessFailure } from "@/lib/services/mcp";
import { ValidationError, dayField, enumField, fail, numField, readJson, str } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Numeric query inputs are validated here, not deep inside SQL, so a bad value is a 400
 * instead of a RangeError/SqliteError 500 (and `LIMIT NULL` cannot mean "unbounded"). */
const daysField = (value: unknown, fallback: number, max: number) =>
  numField(value ?? fallback, "days", { integer: true, min: 1, max }) ?? fallback;
const limitField = (value: unknown, fallback: number, max: number) =>
  numField(value ?? fallback, "limit", { integer: true, min: 1, max }) ?? fallback;
const offsetField = (value: unknown) =>
  numField(value ?? 0, "offset", { integer: true, min: 0, max: 1_000_000 }) ?? 0;

/**
 * Every handler receives the JSON body and returns a JSON-safe value. The agent plugin and the
 * UI's own writes go through the same service layer, so both validate identically.
 */
const TOOLS = {
  healthvault_context: (body: Record<string, unknown>) =>
    compactAgentContext(
      healthvaultContext(Array.isArray(body.sections) ? body.sections : undefined),
      {
        includeRawJson: body.includeRawJson === true,
        includeIngredients: body.includeIngredients === true,
      },
    ),

  profile_get: (body: Record<string, unknown>) => {
    const profile = getProfile();
    return sanitizeAgentNumbers({
      profile: compactProfile(profile, body.includeRawJson === true),
      workSchedule: workSchedule(profile),
      goal: trainingGoal(profile),
      wheyLink: parseWheyLink(profile),
      age: ageOf(profile, currentDay()),
      suggestedTargets: suggestedTargets(profile, latestMeasurement("weight")?.value ?? 75),
    });
  },
  profile_update: (body: Record<string, unknown>) => sanitizeAgentNumbers(updateProfile(body)),

  measurement_add: (body: Record<string, unknown>) => sanitizeAgentNumbers(addMeasurement(body)),
  measurement_history: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(
      measurementHistory(
        enumField(body.kind ?? "weight", "kind", KINDS, false) ?? "weight",
        daysField(body.days, 365, 3650),
      ),
    ),

  food_search: (body: Record<string, unknown>) =>
    compactFoodSearch(searchFoods(body.query, limitField(body.limit, 20, 100), offsetField(body.offset))),
  food_add: (body: Record<string, unknown>) => sanitizeAgentNumbers(addFood(body)),
  food_update: (body: Record<string, unknown>) => sanitizeAgentNumbers(updateFood(body.id, body)),

  meal_log: (body: Record<string, unknown>) => sanitizeAgentNumbers(logMeal(body)),
  meal_update: (body: Record<string, unknown>) => sanitizeAgentNumbers(updateEntry(body.id, body)),
  meal_delete: (body: Record<string, unknown>) => deleteEntry(body.id),
  meal_get: (body: Record<string, unknown>) => sanitizeAgentNumbers(getEntry(body.id)),

  nutrition_day: (body: Record<string, unknown>) =>
    compactDayNutrition(dayNutrition(dayField(body.day, "day", currentDay())), {
      includeIngredients: body.includeIngredients === true,
    }),
  nutrition_summary: (body: Record<string, unknown>) => {
    const days = daysField(body.days, 7, 366);
    const perDay = nutritionRange(
      days,
      body.endDay === undefined || body.endDay === "" ? undefined : dayField(body.endDay, "endDay"),
    );
    return sanitizeAgentNumbers({ days, targets: resolveTargets(currentDay()), perDay });
  },

  nutrition_target_set: (body: Record<string, unknown>) => sanitizeAgentNumbers(setTargets(body)),

  supplement_list: () =>
    compactSupplementList({ supplements: listSupplements(false), checklist: todayChecklist() }),
  supplement_create: (body: Record<string, unknown>) => sanitizeAgentNumbers(createSupplement(body)),
  supplement_update: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(updateSupplement(body.supplementId ?? body.id, body)),
  supplement_log: (body: Record<string, unknown>) => {
    if (Array.isArray(body.entries)) {
      return sanitizeAgentNumbers(logSupplementsBatch(body.entries, body.day));
    }
    return sanitizeAgentNumbers(logSupplement(body));
  },

  metrics_series: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(metricsSeries(body.metric, daysField(body.days, 30, 730))),
  workouts_recent: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(workoutHistory(limitField(body.limit, 10, 500))),

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

  record_types: () => sanitizeAgentNumbers(typeStats()),
  records_recent: (body: Record<string, unknown>) => {
    const type = str(body.type, "type", { required: true, max: 200 })!;
    return sanitizeAgentNumbers({ type, rows: recordsForType(type, limitField(body.limit, 50, 500)) });
  },
  uploads_recent: (body: Record<string, unknown>) => recentUploads(limitField(body.limit, 50, 500)),

  supplement_history: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(supplementHistory(daysField(body.days, 30, 366))),
  supplement_delete: (body: Record<string, unknown>) => {
    const result = deleteSupplement(body.id);
    if (!result.deleted && !result.archived) fail("supplement not found", 404);
    return result;
  },

  recipe_create: (body: Record<string, unknown>) => sanitizeAgentNumbers(createRecipe(body)),
  recipe_list: (body: Record<string, unknown>) =>
    listRecipes({
      query: body.query,
      limit: body.limit,
      offset: body.offset,
      includeArchived: body.includeArchived,
    }),
  recipe_get: (body: Record<string, unknown>) => sanitizeAgentNumbers(getRecipe(body.id ?? body.recipeId)),
  recipe_log: (body: Record<string, unknown>) => sanitizeAgentNumbers(logRecipe(body)),
  recipe_update: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(updateRecipe(body.id ?? body.recipeId, body)),
  recipe_delete: (body: Record<string, unknown>) => {
    const result = deleteRecipe(body.id ?? body.recipeId);
    if (!result.deleted && !result.archived) fail("recipe not found", 404);
    return result;
  },

  food_template_list: () => ({ templates: listFoodTemplates() }),
  food_template_apply: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(applyFoodTemplate(body.id, body.template, { overwrite: body.overwrite === true })),

  food_history_preview: (body: Record<string, unknown>) => sanitizeAgentNumbers(previewHistoryRefresh(body)),
  food_history_refresh: (body: Record<string, unknown>) => sanitizeAgentNumbers(applyHistoryRefresh(body)),

  training_block_get: () => {
    const block = currentBlock();
    return sanitizeAgentNumbers(block ? { active: true, block } : { active: false, block: null });
  },
  training_block_start: (body: Record<string, unknown>) =>
    startBlock(body.startDate, { includeStrength: body.includeStrength === true }),
  training_session_status: (body: Record<string, unknown>) =>
    setSessionStatus(body.id, body.status, body.workoutId),

  strength_log: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers({
      sets: addStrengthSets({
        day: body.day,
        exercise: body.exercise,
        sets: body.sets,
        note: body.note,
        workoutId: body.workoutId,
      }),
    }),
  strength_history: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(listStrengthSessions(daysField(body.days, 14, 366))),
  strength_progression: (body: Record<string, unknown>) => {
    const weeks = numField(body.weeks ?? 8, "weeks", { integer: true, min: 1, max: 52 }) ?? 8;
    return sanitizeAgentNumbers({
      exercise: str(body.exercise, "exercise", { required: true, max: 120 })!,
      weeks: exerciseProgression(body.exercise, weeks),
    });
  },
  strength_delete: (body: Record<string, unknown>) => {
    const result = deleteStrengthSet(body.id);
    if (!result.deleted) fail("strength set not found", 404);
    return result;
  },

  whey_log: (body: Record<string, unknown>) =>
    sanitizeAgentNumbers(
      logWhey({
        day: typeof body.day === "string" ? body.day : undefined,
        eatenAt:
          typeof body.eatenAt === "string" || typeof body.eatenAt === "number"
            ? body.eatenAt
            : undefined,
      }),
    ),
  whey_undo: (body: Record<string, unknown>) =>
    undoWhey({ day: typeof body.day === "string" ? body.day : undefined }),

  weekly_summary: (body: Record<string, unknown>) => {
    const weekOffset =
      numField(body.weekOffset ?? 0, "weekOffset", { integer: true, min: 0, max: MAX_WEEK_OFFSET }) ?? 0;
    return sanitizeAgentNumbers(weeklySummary(weekOffset));
  },
  five_k_progress: (body: Record<string, unknown>) => {
    const days = daysField(body.days, 365, 3650);
    const goal = trainingGoal(getProfile());
    const attempts = fiveKAttempts(days);
    const best = pickBestFiveK(attempts);
    return sanitizeAgentNumbers({ days, goal, best, attempts });
  },
  sleep_stages: (body: Record<string, unknown>) => {
    const days = daysField(body.days, 30, 365);
    return sanitizeAgentNumbers({ days, nights: sleepByDayStage(days) });
  },
  supplement_adherence: (body: Record<string, unknown>) => {
    const weeks = numField(body.weeks ?? 4, "weeks", { integer: true, min: 1, max: 52 }) ?? 4;
    return sanitizeAgentNumbers({ weeks, supplements: weeklyAdherence(weeks) });
  },
  recipe_preview: (body: Record<string, unknown>) => sanitizeAgentNumbers(previewRecipeServing(body)),
} satisfies Record<AgentTool, (body: Record<string, unknown>) => unknown>;

/**
 * In-process dispatch for the app's direct Streamable HTTP MCP transport. It calls the very same
 * tool map the HTTP agent API uses, so execution (and contract) cannot drift between transports.
 * Auth, Host/Origin and MCP-enablement checks stay in the route/proxy, not here.
 */
export async function dispatchAgentTool(tool: string, body: Record<string, unknown>): Promise<unknown> {
  const handler = TOOLS[tool as AgentTool];
  if (!handler) fail(`unknown tool: ${tool}`, 404);
  return handler(body);
}

export async function GET(req: Request) {
  const failure = agentRequestFailure(req);
  if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
  const access = mcpAccessFailure(req);
  if (access) return NextResponse.json({ error: access.error }, { status: access.status });
  return NextResponse.json({
    tools: AGENT_TOOLS,
    posture: "single-user; bearer token or session required; Host/Origin checked",
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ tool: string }> }) {
  const failure = agentRequestFailure(req);
  if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
  const access = mcpAccessFailure(req);
  if (access) return NextResponse.json({ error: access.error }, { status: access.status });

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
