import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { foodLog, foods, supplementLogs } from "@/db/schema";
import { formatClock, localDay } from "@/lib/day";
import { deleteEntry, logMeal, type FoodEntry } from "@/lib/services/nutrition";
import { getProfile, getTimezone, parseWheyLink, type WheyLink } from "@/lib/services/profile";
import { logSupplement, type SupplementLog } from "@/lib/services/supplements";
import { dayField, fail } from "@/lib/validate";

type WheyAction = {
  version: 1;
  id: string;
  supplementId: number | null;
  supplementLogId: number | null;
  previousSupplementLog: SupplementLog | null;
};

export type WheyLogResult = {
  day: string;
  entry: FoodEntry;
  supplementId: number | null;
  link: WheyLink;
};

function configuredLink(): WheyLink {
  const link = parseWheyLink(getProfile());
  if (!link) {
    fail("One-tap whey is not configured — choose a saved whey food on /supplements", 409);
  }
  return link;
}

function resolveFood(link: WheyLink): void {
  const food = db.select().from(foods).where(eq(foods.id, link.foodId)).get();
  if (!food) {
    fail("One-tap whey points at a saved food that no longer exists — update the whey link on /supplements", 409);
  }
}

function actionForDay(day: string): { entryId: number; action: WheyAction } | null {
  const row = db
    .select({ id: foodLog.id, actionJson: foodLog.wheyActionJson })
    .from(foodLog)
    .where(eq(foodLog.wheyActionDay, day))
    .get();
  if (!row) return null;

  try {
    const action = JSON.parse(row.actionJson!) as Partial<WheyAction>;
    if (
      action.version !== 1 ||
      typeof action.id !== "string" ||
      (action.supplementId !== null && typeof action.supplementId !== "number") ||
      (action.supplementLogId !== null && typeof action.supplementLogId !== "number") ||
      !(action.previousSupplementLog === null || typeof action.previousSupplementLog === "object")
    ) {
      throw new Error("invalid association");
    }
    return { entryId: row.id, action: action as WheyAction };
  } catch {
    fail("The saved whey action is incomplete — it was left untouched", 409);
  }
}

export function hasWheyAction(day: string = localDay(Date.now(), getTimezone())): boolean {
  const validDay = dayField(day, "day");
  return (
    db.select({ id: foodLog.id }).from(foodLog).where(eq(foodLog.wheyActionDay, validDay)).get() !== undefined
  );
}

/**
 * Log today's configured whey serving exactly once, and mark the linked supplement in the same
 * transaction. A dedicated row association—not the editable note or current profile link—is the
 * duplicate guard. The unique day index also protects concurrent writers.
 */
export function logWhey(input: { day?: string | null; eatenAt?: string | number | null } = {}): WheyLogResult {
  const tz = getTimezone();
  const today = localDay(Date.now(), tz);
  const day =
    input.day === undefined || input.day === null || input.day === ""
      ? today
      : dayField(input.day, "day");

  return sqlite.transaction(() => {
    const existing = actionForDay(day);
    if (existing) {
      const row = db.select().from(foodLog).where(eq(foodLog.id, existing.entryId)).get()!;
      fail(`Already logged at ${formatClock(row.eatenAtMs, tz)} — use Undo first`, 409);
    }

    const link = configuredLink();
    resolveFood(link);
    const actionId = randomUUID();
    const previousSupplementLog = link.supplementId === null
      ? null
      : db
          .select()
          .from(supplementLogs)
          .where(and(eq(supplementLogs.supplementId, link.supplementId), eq(supplementLogs.day, day)))
          .get() ?? null;

    const { entries } = logMeal({
      day,
      meal: link.meal,
      ...(input.eatenAt === undefined || input.eatenAt === null ? {} : { eatenAt: input.eatenAt }),
      entries: [
        {
          foodId: link.foodId,
          grams: link.grams,
          weightSource: "counted",
          estimated: false,
        },
      ],
    });

    const supplementLog = link.supplementId === null
      ? null
      : logSupplement({ supplementId: link.supplementId, day, taken: true }, { wheyActionId: actionId }).log;
    const action: WheyAction = {
      version: 1,
      id: actionId,
      supplementId: link.supplementId,
      supplementLogId: supplementLog?.id ?? null,
      previousSupplementLog,
    };
    db.update(foodLog)
      .set({ wheyActionJson: JSON.stringify(action), wheyActionDay: day })
      .where(eq(foodLog.id, entries[0].id))
      .run();

    return { day, entry: entries[0], supplementId: link.supplementId, link };
  })();
}

/** Remove only the exact entry and supplement-log write recorded by this action. */
export function undoWhey(input: { day?: string | null } = {}): {
  undone: boolean;
  day: string;
  supplementId: number | null;
} {
  const tz = getTimezone();
  const day =
    input.day === undefined || input.day === null || input.day === ""
      ? localDay(Date.now(), tz)
      : dayField(input.day, "day");

  return sqlite.transaction(() => {
    const found = actionForDay(day);
    if (!found) return { undone: false, day, supplementId: null };
    const { action } = found;

    if (action.supplementId !== null && action.supplementLogId !== null) {
      const current = db
        .select()
        .from(supplementLogs)
        .where(eq(supplementLogs.id, action.supplementLogId))
        .get();
      // A normal supplement edit/upsert clears this marker. Leave that later user action alone.
      if (current?.wheyActionId === action.id) {
        if (action.previousSupplementLog) {
          const previous = action.previousSupplementLog;
          db.update(supplementLogs)
            .set({
              supplementId: previous.supplementId,
              day: previous.day,
              takenAtMs: previous.takenAtMs,
              dose: previous.dose,
              unit: previous.unit,
              note: previous.note,
              createdAtMs: previous.createdAtMs,
              wheyActionId: null,
            })
            .where(eq(supplementLogs.id, action.supplementLogId))
            .run();
        } else {
          db.delete(supplementLogs)
            .where(and(eq(supplementLogs.id, action.supplementLogId), eq(supplementLogs.wheyActionId, action.id)))
            .run();
        }
      }
    }

    deleteEntry(found.entryId);
    return { undone: true, day, supplementId: action.supplementId };
  })();
}
