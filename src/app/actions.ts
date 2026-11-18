"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DEFAULT_TIMEZONE, isDay, localDay, localTimeMs } from "@/lib/day";
import { requireSession } from "@/lib/auth";
import { fail, ValidationError } from "@/lib/validate";
import { DEFAULT_WHEY_GRAMS, getProfile, getTimezone, updateProfile } from "@/lib/services/profile";
import {
  addMeasurement,
  deleteMeasurement as removeMeasurement,
} from "@/lib/services/measurements";
import {
  addFood,
  copyDay,
  deleteEntry,
  deleteFood,
  getEntry,
  getFood,
  listFoods,
  logMeal,
  logRecipe,
  setTargets,
  updateEntry,
  updateFood,
} from "@/lib/services/nutrition";
import {
  createRecipe,
  deleteRecipe,
  previewRecipeServing,
  updateRecipe,
} from "@/lib/services/recipes";
import { applyHistoryRefresh, previewHistoryRefresh } from "@/lib/services/food-history";
import { listEntryRevisionSummaries, type EntryRevisionSummary } from "@/lib/services/food-log-snapshots";
import {
  foodExtraWithEstimated,
  parseFoodExtra,
  parseMeasureRows,
} from "@/lib/foods-ui";
import type {
  RecipeFoodOption,
  RecipeLogState,
  RecipePreviewResult,
} from "@/lib/recipes-ui";
import {
  createSupplement,
  deleteSupplement,
  logSupplement,
  updateSupplement,
} from "@/lib/services/supplements";
import { setSessionStatus, startBlock } from "@/lib/services/training-plan";
import { addStrengthSets } from "@/lib/services/strength";
import { logWhey, undoWhey } from "@/lib/services/whey";
import { resolveUnits, toCanonicalWeight } from "@/lib/units";
import type {
  ActionState,
  CorrectionApplyState,
  CorrectionPreviewState,
  FoodFormState,
  RecipeDeleteState,
  RecipeFormState,
} from "@/lib/action-state";

function text(fd: FormData, key: string): string | null {
  const value = fd.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function checked(fd: FormData, key: string): boolean {
  return fd.get(key) === "on" || fd.get(key) === "true" || fd.get(key) === "1";
}

function messageOf(error: unknown): string {
  if (error instanceof ValidationError || error instanceof Error) return error.message;
  return "Something went wrong";
}

/** "mm:ss" from the goal input. Returns `undefined` when the text is not a clock. */
function goalSecondsOf(value: string | null): number | undefined {
  if (value === null) return undefined;
  const match = value.match(/^(\d{1,3}):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function failed(error: unknown): ActionState {
  return { ok: false, error: messageOf(error) };
}

/** Revalidate a parent path and its focused subviews together, so writes made from a subview
 *  (Targets, Plan, Strength, Regimens, History, Measurements) refresh where they were made. */
function refresh(...paths: string[]) {
  const all = new Set(paths);
  const subviews: Record<string, readonly string[]> = {
    "/nutrition": ["/nutrition/targets"],
    "/training": ["/training/plan", "/training/strength"],
    "/supplements": ["/supplements/regimens", "/supplements/history"],
    "/profile": ["/measurements"],
  };
  for (const path of paths) for (const child of subviews[path] ?? []) all.add(child);
  for (const path of all) revalidatePath(path);
}

/* ---------------------------------------------------------------------------------------------
 * Profile and measurements
 * ------------------------------------------------------------------------------------------- */

export async function saveProfileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    // Blank means the default sub-30:00 goal; malformed text is an error, never a silent default.
    let goal: { type: "run5k"; targetSeconds: number } | null | undefined;
    if (fd.has("goalTime")) {
      const raw = text(fd, "goalTime");
      if (raw === null) {
        goal = null;
      } else {
        const seconds = goalSecondsOf(raw);
        if (seconds === undefined) return { ok: false, error: "5K goal time must be mm:ss" };
        goal = { type: "run5k", targetSeconds: seconds };
      }
    }
    updateProfile({
      name: text(fd, "name"),
      birthDate: text(fd, "birthDate"),
      sex: text(fd, "sex"),
      heightCm: text(fd, "heightCm"),
      timezone: text(fd, "timezone") ?? DEFAULT_TIMEZONE,
      units: text(fd, "units") ?? "metric",
      goalWeightKg: text(fd, "goalWeightKg"),
      goalsNote: text(fd, "goalsNote"),
      dietNote: text(fd, "dietNote"),
      activityNote: text(fd, "activityNote"),
      ...(goal === undefined ? {} : { goal }),
    });
    refresh("/profile", "/", "/nutrition", "/training");
    return { ok: true, message: "Saved" };
  } catch (error) {
    return failed(error);
  }
}

export async function saveWorkScheduleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const days: { weekday: number; start: string; end: string }[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      if (!checked(fd, `enabled-${weekday}`)) continue;
      const start = text(fd, `start-${weekday}`) ?? "09:00";
      const end = text(fd, `end-${weekday}`) ?? "17:00";
      if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
        return { ok: false, error: "Times must use HH:MM" };
      }
      days.push({ weekday, start, end });
    }
    const note = text(fd, "scheduleNote");
    updateProfile({ workSchedule: { days, ...(note ? { note } : {}) } });
    refresh("/profile", "/");
    return { ok: true, message: days.length ? "Saved" : "Schedule cleared" };
  } catch (error) {
    return failed(error);
  }
}

export async function addMeasurementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const tz = getTimezone();
    const day = text(fd, "day");
    const time = text(fd, "time");
    const takenAt = isDay(day)
      ? localTimeMs(day, time && /^\d{2}:\d{2}$/.test(time) ? time : "12:00", tz)
      : undefined;
    addMeasurement({
      kind: text(fd, "kind") ?? "weight",
      value: text(fd, "value"),
      unit: text(fd, "unit") ?? undefined,
      ...(isDay(day) ? { day } : {}),
      ...(takenAt === undefined ? {} : { takenAt }),
      note: text(fd, "note"),
    });
    refresh("/profile", "/", "/nutrition");
    return { ok: true, message: "Logged" };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteMeasurementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    removeMeasurement(text(fd, "id"));
    refresh("/profile", "/");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------------------------------------
 * Nutrition
 * ------------------------------------------------------------------------------------------- */

function entryMacros(fd: FormData) {
  return {
    kcal: text(fd, "kcal") ?? "0",
    proteinG: text(fd, "proteinG") ?? "0",
    carbsG: text(fd, "carbsG") ?? "0",
    fatG: text(fd, "fatG") ?? "0",
    fibreG: text(fd, "fibreG") ?? "0",
    sodiumMg: text(fd, "sodiumMg") ?? "0",
  };
}

export async function logQuickMealAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    logMeal({
      day: text(fd, "day"),
      meal: text(fd, "meal"),
      entries: [
        {
          name: text(fd, "name"),
          grams: text(fd, "grams") ?? "100",
          ...entryMacros(fd),
          estimated: checked(fd, "estimated"),
        },
      ],
    });
    refresh("/nutrition", "/");
    return { ok: true, message: "Added" };
  } catch (error) {
    return failed(error);
  }
}

export async function logFoodAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    logMeal({
      day: text(fd, "day"),
      meal: text(fd, "meal"),
      entries: [{ foodId: text(fd, "foodId"), grams: text(fd, "grams") ?? "100" }],
    });
    refresh("/nutrition", "/");
    return { ok: true, message: "Added" };
  } catch (error) {
    return failed(error);
  }
}

export async function addFoodAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    addFood({
      name: text(fd, "name"),
      brand: text(fd, "brand"),
      servingGrams: text(fd, "servingGrams") ?? "100",
      per100g: entryMacros(fd),
    });
    refresh("/nutrition");
    return { ok: true, message: "Food saved" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Create or edit one saved food from the library form (the presence of `id` decides which).
 *
 * Every visible field is sent, so an edit carries the values the user saw; omitted optional
 * macros are left out of `per100g` rather than sent as zero, and `updateFood` preserves them.
 * The estimate marker is merged into `extra_json`, not written over the rest of the metadata.
 * Saving a definition never rewrites an already-logged meal.
 */
export async function saveFoodAction(_prev: FoodFormState, fd: FormData): Promise<FoodFormState> {
  try {
    await requireSession();
    const id = text(fd, "id");
    const kcal = text(fd, "kcal");
    if (kcal === null) return { ok: false, error: "kcal / 100 g is required" };

    const per100g: Record<string, string> = { kcal };
    for (const key of ["proteinG", "carbsG", "fatG", "fibreG", "sodiumMg"]) {
      const value = text(fd, key);
      if (value !== null) per100g[key] = value;
    }

    const measures = parseMeasureRows(fd.getAll("measureName"), fd.getAll("measureGrams"));
    const servingGrams = text(fd, "servingGrams");
    const estimated = checked(fd, "estimated");
    const sourceInput = text(fd, "source") ?? undefined;
    // "estimated" is a confidence marker, not a provenance source. Unchecking the marker must
    // actually clear it, even on a legacy row whose source was stored as "estimated".
    const source = !estimated && sourceInput === "estimated" ? "manual" : sourceInput;
    const name = text(fd, "name");
    const brand = text(fd, "brand");
    const input: Record<string, unknown> = {
      name,
      brand,
      barcode: text(fd, "barcode"),
      per100g,
      state: text(fd, "state") ?? undefined,
      yieldFactor: text(fd, "yieldFactor") ?? undefined,
      // An empty editor explicitly clears the per-food overrides; the shared defaults remain.
      measures: Object.keys(measures).length > 0 ? measures : null,
      source,
      sourceUrl: text(fd, "sourceUrl"),
      sourceDate: text(fd, "sourceDate"),
      ...(servingGrams === null ? {} : { servingGrams }),
    };

    if (id) {
      const existing = getFood(id);
      const wasEstimated = checked(fd, "estimatedInitial");
      const existingExtra = parseFoodExtra(existing.extraJson);
      // A source of "estimated" already carries the marker; only add `extra.estimated` when the
      // source does not. Unchecking clears the marker. An unchanged save leaves extra_json alone.
      const needsMarker = estimated && source !== "estimated" && existingExtra.estimated !== true;
      const mustClear = !estimated && wasEstimated;
      if (needsMarker || mustClear) {
        const mergedExtra = foodExtraWithEstimated(existing.extraJson, estimated);
        input.extra = Object.keys(mergedExtra).length > 0 ? mergedExtra : null;
      }
      const food = updateFood(id, input);
      refresh("/nutrition/foods", "/nutrition", "/");
      return { ok: true, message: "Saved", foodId: food.id, mode: "update" };
    }

    // `addFood` is an upsert on (name, brand). A library "create" must not silently overwrite
    // another saved food, so point the user at the existing row instead.
    if (name !== null) {
      const duplicate = listFoods({ query: name, limit: 100 }).items.find(
        (food) => food.name === name && (food.brand ?? null) === brand,
      );
      if (duplicate) {
        return {
          ok: false,
          error: `${name}${brand ? ` (${brand})` : ""} already exists — edit it from the list.`,
          foodId: duplicate.id,
        };
      }
    }

    if (estimated) input.extra = { estimated: true };
    const food = addFood(input);
    refresh("/nutrition/foods", "/nutrition", "/");
    return { ok: true, message: "Food saved", foodId: food.id, mode: "create" };
  } catch (error) {
    return failed(error);
  }
}

/** Permanent removal. `deleteFood` refuses referenced rows with a plain-language 409 message. */
export async function deleteFoodAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const result = deleteFood(text(fd, "id"));
    refresh("/nutrition/foods", "/nutrition", "/");
    return result.deleted ? { ok: true, message: "Deleted" } : { ok: false, error: "food not found" };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------------------------------------
 * Recipes
 * ------------------------------------------------------------------------------------------- */

/** Parse a JSON array from a hidden field; a malformed value is a form error, not a crash. */
function jsonArrayField(fd: FormData, key: string): unknown[] {
  const raw = text(fd, key);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new ValidationError(`${key} must be a JSON array`);
    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`${key} must be valid JSON`);
  }
}

/**
 * Create or edit a recipe. The editor sends its ingredient rows as JSON; `createRecipe` /
 * `updateRecipe` re-resolve every food, measure and macro server-side. Omitting `id` creates.
 */
export async function saveRecipeAction(
  _prev: RecipeFormState,
  fd: FormData,
): Promise<RecipeFormState> {
  try {
    await requireSession();
    const id = text(fd, "id");
    const input = {
      name: text(fd, "name"),
      servings: text(fd, "servings") ?? "2",
      note: text(fd, "note"),
      ingredients: jsonArrayField(fd, "ingredients"),
    };
    const recipe = id ? updateRecipe(id, input) : createRecipe(input);
    // A recipe edit only changes future logs; already-logged servings keep their snapshots.
    refresh("/nutrition/recipes", `/nutrition/recipes/${recipe.id}`, "/nutrition", "/");
    return {
      ok: true,
      message: id ? "Recipe updated" : "Recipe saved",
      recipeId: recipe.id,
      mode: id ? "update" : "create",
    };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Remove a recipe. The service deletes an unreferenced recipe and archives one that logged
 * history references, so the message reports which happened instead of claiming a deletion.
 */
export async function deleteRecipeAction(
  _prev: RecipeDeleteState,
  fd: FormData,
): Promise<RecipeDeleteState> {
  let outcome: RecipeDeleteState = { ok: false, error: "Recipe not found" };
  let navigate: string | null = null;
  try {
    await requireSession();
    const id = text(fd, "id");
    const result = deleteRecipe(id);
    refresh("/nutrition/recipes", "/nutrition", "/");
    if (result.deleted) {
      outcome = { ok: true, message: "Deleted", deleted: true, archived: false };
    } else if (result.archived) {
      outcome = {
        ok: true,
        message: "Archived — logged meals stay intact",
        deleted: false,
        archived: true,
      };
    } else {
      return outcome;
    }

    // The detail page passes a fixed internal return path. Navigating on the server keeps the
    // request from re-rendering a just-deleted detail route as a 404 before the client can leave.
    if (text(fd, "returnTo") === "/nutrition/recipes") {
      navigate = `/nutrition/recipes?recipe=${result.deleted ? "deleted" : "archived"}`;
    }
  } catch (error) {
    return failed(error);
  }
  // `redirect` throws a framework control-flow error, so it stays outside the try/catch.
  if (navigate !== null) redirect(navigate);
  return outcome;
}

/** Read-only preview; nothing is written, so it is safe to call on every editor change. */
export async function previewRecipeServingAction(
  input: Record<string, unknown>,
): Promise<RecipePreviewResult> {
  try {
    await requireSession();
    return { ok: true, preview: previewRecipeServing(input) };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Server-backed food search for the recipe ingredient picker (bounded to 20 rows). */
export async function searchRecipeFoodsAction(
  query: string,
): Promise<{ ok: true; items: RecipeFoodOption[] } | { ok: false; error: string }> {
  try {
    await requireSession();
    const result = listFoods({ query, limit: 20 });
    return {
      ok: true,
      items: result.items.map((food) => ({
        id: food.id,
        name: food.name,
        brand: food.brand,
        servingGrams: food.servingGrams,
        state: food.state,
        yieldFactor: food.yieldFactor,
        measures: food.measures,
      })),
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * Log one serving through the existing `logRecipe` service. Overrides are optional; when any are
 * present the caller must choose `amountBasis` explicitly (whole batch or one serving), and the
 * saved recipe is never modified.
 */
export async function logRecipeAction(
  _prev: RecipeLogState,
  fd: FormData,
): Promise<RecipeLogState> {
  try {
    await requireSession();
    const recipeId = text(fd, "recipeId");
    const overrides = jsonArrayField(fd, "ingredientOverrides");
    const amountBasis = text(fd, "amountBasis");
    if (overrides.length > 0 && amountBasis === null) {
      return {
        ok: false,
        error: "Choose how to apply the overrides: whole batch or one serving",
      };
    }

    const day = text(fd, "day");
    const time = text(fd, "time");
    let eatenAt: number | undefined;
    if (time !== null) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        return { ok: false, error: "Eaten time must be HH:MM" };
      }
      if (day === null || !isDay(day)) return { ok: false, error: "Day must be YYYY-MM-DD" };
      eatenAt = localTimeMs(day, time, getTimezone());
    }

    const result = logRecipe({
      recipeId,
      day,
      meal: text(fd, "meal"),
      servingNo: text(fd, "servingNo"),
      servingFraction: text(fd, "servingFraction") ?? "1",
      ...(eatenAt === undefined ? {} : { eatenAt }),
      ...(overrides.length > 0 ? { ingredientOverrides: overrides, amountBasis } : {}),
    });
    refresh("/nutrition", "/nutrition/recipes", `/nutrition/recipes/${result.recipeId}`, "/");
    return {
      ok: true,
      message: result.incomplete
        ? "Logged — some ingredients have unknown nutrition"
        : "Logged",
      day: result.day,
      entryId: result.entry.id,
      servingNo: result.servingNo,
    };
  } catch (error) {
    return failed(error);
  }
}


export async function updateEntryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const macros = entryMacros(fd);
    const grams = text(fd, "grams");
    // If the macro boxes were left untouched, send only grams so the service scales the
    // stored snapshot proportionally instead of keeping stale calories.
    const unchanged = ["kcal", "proteinG", "carbsG", "fatG", "fibreG", "sodiumMg"].every(
      (key) => Number(macros[key as keyof typeof macros]) === Number(text(fd, `old-${key}`)),
    );
    updateEntry(text(fd, "id"), {
      meal: text(fd, "meal"),
      name: text(fd, "name"),
      grams,
      ...(unchanged ? {} : entryMacros(fd)),
      estimated: checked(fd, "estimated"),
    });
    refresh("/nutrition", "/");
    return { ok: true, message: "Saved" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Portion-only edit for a logged recipe entry.
 *
 * The recipe service rescales the stored per-serving snapshot and every recorded ingredient in
 * one transaction, so the aggregate macros can never drift from the ingredients. Macros are
 * deliberately not accepted here: on a complete snapshot they are derived, and `updateEntry`
 * refuses them with its own explanation.
 */
export async function updatePortionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const id = text(fd, "id");
    if (id === null) return { ok: false, error: "Entry id is required" };
    const servingFraction = text(fd, "servingFraction");
    if (servingFraction === null) return { ok: false, error: "Portion is required" };
    const servingNo = text(fd, "servingNo");
    const existing = getEntry(id);
    const currentFraction =
      existing.servingFraction && existing.servingFraction > 0 ? existing.servingFraction : 1;
    // A non-numeric value is forwarded so the service reports it, rather than being dropped as
    // "unchanged" and leaving the user believing the portion was saved.
    const parsed = Number(servingFraction);
    const fractionChanged =
      !Number.isFinite(parsed) || Math.abs(parsed - currentFraction) > 1e-9;
    const servingChanged =
      servingNo !== null && Number(servingNo) !== (existing.servingNo ?? null);
    updateEntry(id, {
      meal: text(fd, "meal"),
      // Only send what actually changed: an unchanged portion must not write a
      // `serving_rescale` revision claiming the entry was corrected.
      ...(fractionChanged ? { servingFraction } : {}),
      ...(servingChanged ? { servingNo } : {}),
    });
    refresh("/nutrition", "/");
    return { ok: true, message: fractionChanged ? "Portion updated" : "Saved" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Explicit totals edit for a legacy aggregate-only recipe entry.
 *
 * Such a row has no recorded per-serving arithmetic and no ingredient rows, so the service
 * permits an explicit grams+macros edit but refuses a portion rescale. All six macros are always
 * sent (`updateEntryAction` would optimise a grams-only change into exactly the rescale that is
 * refused here), which keeps this path honest: the user is editing this entry's totals.
 */
export async function updateLegacyEntryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const grams = text(fd, "grams");
    if (grams === null) return { ok: false, error: "Grams are required" };
    updateEntry(text(fd, "id"), {
      meal: text(fd, "meal"),
      name: text(fd, "name"),
      grams,
      ...entryMacros(fd),
      estimated: checked(fd, "estimated"),
    });
    refresh("/nutrition", "/");
    return { ok: true, message: "Saved" };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteEntryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    deleteEntry(text(fd, "id"));
    refresh("/nutrition", "/");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function copyDayAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const result = copyDay(text(fd, "fromDay") ?? "", text(fd, "toDay") ?? "");
    refresh("/nutrition", "/");
    if (result.copied === 0) {
      return { ok: true, message: "Already present — nothing copied" };
    }
    return {
      ok: true,
      message: result.copied === 1 ? "Copied 1 entry" : `Copied ${result.copied} entries`,
    };
  } catch (error) {
    return failed(error);
  }
}

export async function setTargetsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    setTargets({
      effectiveFrom: text(fd, "effectiveFrom") ?? localDay(Date.now(), getTimezone()),
      kcal: text(fd, "kcal"),
      proteinG: text(fd, "proteinG") ?? "0",
      carbsG: text(fd, "carbsG") ?? "0",
      fatG: text(fd, "fatG") ?? "0",
      fibreG: text(fd, "fibreG") ?? "0",
      sodiumMg: text(fd, "sodiumMg") ?? "0",
    });
    refresh("/nutrition", "/");
    return { ok: true, message: "Targets saved" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Read-only audit trail for one logged entry: the service's `listEntryRevisions`, newest first.
 *
 * The day view ships a compact "corrected N times" indicator; expanding it reads the rows from
 * the revision table itself, so the reasons and timestamps cannot drift from the audit log.
 */
export async function entryRevisionsAction(
  foodLogId: number,
): Promise<{ ok: true; revisions: EntryRevisionSummary[] } | { ok: false; error: string }> {
  try {
    await requireSession();
    return {
      ok: true,
      revisions: listEntryRevisionSummaries(foodLogId),
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/* ---------------------------------------------------------------------------------------------
 * Past-meal corrections
 * ------------------------------------------------------------------------------------------- */

/** Accepts one id or a comma/space separated list, so a single input can carry the whole scope. */
function idListField(fd: FormData, key: string): string[] {
  const values = fd
    .getAll(key)
    .flatMap((value) => String(value).split(/[,\s]+/))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return [...new Set(values)];
}

/**
 * The correction scope from the form. Ids are validated here so a typo reports which field is
 * wrong instead of surfacing a positional service message like `entryIds[1] must be a number`.
 */
function correctionScope(fd: FormData): {
  foodIds: number[];
  entryIds: number[];
  fromDay?: string;
  toDay?: string;
} {
  const ids = (key: string): number[] =>
    idListField(fd, key).map((value) => {
      const id = Number(value);
      if (!Number.isInteger(id) || id < 1) {
        fail(`${key === "foodIds" ? "Food" : "Entry"} ids must be whole numbers (got "${value}")`);
      }
      return id;
    });
  const fromDay = text(fd, "fromDay");
  const toDay = text(fd, "toDay");
  return {
    foodIds: ids("foodIds"),
    entryIds: ids("entryIds"),
    ...(fromDay === null ? {} : { fromDay }),
    ...(toDay === null ? {} : { toDay }),
  };
}

/**
 * Read-only history preview. Nothing is written: the service resolves each affected snapshot and
 * hashes the exact change set, which the apply step must echo back verbatim.
 */
export async function previewCorrectionsAction(
  fd: FormData,
): Promise<CorrectionPreviewState> {
  try {
    await requireSession();
    return { ok: true, preview: previewHistoryRefresh(correctionScope(fd)) };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * Apply exactly the preview the user saw.
 *
 * The hash comes from a hidden field and the scope from the same form, so a changed food id or
 * date range produces a different change set and the service rejects it as stale (409) instead
 * of writing rows nobody looked at. Nothing outside the stated scope changes.
 */
export async function applyCorrectionsAction(
  _prev: CorrectionApplyState,
  fd: FormData,
): Promise<CorrectionApplyState> {
  try {
    await requireSession();
    const previewHash = text(fd, "previewHash");
    if (previewHash === null) {
      return { ok: false, error: "Run Preview first — applying needs the change set you saw" };
    }
    if (!checked(fd, "confirmScope")) {
      return { ok: false, error: "Confirm the scope before applying" };
    }
    const result = applyHistoryRefresh({
      ...correctionScope(fd),
      previewHash,
    });
    refresh("/nutrition/corrections", "/nutrition", "/");
    const parts = [
      result.applied === 1 ? "Corrected 1 snapshot" : `Corrected ${result.applied} snapshots`,
      result.entriesTouched === 1 ? "1 entry" : `${result.entriesTouched} entries`,
      result.revisions === 1 ? "1 revision recorded" : `${result.revisions} revisions recorded`,
    ];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    return {
      ok: true,
      message: parts.join(" · "),
      applied: result.applied,
      entriesTouched: result.entriesTouched,
      revisions: result.revisions,
      skipped: result.skipped,
    };
  } catch (error) {
    const message = messageOf(error);
    // A 409 here means the data moved under the preview. Say so plainly so the screen can
    // re-run the preview instead of pretending the apply worked.
    if (error instanceof ValidationError && error.status === 409) {
      return { ok: false, error: message, stale: true };
    }
    return { ok: false, error: message };
  }
}

/* ---------------------------------------------------------------------------------------------
 * Supplements
 * ------------------------------------------------------------------------------------------- */

export async function toggleSupplementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    logSupplement({
      supplementId: text(fd, "supplementId"),
      day: text(fd, "day") ?? undefined,
      taken: checked(fd, "taken"),
    });
    refresh("/supplements", "/");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

function scheduleOf(fd: FormData) {
  const time = text(fd, "time");
  const days = fd
    .getAll("days")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
  return { time: time && /^\d{2}:\d{2}$/.test(time) ? time : null, days: days.length ? days : null };
}

export async function saveSupplementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const id = text(fd, "id");
    const input = {
      name: text(fd, "name"),
      dose: text(fd, "dose") ?? "1",
      unit: text(fd, "unit") ?? "capsule",
      schedule: scheduleOf(fd),
      notes: text(fd, "notes"),
      active: fd.has("active") ? checked(fd, "active") : true,
    };
    if (id) updateSupplement(id, input);
    else createSupplement(input);
    refresh("/supplements", "/");
    return { ok: true, message: id ? "Saved" : "Added" };
  } catch (error) {
    return failed(error);
  }
}

export async function archiveSupplementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const result = deleteSupplement(text(fd, "id"));
    refresh("/supplements", "/");
    return { ok: true, message: result.archived ? "Archived (history kept)" : "Removed" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Save or clear the one-tap whey target. Grams default to one 32.4 g scoop, and the profile
 * parser rejects a food or supplement id that does not exist.
 */
export async function saveWheyLinkAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    if (checked(fd, "clear")) {
      updateProfile({ wheyLink: null });
      refresh("/supplements", "/", "/nutrition");
      return { ok: true, message: "Removed" };
    }
    updateProfile({
      wheyLink: {
        foodId: text(fd, "foodId"),
        supplementId: text(fd, "supplementId"),
        grams: text(fd, "grams") ?? DEFAULT_WHEY_GRAMS,
        meal: text(fd, "meal") ?? "snack",
      },
    });
    refresh("/supplements", "/", "/nutrition");
    return { ok: true, message: "Saved" };
  } catch (error) {
    return failed(error);
  }
}

export async function logWheyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const result = logWhey({ day: text(fd, "day") });
    refresh("/supplements", "/nutrition", "/");
    return { ok: true, message: `Logged ${result.entry.name}` };
  } catch (error) {
    return failed(error);
  }
}

export async function undoWheyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const result = undoWhey({ day: text(fd, "day") });
    refresh("/supplements", "/nutrition", "/");
    return { ok: true, message: result.undone ? "Undone" : "Nothing to undo" };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------------------------------------
 * Training block
 * ------------------------------------------------------------------------------------------- */

export async function startTrainingBlockAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const result = startBlock(text(fd, "startDate"), {
      includeStrength: checked(fd, "includeStrength"),
    });
    refresh("/training");
    return {
      ok: true,
      message: `Started ${result.weeks}-week block · ${result.sessions} sessions`,
    };
  } catch (error) {
    return failed(error);
  }
}

export async function setSessionStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const status = text(fd, "status");
    setSessionStatus(text(fd, "id"), status, text(fd, "workoutId") ?? undefined);
    refresh("/training");
    if (status === "done") return { ok: true, message: "Marked done" };
    if (status === "skipped") return { ok: true, message: "Marked skipped" };
    return { ok: true, message: "Reopened" };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------------------------------------
 * Strength log
 * ------------------------------------------------------------------------------------------- */

/**
 * The form repeats `reps` and `loadKg` inputs, one pair per set. A load typed in the profile's
 * display unit is converted to canonical kg here; the service only ever sees kg.
 */
export async function logStrengthSetsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await requireSession();
    const units = resolveUnits(getProfile().units);
    const reps = fd.getAll("reps").map(String);
    const loads = fd.getAll("loadKg").map(String);
    const sets = reps.map((rawReps, index) => {
      const rawLoad = loads[index] ?? "";
      let loadKg: number | string | null = null;
      if (rawLoad.trim() !== "") {
        const parsed = Number(rawLoad);
        // Leave unparsable text for the service to reject with its own message.
        loadKg = Number.isFinite(parsed) ? toCanonicalWeight(parsed, units) : rawLoad;
      }
      return { reps: rawReps.trim() === "" ? null : rawReps, loadKg };
    });

    const rows = addStrengthSets({
      day: text(fd, "day"),
      exercise: text(fd, "exercise"),
      sets,
      note: text(fd, "note"),
      workoutId: text(fd, "workoutId"),
    });
    refresh("/training", "/");
    return { ok: true, message: rows.length === 1 ? "Logged 1 set" : `Logged ${rows.length} sets` };
  } catch (error) {
    return failed(error);
  }
}
