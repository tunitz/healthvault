"use server";

import { revalidatePath } from "next/cache";
import { DEFAULT_TIMEZONE, isDay, localDay, localTimeMs } from "@/lib/day";
import { ValidationError } from "@/lib/validate";
import { getTimezone, updateProfile } from "@/lib/services/profile";
import {
  addMeasurement,
  deleteMeasurement as removeMeasurement,
} from "@/lib/services/measurements";
import {
  addFood,
  copyDay,
  deleteEntry,
  logMeal,
  setTargets,
  updateEntry,
} from "@/lib/services/nutrition";
import {
  createSupplement,
  deleteSupplement,
  logSupplement,
  updateSupplement,
} from "@/lib/services/supplements";
import type { ActionState } from "@/lib/action-state";

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

function failed(error: unknown): ActionState {
  return { ok: false, error: messageOf(error) };
}

function refresh(...paths: string[]) {
  for (const path of paths) revalidatePath(path);
}

/* ---------------------------------------------------------------------------------------------
 * Profile and measurements
 * ------------------------------------------------------------------------------------------- */

export async function saveProfileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
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
    });
    refresh("/profile", "/", "/nutrition");
    return { ok: true, message: "Saved" };
  } catch (error) {
    return failed(error);
  }
}

export async function saveWorkScheduleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
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

export async function updateEntryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
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

export async function deleteEntryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    deleteEntry(text(fd, "id"));
    refresh("/nutrition", "/");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function copyDayAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
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

/* ---------------------------------------------------------------------------------------------
 * Supplements
 * ------------------------------------------------------------------------------------------- */

export async function toggleSupplementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
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
    const result = deleteSupplement(text(fd, "id"));
    refresh("/supplements", "/");
    return { ok: true, message: result.archived ? "Archived (history kept)" : "Removed" };
  } catch (error) {
    return failed(error);
  }
}
