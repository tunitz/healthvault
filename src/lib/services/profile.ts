import { eq } from "drizzle-orm";
import { db } from "@/db";
import { foods, profile, supplements } from "@/db/schema";
import { resolveDefaultTimezone } from "@/lib/day";
import { enumField, fail, jsonField, idField, numField, str, timezoneField } from "@/lib/validate";

export type Profile = typeof profile.$inferSelect;

const SEXES = ["male", "female", "other"] as const;
export const UNITS = ["metric", "imperial"] as const;

/* Training goal ------------------------------------------------------------------------------ */

export const GOAL_TYPES = ["run5k"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/** Sub-30:00 is the north-star goal; the default is the goal itself, not a placeholder record. */
export const DEFAULT_GOAL_SECONDS = 1800;
/** 20:00–59:59. Outside that range a "5K goal" is not a running target worth planning around. */
export const MIN_GOAL_SECONDS = 1200;
export const MAX_GOAL_SECONDS = 3599;

export type TrainingGoal = {
  type: GoalType;
  targetSeconds: number;
  /** Derived, never stored: 5 km honour-system pace. */
  targetPaceMinPerKm: number;
  /** False when the profile has no stored goal, so the caller can tell a default from a choice. */
  configured: boolean;
};

/**
 * A field the form left blank means "use the default", never numeric zero. `numField` returns
 * null for an empty value, and `Math.round(null)` would store an invalid `targetSeconds: 0`.
 * Only an absent value defaults — `0`, `"0"` and `false` are still validated and rejected.
 */
function absent(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * Strict numeric read for stored JSON: numbers and numeric strings only. `Number(true)` is 1 and
 * `Number(null)` is 0, so a bare `Number(...)` would turn a corrupt row into a plausible value.
 */
function storedNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function goalSeconds(targetSeconds: unknown): number {
  const seconds = numField(absent(targetSeconds) ? DEFAULT_GOAL_SECONDS : targetSeconds, "goal.targetSeconds", {
    min: MIN_GOAL_SECONDS,
    max: MAX_GOAL_SECONDS,
  });
  // `numField` only returns null for an absent value, which the default above rules out.
  if (seconds === null) fail("goal.targetSeconds is required");
  return Math.round(seconds);
}

/** Parse a goal input (object or JSON string) into the stored JSON form. */
function goalFromInput(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    // A blank form field clears the goal rather than failing JSON.parse.
    if (absent(value)) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      fail("goal must be an object or JSON string");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("goal must be an object");
  const input = parsed as Record<string, unknown>;
  // A blank `type` stays an explicit error (only an absent value defaults), so an empty string
  // from a caller can never be silently saved as a different meaning.
  const type = enumField(input.type ?? "run5k", "goal.type", GOAL_TYPES) ?? "run5k";
  return JSON.stringify({ type, targetSeconds: goalSeconds(input.targetSeconds) });
}

/** The stored training goal, with the sub-30:00 default when none was saved. */
export function trainingGoal(p: Profile): TrainingGoal {
  const fallback: TrainingGoal = {
    type: "run5k",
    targetSeconds: DEFAULT_GOAL_SECONDS,
    targetPaceMinPerKm: DEFAULT_GOAL_SECONDS / 300,
    configured: false,
  };
  if (!p.goalJson) return fallback;
  try {
    const parsed = JSON.parse(p.goalJson) as { type?: unknown; targetSeconds?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    if (!(GOAL_TYPES as readonly string[]).includes(String(parsed.type))) return fallback;
    const seconds = storedNumber(parsed.targetSeconds);
    if (seconds === null || !Number.isInteger(seconds) || seconds < MIN_GOAL_SECONDS || seconds > MAX_GOAL_SECONDS) {
      return fallback;
    }
    return {
      type: parsed.type as GoalType,
      targetSeconds: seconds,
      targetPaceMinPerKm: seconds / 300,
      configured: true,
    };
  } catch {
    return fallback;
  }
}

/* One-tap whey link -------------------------------------------------------------------------- */

/**
 * Mirrors `nutrition.MEALS`, kept local because the nutrition service imports this module
 * (a value import back would be a cycle). Both sides must stay in sync.
 */
const WHEY_MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type WheyMeal = (typeof WHEY_MEALS)[number];

/** One scoop of the saved whey food, as recorded in the real log. */
export const DEFAULT_WHEY_GRAMS = 32.4;

export type WheyLink = {
  foodId: number;
  supplementId: number | null;
  grams: number;
  meal: WheyMeal;
};

function wheyLinkFromInput(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    // A blank form field clears the link rather than failing JSON.parse.
    if (absent(value)) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      fail("wheyLink must be an object or JSON string");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("wheyLink must be an object");
  const input = parsed as Record<string, unknown>;

  const foodId = idField(input.foodId, "wheyLink.foodId");
  if (!db.select({ id: foods.id }).from(foods).where(eq(foods.id, foodId)).get()) {
    fail("wheyLink.foodId does not match a saved food", 404);
  }
  const supplementId = absent(input.supplementId) ? null : idField(input.supplementId, "wheyLink.supplementId");
  if (supplementId !== null && !db.select({ id: supplements.id }).from(supplements).where(eq(supplements.id, supplementId)).get()) {
    fail("wheyLink.supplementId does not match a supplement", 404);
  }
  // A blank grams field means one scoop; it must never be stored as null/zero.
  const grams = numField(absent(input.grams) ? DEFAULT_WHEY_GRAMS : input.grams, "wheyLink.grams", {
    min: 0.1,
    max: 5000,
  });
  if (grams === null) fail("wheyLink.grams is required");
  const meal = enumField(input.meal ?? "snack", "wheyLink.meal", WHEY_MEALS) ?? "snack";
  return JSON.stringify({ foodId, supplementId, grams, meal });
}

/** The stored one-tap whey link, or null when it was never configured (or is unreadable). */
export function parseWheyLink(p: Profile): WheyLink | null {
  if (!p.wheyLinkJson) return null;
  try {
    const parsed = JSON.parse(p.wheyLinkJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const foodId = storedNumber(parsed.foodId);
    if (foodId === null || !Number.isInteger(foodId) || foodId < 1) return null;
    const grams = storedNumber(parsed.grams);
    // Mirror the write bounds, so a corrupt/oversized row is unconfigured rather than logged.
    if (grams === null || grams < 0.1 || grams > 5000) return null;
    const meal = (WHEY_MEALS as readonly string[]).includes(String(parsed.meal))
      ? (parsed.meal as WheyMeal)
      : "snack";
    const supplementId = storedNumber(parsed.supplementId);
    return {
      foodId,
      supplementId: supplementId !== null && Number.isInteger(supplementId) && supplementId >= 1 ? supplementId : null,
      grams,
      meal,
    };
  } catch {
    return null;
  }
}

function row(): Profile | undefined {
  return db.select().from(profile).where(eq(profile.id, 1)).get();
}

/** The singleton row, created empty on first access so callers never handle `undefined`. */
export function getProfile(): Profile {
  const existing = row();
  if (existing) return existing;
  const now = Date.now();
  db.insert(profile)
    .values({ id: 1, timezone: resolveDefaultTimezone(), units: "metric", createdAtMs: now, updatedAtMs: now })
    .onConflictDoNothing()
    .run();
  return row()!;
}

export function getTimezone(): string {
  return getProfile().timezone || resolveDefaultTimezone();
}

/** True when a profile has enough for age/height-based suggestions. */
export function isProfileStarted(p: Profile = getProfile()): boolean {
  return Boolean(p.birthDate || p.heightCm || p.sex || p.name);
}

export function ageOf(p: Profile, today?: string): number | null {
  if (!p.birthDate) return null;
  const birth = new Date(`${p.birthDate}T12:00:00Z`);
  const now = today ? new Date(`${today}T12:00:00Z`) : new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Resolve the two accepted spellings of one JSON column (`goal` / `goalJson`,
 * `wheyLink` / `wheyLinkJson`). Callers send one or the other; when a body contains both they
 * must normalise to the same stored value. Conflicting values are rejected rather than letting
 * one silently win, so a request can never store the opposite of what it asked for.
 * A key set to `undefined` counts as not supplied (JS callers, unlike JSON bodies, can send it),
 * which also stops `{ goal: {...}, goalJson: undefined }` from clearing `goal_json`.
 * Returns `undefined` when neither key carries a value (leave the column alone).
 */
function resolveAlias(
  input: Record<string, unknown>,
  plainKey: string,
  jsonKey: string,
  parse: (value: unknown) => string | null,
  label: string,
): string | null | undefined {
  const hasPlain = plainKey in input && input[plainKey] !== undefined;
  const hasJson = jsonKey in input && input[jsonKey] !== undefined;
  if (!hasPlain && !hasJson) return undefined;
  const fromPlain = hasPlain ? parse(input[plainKey]) : undefined;
  const fromJson = hasJson ? parse(input[jsonKey]) : undefined;
  if (hasPlain && hasJson && fromPlain !== fromJson) {
    fail(`${label} and ${jsonKey} disagree; send only one of them, or the same value`);
  }
  return (hasPlain ? fromPlain : fromJson) ?? null;
}

/** Only fields present in the body are written; null clears a field. */
export function updateProfile(input: Record<string, unknown>): Profile {
  getProfile();
  const patch: Partial<typeof profile.$inferInsert> = { updatedAtMs: Date.now() };

  if ("name" in input) patch.name = str(input.name, "name", { max: 120 });
  if ("birthDate" in input) {
    const birthDate = str(input.birthDate, "birthDate");
    if (birthDate && (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(Date.parse(`${birthDate}T12:00:00Z`)))) {
      fail("birthDate must be YYYY-MM-DD");
    }
    if (birthDate && birthDate > new Date().toISOString().slice(0, 10)) fail("birthDate cannot be in the future");
    patch.birthDate = birthDate;
  }
  if ("sex" in input) patch.sex = enumField(input.sex, "sex", SEXES, false);
  if ("heightCm" in input) patch.heightCm = numField(input.heightCm, "heightCm", { min: 50, max: 260 });
  if ("timezone" in input) patch.timezone = timezoneField(input.timezone);
  if ("units" in input) patch.units = enumField(input.units, "units", UNITS) ?? "metric";
  if ("workSchedule" in input) patch.workScheduleJson = jsonField(input.workSchedule, "workSchedule");
  if ("workScheduleJson" in input) patch.workScheduleJson = jsonField(input.workScheduleJson, "workScheduleJson");
  if ("goalWeightKg" in input) patch.goalWeightKg = numField(input.goalWeightKg, "goalWeightKg", { min: 20, max: 400 });
  if ("goalsNote" in input) patch.goalsNote = str(input.goalsNote, "goalsNote", { max: 4000 });
  if ("dietNote" in input) patch.dietNote = str(input.dietNote, "dietNote", { max: 4000 });
  if ("activityNote" in input) patch.activityNote = str(input.activityNote, "activityNote", { max: 4000 });

  const goalJson = resolveAlias(input, "goal", "goalJson", goalFromInput, "goal");
  if (goalJson !== undefined) patch.goalJson = goalJson;
  const wheyLinkJson = resolveAlias(input, "wheyLink", "wheyLinkJson", wheyLinkFromInput, "wheyLink");
  if (wheyLinkJson !== undefined) patch.wheyLinkJson = wheyLinkJson;

  db.update(profile).set(patch).where(eq(profile.id, 1)).run();
  return getProfile();
}

/**
 * Fill profile fields that are still empty from Apple's `<Me>` / height records.
 * User-edited values are never overwritten, and the profile is created lazily.
 */
export function prefillProfile(input: { birthDate?: string; sex?: string; heightCm?: number }): Profile {
  const p = getProfile();
  const patch: Partial<typeof profile.$inferInsert> = {};
  if (!p.birthDate && input.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)) {
    patch.birthDate = input.birthDate;
  }
  if (!p.sex && input.sex && (SEXES as readonly string[]).includes(input.sex)) patch.sex = input.sex;
  if (!p.heightCm && input.heightCm && input.heightCm >= 50 && input.heightCm <= 260) {
    patch.heightCm = Math.round(input.heightCm * 10) / 10;
  }
  if (Object.keys(patch).length === 0) return p;
  patch.updatedAtMs = Date.now();
  db.update(profile).set(patch).where(eq(profile.id, 1)).run();
  return getProfile();
}

/**
 * Mifflin-St Jeor basal metabolic rate with a light-activity multiplier, used only as a
 * starting suggestion. The user can always replace it in nutrition targets.
 */
export function suggestedTargets(p: Profile = getProfile(), weightKg = 75): {
  kcal: number; proteinG: number; carbsG: number; fatG: number; fibreG: number; sodiumMg: number;
} {
  const kg = weightKg;
  const cm = p.heightCm ?? 172;
  const age = ageOf(p) ?? 35;
  const sexFactor = p.sex === "female" ? -161 : p.sex === "male" ? 5 : -78;
  const bmr = 10 * kg + 6.25 * cm - 5 * age + sexFactor;
  const kcal = Math.round(bmr * 1.375);
  const proteinG = Math.round(kg * 1.6);
  const fatG = Math.round((kcal * 0.25) / 9);
  const carbsG = Math.max(0, Math.round((kcal - proteinG * 4 - fatG * 9) / 4));
  return { kcal, proteinG, carbsG, fatG, fibreG: Math.round((kcal / 1000) * 14), sodiumMg: 2300 };
}

/** Parse the stored work-schedule JSON without trusting its shape. */
export function workSchedule(p: Profile): { days: { weekday: number; start: string; end: string }[]; note?: string } {
  if (!p.workScheduleJson) return { days: [] };
  try {
    const parsed = JSON.parse(p.workScheduleJson) as { days?: unknown; note?: unknown };
    const days = Array.isArray(parsed.days)
      ? parsed.days
          .map((d) => d as { weekday?: unknown; start?: unknown; end?: unknown })
          .filter((d) => Number.isInteger(d.weekday) && typeof d.start === "string" && typeof d.end === "string")
          .map((d) => ({ weekday: Number(d.weekday), start: String(d.start), end: String(d.end) }))
      : [];
    return { days, ...(typeof parsed.note === "string" ? { note: parsed.note } : {}) };
  } catch {
    return { days: [] };
  }
}
