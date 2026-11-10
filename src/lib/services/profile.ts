import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profile } from "@/db/schema";
import { DEFAULT_TIMEZONE } from "@/lib/day";
import { enumField, fail, jsonField, numField, str, timezoneField } from "@/lib/validate";

export type Profile = typeof profile.$inferSelect;

const SEXES = ["male", "female", "other"] as const;
export const UNITS = ["metric", "imperial"] as const;

function row(): Profile | undefined {
  return db.select().from(profile).where(eq(profile.id, 1)).get();
}

/** The singleton row, created empty on first access so callers never handle `undefined`. */
export function getProfile(): Profile {
  const existing = row();
  if (existing) return existing;
  const now = Date.now();
  db.insert(profile)
    .values({ id: 1, timezone: DEFAULT_TIMEZONE, units: "metric", createdAtMs: now, updatedAtMs: now })
    .onConflictDoNothing()
    .run();
  return row()!;
}

export function getTimezone(): string {
  return getProfile().timezone || DEFAULT_TIMEZONE;
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
