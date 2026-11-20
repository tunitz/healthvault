import { desc, eq } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { measurements } from "@/db/schema";
import { addDays, formatLocal, localDay, localDayStartMs, localTimeMs } from "@/lib/day";
import { getTimezone } from "@/lib/services/profile";
import { dayField, enumField, fail, idField, instantField, numField, str } from "@/lib/validate";

export type MeasurementKind = "weight" | "bodyFat" | "waist";
export const KINDS = ["weight", "bodyFat", "waist"] as const;

export type MeasurementRow = typeof measurements.$inferSelect;

export type Point = {
  id: number | null;
  day: string;
  takenAtMs: number;
  value: number;
  unit: "kg" | "%" | "cm";
  source: "manual" | "apple";
  note: string | null;
};

export const KIND_UNIT: Record<MeasurementKind, "kg" | "%" | "cm"> = {
  weight: "kg",
  bodyFat: "%",
  waist: "cm",
};

function normalize(kind: MeasurementKind, value: number, unit?: string | null): { value: number; unit: "kg" | "%" | "cm" } {
  const u = (unit ?? KIND_UNIT[kind]).toLowerCase();
  if (kind === "weight") {
    let kg = value;
    if (u === "lb" || u === "lbs") kg = value * 0.45359237;
    else if (u !== "kg") fail("weight unit must be kg or lb");
    if (kg < 20 || kg > 400) fail("weight must be between 20 and 400 kg");
    return { value: kg, unit: "kg" };
  }
  if (kind === "bodyFat") {
    if (u !== "%" && u !== "percent") fail("bodyFat unit must be %");
    if (value < 1 || value > 75) fail("bodyFat must be between 1 and 75 %");
    return { value, unit: "%" };
  }
  let cm = value;
  if (u === "in" || u === "inch") cm = value * 2.54;
  else if (u !== "cm") fail("waist unit must be cm or in");
  if (cm < 20 || cm > 300) fail("waist must be between 20 and 300 cm");
  return { value: cm, unit: "cm" };
}

export function addMeasurement(input: Record<string, unknown>): MeasurementRow {
  const kind = enumField(input.kind, "kind", KINDS)!;
  const raw = numField(input.value, "value", { required: true, min: 0 })!;
  const { value, unit } = normalize(kind, raw, typeof input.unit === "string" ? input.unit : null);

  const tz = getTimezone();
  const explicitDay =
    input.day === undefined || input.day === null || input.day === "" ? null : dayField(input.day, "day");
  let takenAtMs: number;
  if (input.takenAt !== undefined && input.takenAt !== null && input.takenAt !== "") {
    takenAtMs = instantField(input.takenAt, "takenAt", tz);
    if (takenAtMs < 0 || takenAtMs > Date.now() + 86_400_000) fail("takenAt is outside the accepted range");
  } else if (explicitDay) {
    takenAtMs = localTimeMs(explicitDay, "12:00", tz);
  } else {
    takenAtMs = Date.now();
  }
  const day = explicitDay ?? localDay(takenAtMs, tz);
  if (explicitDay && localDay(takenAtMs, tz) !== explicitDay) fail("day must match takenAt in the profile timezone");

  try {
    return db
      .insert(measurements)
      .values({
        day,
        takenAtMs,
        kind,
        value,
        unit,
        note: str(input.note, "note", { max: 1000 }),
        createdAtMs: Date.now(),
      })
      .returning()
      .get();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      fail(`a ${kind} measurement already exists at ${formatLocal(takenAtMs, tz)}`, 409);
    }
    throw e;
  }
}

export function deleteMeasurement(id: unknown): { deleted: boolean } {
  const row = db.delete(measurements).where(eq(measurements.id, idField(id))).returning().get();
  return { deleted: Boolean(row) };
}

/** Manual entries, newest first, for the profile weight log. */
export function manualMeasurements(kind: MeasurementKind = "weight", limit = 100): MeasurementRow[] {
  return db
    .select()
    .from(measurements)
    .where(eq(measurements.kind, kind))
    .orderBy(desc(measurements.takenAtMs))
    .limit(limit)
    .all();
}

type AppleRow = { startMs: number; startDate: string; value: number; unit: string };

function appleWeightToKg(value: number, unit: string): number {
  switch (unit.trim().toLowerCase()) {
    case "lb":
    case "lbs":
      return value * 0.45359237;
    case "g":
      return value / 1000;
    case "st":
      return value * 6.35029318;
    default:
      return value;
  }
}

/** Apple BodyMass is read from the imported records; it is never copied into `measurements`. */
function appleWeight(days: number, tz: string): Point[] {
  const endDay = localDay(Date.now(), tz);
  const startDay = addDays(endDay, -(Math.max(1, Math.trunc(days)) - 1));
  const startMs = localDayStartMs(startDay, tz);
  const rows = sqlite
    .prepare(
      `SELECT start_ms AS startMs, start_date AS startDate, value, unit
       FROM records
       WHERE type_identifier = 'HKQuantityTypeIdentifierBodyMass' AND start_ms >= ?
       ORDER BY start_ms`,
    )
    .all(startMs) as AppleRow[];
  return rows.map((r) => ({
    id: null,
    day: r.startDate.slice(0, 10),
    takenAtMs: r.startMs,
    value: appleWeightToKg(r.value, r.unit),
    unit: "kg" as const,
    source: "apple" as const,
    note: null,
  }));
}

/** One chronological series: manual entries merged with Apple BodyMass. */
export function measurementHistory(kind: MeasurementKind = "weight", days = 365): Point[] {
  const tz = getTimezone();
  const capped = Number.isFinite(days) && days >= 1 ? Math.min(Math.trunc(days), 3650) : 365;
  const startDay = addDays(localDay(Date.now(), tz), -(capped - 1));
  const manual = manualMeasurements(kind, 1000)
    .filter((m) => m.day >= startDay)
    .map<Point>((m) => ({
      id: m.id,
      day: m.day,
      takenAtMs: m.takenAtMs,
      value: m.value,
      unit: KIND_UNIT[kind],
      source: "manual",
      note: m.note,
    }));
  const apple = kind === "weight" ? appleWeight(capped, tz) : [];
  return [...manual, ...apple].sort((a, b) => a.takenAtMs - b.takenAtMs);
}

/** Latest value per day (the last one recorded that day), for charts. */
export function dailySeries(kind: MeasurementKind = "weight", days = 90): Point[] {
  const perDay = new Map<string, Point>();
  for (const p of measurementHistory(kind, days)) perDay.set(p.day, p);
  return [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function latestMeasurement(kind: MeasurementKind = "weight"): Point | null {
  const manualRow = db
    .select()
    .from(measurements)
    .where(eq(measurements.kind, kind))
    .orderBy(desc(measurements.takenAtMs))
    .limit(1)
    .get();
  const manualPoint: Point | null = manualRow
    ? {
        id: manualRow.id,
        day: manualRow.day,
        takenAtMs: manualRow.takenAtMs,
        value: manualRow.value,
        unit: KIND_UNIT[kind],
        source: "manual",
        note: manualRow.note,
      }
    : null;

  if (kind !== "weight") return manualPoint;

  const appleRow = sqlite
    .prepare(
      `SELECT start_ms AS startMs, start_date AS startDate, value, unit
       FROM records
       WHERE type_identifier = 'HKQuantityTypeIdentifierBodyMass'
       ORDER BY start_ms DESC LIMIT 1`,
    )
    .get() as AppleRow | undefined;
  if (!appleRow) return manualPoint;

  const applePoint: Point = {
    id: null,
    day: appleRow.startDate.slice(0, 10),
    takenAtMs: appleRow.startMs,
    value: appleWeightToKg(appleRow.value, appleRow.unit),
    unit: "kg",
    source: "apple",
    note: null,
  };

  if (!manualPoint) return applePoint;
  return manualPoint.takenAtMs >= applePoint.takenAtMs ? manualPoint : applePoint;
}

export function weightTrend(days = 7): { points: Point[]; changeKg: number | null; avgKg: number | null } {
  const points = dailySeries("weight", days);
  const changeKg = points.length > 1 ? points[points.length - 1].value - points[0].value : null;
  const avgKg = points.length ? points.reduce((a, p) => a + p.value, 0) / points.length : null;
  return { points, changeKg, avgKg };
}

export function measurementSummary() {
  const tz = getTimezone();
  return {
    today: localDay(Date.now(), tz),
    timezone: tz,
    latestWeight: latestMeasurement("weight"),
    latestBodyFat: latestMeasurement("bodyFat"),
    latestWaist: latestMeasurement("waist"),
  };
}
