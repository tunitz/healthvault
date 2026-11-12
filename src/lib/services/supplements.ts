import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { supplementLogs, supplements } from "@/db/schema";
import { addDays, localDay, localTimeMs, weekStart, weekdayIndex } from "@/lib/day";
import { getTimezone } from "@/lib/services/profile";
import { boolField, dayField, fail, idField, numField, str } from "@/lib/validate";

export type Supplement = typeof supplements.$inferSelect;
export type SupplementLog = typeof supplementLogs.$inferSelect;
type PublicSupplementLog = Omit<SupplementLog, "wheyActionId">;

export type Schedule = { time: string | null; days: number[] | null; note?: string };

export function parseSchedule(json: string | null): Schedule {
  if (!json) return { time: null, days: null };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const time = typeof parsed.time === "string" && /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : null;
    const days = Array.isArray(parsed.days)
      ? parsed.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : null;
    return { time, days: days && days.length ? days : null, note: typeof parsed.note === "string" ? parsed.note : undefined };
  } catch {
    return { time: null, days: null };
  }
}

function scheduledOn(s: Supplement, day: string): boolean {
  if (!s.active) return false;
  const { days } = parseSchedule(s.scheduleJson);
  return days === null || days.includes(weekdayIndex(day));
}

export function listSupplements(activeOnly = true): Supplement[] {
  const base = db.select().from(supplements);
  const rows = activeOnly ? base.where(eq(supplements.active, 1)) : base;
  return rows.orderBy(desc(supplements.active), supplements.name).all();
}

export function getSupplement(id: unknown): Supplement {
  const row = db.select().from(supplements).where(eq(supplements.id, idField(id))).get();
  if (!row) fail("supplement not found", 404);
  return row;
}

export function createSupplement(input: Record<string, unknown>): Supplement {
  const now = Date.now();
  const active = boolField(input.active, "active");
  const row = db
    .insert(supplements)
    .values({
      name: str(input.name, "name", { required: true, max: 160 })!,
      dose: numField(input.dose ?? 1, "dose", { min: 0.01, max: 10_000 }) ?? 1,
      unit: str(input.unit ?? "capsule", "unit", { max: 40 }) ?? "capsule",
      scheduleJson:
        input.schedule === undefined
          ? typeof input.scheduleJson === "string"
            ? input.scheduleJson
            : null
          : JSON.stringify(input.schedule),
      nutrientsJson:
        input.nutrients === undefined
          ? typeof input.nutrientsJson === "string"
            ? input.nutrientsJson
            : null
          : JSON.stringify(input.nutrients),
      notes: str(input.notes, "notes", { max: 2000 }),
      active: active === false ? 0 : 1,
      createdAtMs: now,
      updatedAtMs: now,
    })
    .returning()
    .get()!;
  return row;
}

export function updateSupplement(id: unknown, input: Record<string, unknown>): Supplement {
  const existing = getSupplement(id);
  const patch: Partial<typeof supplements.$inferInsert> = { updatedAtMs: Date.now() };
  if ("name" in input) patch.name = str(input.name, "name", { required: true, max: 160 })!;
  if ("dose" in input) patch.dose = numField(input.dose, "dose", { min: 0.01, max: 10_000 })!;
  if ("unit" in input) patch.unit = str(input.unit, "unit", { max: 40 })!;
  if ("schedule" in input) patch.scheduleJson = input.schedule === null ? null : JSON.stringify(input.schedule);
  if ("scheduleJson" in input) patch.scheduleJson = typeof input.scheduleJson === "string" ? input.scheduleJson : null;
  if ("nutrients" in input) patch.nutrientsJson = input.nutrients === null ? null : JSON.stringify(input.nutrients);
  if ("nutrientsJson" in input) patch.nutrientsJson = typeof input.nutrientsJson === "string" ? input.nutrientsJson : null;
  if ("notes" in input) patch.notes = str(input.notes, "notes", { max: 2000 });
  if ("active" in input) {
    const active = boolField(input.active, "active");
    if (active !== null) patch.active = active ? 1 : 0;
  }
  db.update(supplements).set(patch).where(eq(supplements.id, existing.id)).run();
  return getSupplement(existing.id);
}

/** Archive instead of delete when history exists, so past intake stays meaningful. */
export function deleteSupplement(id: unknown): { deleted: boolean; archived: boolean } {
  const supplementId = idField(id);
  const used = sqlite.prepare("SELECT COUNT(*) AS c FROM supplement_logs WHERE supplement_id = ?").get(supplementId) as { c: number };
  if (used.c > 0) {
    db.update(supplements).set({ active: 0, updatedAtMs: Date.now() }).where(eq(supplements.id, supplementId)).run();
    return { deleted: false, archived: true };
  }
  const row = db.delete(supplements).where(eq(supplements.id, supplementId)).returning().get();
  return { deleted: Boolean(row), archived: false };
}

/** Upsert today's intake for one supplement; `taken: false` removes the log. */
export function logSupplement(
  input: Record<string, unknown>,
  options: { wheyActionId?: string } = {},
): { logged: boolean; log: PublicSupplementLog | null; supplement: Supplement } {
  const supplement = getSupplement(input.supplementId);
  const tz = getTimezone();
  const day =
    input.day === undefined || input.day === null || input.day === ""
      ? localDay(Date.now(), tz)
      : dayField(input.day, "day");
  const taken =
    input.taken === undefined || input.taken === null
      ? true
      : boolField(input.taken, "taken") !== false;

  if (!taken) {
    db.delete(supplementLogs)
      .where(and(eq(supplementLogs.supplementId, supplement.id), eq(supplementLogs.day, day)))
      .run();
    return { logged: false, log: null, supplement };
  }

  const dose = numField(input.dose ?? supplement.dose, "dose", { min: 0.01, max: 10_000 }) ?? supplement.dose;
  const unit = str(input.unit ?? supplement.unit, "unit", { max: 40 }) ?? supplement.unit;
  let takenAtMs = Date.now();
  if (input.takenAt !== undefined && input.takenAt !== null && input.takenAt !== "") {
    if (typeof input.takenAt === "number") {
      takenAtMs = numField(input.takenAt, "takenAt", { min: 0, max: Date.now() + 86_400_000 })!;
    } else if (typeof input.takenAt === "string" && !Number.isNaN(Date.parse(input.takenAt))) {
      takenAtMs = Date.parse(input.takenAt);
    } else {
      fail("takenAt must be an ISO timestamp or epoch ms");
    }
  } else if (day !== localDay(Date.now(), tz)) {
    takenAtMs = localTimeMs(day, "12:00", tz);
  }
  const now = Date.now();

  db.insert(supplementLogs)
    .values({
      supplementId: supplement.id,
      day,
      takenAtMs,
      dose,
      unit,
      note: str(input.note, "note", { max: 1000 }),
      createdAtMs: now,
      wheyActionId: options.wheyActionId ?? null,
    })
    .onConflictDoUpdate({
      target: [supplementLogs.supplementId, supplementLogs.day],
      set: {
        takenAtMs,
        dose,
        unit,
        note: str(input.note, "note", { max: 1000 }),
        wheyActionId: options.wheyActionId ?? null,
      },
    })
    .run();

  const log = db
    .select()
    .from(supplementLogs)
    .where(and(eq(supplementLogs.supplementId, supplement.id), eq(supplementLogs.day, day)))
    .get()!;
  const { wheyActionId: _wheyActionId, ...publicLog } = log;
  void _wheyActionId;
  return { logged: true, log: publicLog, supplement };
}

export type ChecklistItem = {
  supplement: Supplement;
  schedule: Schedule;
  logged: boolean;
  log: PublicSupplementLog | null;
};

export function todayChecklist(day: string = localDay(Date.now(), getTimezone())): {
  day: string;
  items: ChecklistItem[];
  taken: number;
  total: number;
} {
  const validDay = dayField(day, "day");
  const active = listSupplements(true).filter((s) => scheduledOn(s, validDay));
  const logs = db.select().from(supplementLogs).where(eq(supplementLogs.day, validDay)).all();
  const bySupplement = new Map(logs.map((l) => [l.supplementId, l]));
  const items = active.map((supplement) => {
    const log = bySupplement.get(supplement.id) ?? null;
    if (!log) return { supplement, schedule: parseSchedule(supplement.scheduleJson), logged: false, log: null };
    const { wheyActionId: _wheyActionId, ...publicLog } = log;
    void _wheyActionId;
    return { supplement, schedule: parseSchedule(supplement.scheduleJson), logged: true, log: publicLog };
  });
  // Scheduled items first, by time; unscheduled ones after.
  items.sort((a, b) => (a.schedule.time ?? "99:99").localeCompare(b.schedule.time ?? "99:99"));
  return { day: validDay, items, taken: items.filter((i) => i.logged).length, total: items.length };
}

export type NextSupplement = ChecklistItem & { due: true; dueAtMs: number };

/** Active scheduled supplements due today; future, logged, and untimed items are omitted. */
export function dueSupplements(
  day: string = localDay(Date.now(), getTimezone()),
  nowMs = Date.now(),
): NextSupplement[] {
  const tz = getTimezone();
  const checklist = todayChecklist(day);
  return checklist.items
    .filter((item) => !item.logged && item.schedule.time !== null)
    .map((item) => ({ item, dueAtMs: localTimeMs(day, item.schedule.time!, tz) }))
    .filter(({ dueAtMs }) => dueAtMs <= nowMs)
    .sort(
      (a, b) =>
        a.dueAtMs - b.dueAtMs || a.item.supplement.id - b.item.supplement.id,
    )
    .map(({ item, dueAtMs }) => ({ ...item, due: true as const, dueAtMs }));
}

/** The earliest scheduled supplement already due today; future and untimed items are omitted. */
export function nextSupplement(
  day: string = localDay(Date.now(), getTimezone()),
  nowMs = Date.now(),
): NextSupplement | null {
  return dueSupplements(day, nowMs)[0] ?? null;
}

export function supplementHistory(days = 30): {
  day: string;
  taken: number;
  items: { name: string; dose: number; unit: string; takenAtMs: number }[];
}[] {
  const tz = getTimezone();
  const end = localDay(Date.now(), tz);
  const capped = Number.isFinite(days) && days >= 1 ? Math.min(Math.trunc(days), 366) : 30;
  const start = addDays(end, -(capped - 1));
  const rows = sqlite
    .prepare(
      `SELECT l.day, s.name, l.dose, l.unit, l.taken_at_ms AS takenAtMs
       FROM supplement_logs l JOIN supplements s ON s.id = l.supplement_id
       WHERE l.day >= ? AND l.day <= ? ORDER BY l.day, l.taken_at_ms`,
    )
    .all(start, end) as { day: string; name: string; dose: number; unit: string; takenAtMs: number }[];
  const byDay = new Map<string, { day: string; taken: number; items: typeof rows }>();
  for (const r of rows) {
    const bucket = byDay.get(r.day) ?? { day: r.day, taken: 0, items: [] };
    bucket.items.push(r);
    bucket.taken += 1;
    byDay.set(r.day, bucket);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/* ---------------------------------------------------------------------------------------------
 * Weekly adherence
 * ------------------------------------------------------------------------------------------- */

export type AdherenceDay = {
  day: string;
  scheduled: boolean;
  taken: boolean;
  /** Still ahead of today (only possible in the current week). */
  future: boolean;
};

export type AdherenceWeek = {
  weekStart: string;
  weekEnd: string;
  days: AdherenceDay[];
  /** Days this regimen's schedule covers in the week; a null `days` list means all seven. */
  scheduledDays: number;
  /** Of those, the days with an intake log (an extra unscheduled dose never exceeds 100%). */
  takenDays: number;
  pct: number;
  /** Same counts restricted to days that have already happened, so the current week is honest. */
  elapsedScheduledDays: number;
  elapsedTakenDays: number;
  elapsedPct: number;
};

export type SupplementAdherence = {
  supplementId: number;
  name: string;
  dose: number;
  unit: string;
  active: boolean;
  /** Oldest first; the last entry is the current Sunday-start week. */
  weeks: AdherenceWeek[];
};

function percent(taken: number, scheduled: number): number {
  return scheduled > 0 ? Math.round((taken / scheduled) * 100) : 0;
}

/**
 * Per-supplement, per-week adherence over the last `weeks` Sunday-start weeks.
 *
 * Rows stay one per supplement (the two magnesium entries are never merged). `scheduledDays`
 * comes from the stored schedule alone: an archived regimen has no activation history, so its
 * *current* schedule is applied to past weeks rather than pretending it was never scheduled.
 * `active` lets the caller hide archived rows behind a toggle.
 */
export function weeklyAdherence(weeks = 4): SupplementAdherence[] {
  const tz = getTimezone();
  const today = localDay(Date.now(), tz);
  const capped = Number.isFinite(weeks) && weeks >= 1 ? Math.min(Math.trunc(weeks), 52) : 4;
  const currentStart = weekStart(today);
  const starts = Array.from({ length: capped }, (_, i) => addDays(currentStart, -7 * (capped - 1 - i)));

  // One query for the whole window; the per-supplement/day check is then in memory.
  const logs = db
    .select()
    .from(supplementLogs)
    .where(and(gte(supplementLogs.day, starts[0]), lte(supplementLogs.day, today)))
    .all();
  const taken = new Set(logs.map((log) => `${log.supplementId}:${log.day}`));

  return listSupplements(false).map((supplement) => {
    const { days } = parseSchedule(supplement.scheduleJson);
    const weeksOut = starts.map((start) => {
      const dayRows: AdherenceDay[] = Array.from({ length: 7 }, (_, i) => {
        const day = addDays(start, i);
        return {
          day,
          scheduled: days === null || days.includes(weekdayIndex(day)),
          taken: taken.has(`${supplement.id}:${day}`),
          future: day > today,
        };
      });
      const scheduledRows = dayRows.filter((row) => row.scheduled);
      const elapsedRows = scheduledRows.filter((row) => !row.future);
      const takenDays = scheduledRows.filter((row) => row.taken).length;
      const elapsedTakenDays = elapsedRows.filter((row) => row.taken).length;
      return {
        weekStart: start,
        weekEnd: addDays(start, 6),
        days: dayRows,
        scheduledDays: scheduledRows.length,
        takenDays,
        pct: percent(takenDays, scheduledRows.length),
        elapsedScheduledDays: elapsedRows.length,
        elapsedTakenDays,
        elapsedPct: percent(elapsedTakenDays, elapsedRows.length),
      };
    });
    return {
      supplementId: supplement.id,
      name: supplement.name,
      dose: supplement.dose,
      unit: supplement.unit,
      active: supplement.active === 1,
      weeks: weeksOut,
    };
  });
}
