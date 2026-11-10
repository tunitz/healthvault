import { beforeEach, expect, test } from "bun:test";
import { freshDbPath, resetDatabase } from "./helpers";
import { localDay, localTimeMs } from "@/lib/day";

process.env.DATABASE_PATH = freshDbPath();
const { sqlite } = await import("@/db");
const nutrition = await import("@/lib/services/nutrition");
const supplements = await import("@/lib/services/supplements");
const profile = await import("@/lib/services/profile");
const measurements = await import("@/lib/services/measurements");
const context = await import("@/lib/services/context");
const { POST } = await import("@/app/api/agent/[tool]/route");

beforeEach(resetDatabase);

const TZ = "Asia/Shanghai";

async function call(tool: string, body: unknown = {}) {
  const res = await POST(
    new Request(`http://localhost/api/agent/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ tool }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as { ok?: boolean; result?: unknown; error?: string },
  };
}

function insertRecord(opts: {
  type: string;
  value: number;
  day: string;
  unit?: string;
  source?: string;
  startDate?: string;
  startMs?: number;
  endMs?: number;
}) {
  const startDate = opts.startDate ?? `${opts.day} 10:00:00 +0800`;
  const startMs = opts.startMs ?? localTimeMs(opts.day, "10:00", TZ);
  sqlite
    .prepare(
      `INSERT INTO records (type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.type,
      opts.unit ?? "count",
      opts.value,
      startDate,
      startMs,
      opts.day,
      startDate,
      opts.endMs ?? startMs + 60_000,
      opts.source ?? "Apple Watch",
    );
}

test("profile_get and healthvault_context expose the parsed work schedule", async () => {
  const empty = await call("profile_get");
  expect(empty.status).toBe(200);
  const emptyResult = empty.body.result as {
    profile: { workScheduleJson: string | null };
    workSchedule: { days: unknown[] };
  };
  expect(emptyResult.workSchedule.days).toEqual([]);
  expect(emptyResult.profile.workScheduleJson).toBeNull();

  profile.updateProfile({
    workSchedule: {
      days: [
        { weekday: 1, start: "09:00", end: "17:00" },
        { weekday: 3, start: "10:00", end: "18:00" },
      ],
      note: "hybrid",
    },
  });

  const got = await call("profile_get");
  expect(got.status).toBe(200);
  const result = got.body.result as {
    profile: { workScheduleJson: string | null };
    workSchedule: { days: { weekday: number; start: string; end: string }[]; note?: string };
  };
  expect(result.workSchedule.days.length).toBe(2);
  expect(result.workSchedule.days[0]).toEqual({ weekday: 1, start: "09:00", end: "17:00" });
  expect(result.workSchedule.note).toBe("hybrid");
  // The raw JSON stays on the profile for backwards compatibility.
  expect(result.profile.workScheduleJson).toContain("09:00");

  const ctx = context.healthvaultContext();
  expect(ctx.profile.workSchedule.days.length).toBe(2);
  expect(ctx.profile.workSchedule.note).toBe("hybrid");
});

test("measurement_delete removes manual rows only, never Apple BodyMass", async () => {
  const manual = measurements.addMeasurement({ kind: "weight", value: 71.2, day: "2026-11-02" });
  insertRecord({
    type: "HKQuantityTypeIdentifierBodyMass",
    value: 70.9,
    unit: "kg",
    day: "2026-11-02",
    startDate: "2026-11-02 07:00:00 +0800",
    startMs: localTimeMs("2026-11-02", "07:00", TZ),
  });

  const deleted = await call("measurement_delete", { id: manual.id });
  expect(deleted.status).toBe(200);
  expect(deleted.body.result).toEqual({ deleted: true });

  const again = await call("measurement_delete", { id: manual.id });
  expect(again.status).toBe(404);

  const apple = sqlite
    .prepare("SELECT COUNT(*) AS c FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierBodyMass'")
    .get() as { c: number };
  expect(apple.c).toBe(1);
  const remaining = sqlite.prepare("SELECT COUNT(*) AS c FROM measurements").get() as { c: number };
  expect(remaining.c).toBe(0);

  expect((await call("measurement_delete", { id: 0 })).status).toBe(400);
});

test("food_delete deletes unused foods and refuses foods used by a meal", async () => {
  const unused = nutrition.addFood({ name: "Unused food", per100g: { kcal: 100 } });
  const deleted = await call("food_delete", { id: unused.id });
  expect(deleted.status).toBe(200);
  expect(deleted.body.result).toEqual({ deleted: true });
  expect((await call("food_delete", { id: unused.id })).status).toBe(404);
  expect((await call("food_delete", { id: 999999 })).status).toBe(404);

  const used = nutrition.addFood({ name: "Used food", per100g: { kcal: 200 } });
  nutrition.logMeal({
    day: "2026-11-02",
    meal: "lunch",
    entries: [{ foodId: used.id, grams: 100 }],
  });
  const conflict = await call("food_delete", { id: used.id });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error).toContain("cannot be deleted");
  expect((await call("food_delete", { id: "abc" })).status).toBe(400);
});

test("copy_day copies a day idempotently and rejects bad or empty sources", async () => {
  nutrition.logMeal({
    day: "2026-11-03",
    meal: "breakfast",
    entries: [{ name: "Oats", grams: 100, kcal: 380 }],
  });

  const first = await call("copy_day", { fromDay: "2026-11-03", toDay: "2026-11-04" });
  expect(first.status).toBe(200);
  const firstResult = first.body.result as { copied: number; toDay: string };
  expect(firstResult.toDay).toBe("2026-11-04");
  expect(firstResult.copied).toBeGreaterThanOrEqual(1);
  expect(nutrition.dayNutrition("2026-11-04").entries.length).toBe(1);

  const second = await call("copy_day", { fromDay: "2026-11-03", toDay: "2026-11-04" });
  expect(second.status).toBe(200);
  expect((second.body.result as { copied: number }).copied).toBe(0);
  expect(nutrition.dayNutrition("2026-11-04").entries.length).toBe(1);

  expect((await call("copy_day", { fromDay: "2026-11-03", toDay: "2026-11-03" })).status).toBe(400);
  expect((await call("copy_day", { toDay: "2026-11-05" })).status).toBe(400);
  expect((await call("copy_day", { fromDay: "not-a-day", toDay: "2026-11-05" })).status).toBe(400);
  expect((await call("copy_day", { fromDay: "2026-09-09", toDay: "2026-09-10" })).status).toBe(404);
});

test("record_types reports per-type counts and first/last days", async () => {
  insertRecord({
    type: "HKQuantityTypeIdentifierStepCount", value: 100, day: "2026-11-01",
    startDate: "2026-11-01 08:00:00 +0800",
  });
  insertRecord({
    type: "HKQuantityTypeIdentifierStepCount", value: 200, day: "2026-11-03",
    startDate: "2026-11-03 08:00:00 +0800",
  });
  insertRecord({
    type: "HKQuantityTypeIdentifierHeartRate", value: 60, unit: "count/min", day: "2026-11-02",
    startDate: "2026-11-02 08:00:00 +0800",
  });

  const res = await call("record_types");
  expect(res.status).toBe(200);
  const stats = res.body.result as {
    typeIdentifier: string; unit: string; count: number;
    firstDay: string; lastDay: string; sum: number; avg: number; max: number;
  }[];
  expect(stats.length).toBe(2);

  const steps = stats.find((s) => s.typeIdentifier === "HKQuantityTypeIdentifierStepCount")!;
  expect(steps.count).toBe(2);
  expect(steps.firstDay).toBe("2026-11-01");
  expect(steps.lastDay).toBe("2026-11-03");
  expect(steps.sum).toBe(300);
  expect(steps.avg).toBeCloseTo(150, 5);
  expect(steps.max).toBe(200);

  const hr = stats.find((s) => s.typeIdentifier === "HKQuantityTypeIdentifierHeartRate")!;
  expect(hr.count).toBe(1);
  expect(hr.unit).toBe("count/min");
});

test("records_recent returns newest-first rows with a validated limit", async () => {
  const day = "2026-11-05";
  for (let i = 0; i < 51; i += 1) {
    const clock = `10:${String(i).padStart(2, "0")}`;
    insertRecord({
      type: "HKQuantityTypeIdentifierStepCount",
      value: i + 1,
      day,
      startDate: `${day} ${clock}:00 +0800`,
      startMs: localTimeMs(day, clock, TZ),
    });
  }

  const all = await call("records_recent", { type: "HKQuantityTypeIdentifierStepCount" });
  expect(all.status).toBe(200);
  const allResult = all.body.result as { type: string; rows: { value: number }[] };
  expect(allResult.type).toBe("HKQuantityTypeIdentifierStepCount");
  expect(allResult.rows.length).toBe(50); // default limit
  expect(allResult.rows[0].value).toBe(51); // newest first
  expect(allResult.rows[49].value).toBe(2);

  const limited = await call("records_recent", { type: "HKQuantityTypeIdentifierStepCount", limit: 3 });
  expect(limited.status).toBe(200);
  const limitedRows = (limited.body.result as { rows: { value: number }[] }).rows;
  expect(limitedRows.map((r) => r.value)).toEqual([51, 50, 49]);

  expect((await call("records_recent", {})).status).toBe(400);
  expect((await call("records_recent", { type: "" })).status).toBe(400);
  expect((await call("records_recent", { type: 42 })).status).toBe(400);
  expect((await call("records_recent", { type: "HKQuantityTypeIdentifierStepCount", limit: 0 })).status).toBe(400);
  expect((await call("records_recent", { type: "HKQuantityTypeIdentifierStepCount", limit: 501 })).status).toBe(400);

  const unknown = await call("records_recent", { type: "HKQuantityTypeIdentifierNotAThing" });
  expect(unknown.status).toBe(200);
  expect((unknown.body.result as { rows: unknown[] }).rows).toEqual([]);
});

test("uploads_recent lists the latest imports", async () => {
  sqlite
    .prepare(
      `INSERT INTO uploads (filename, bytes, status, records_inserted, records_duplicates, message, created_at_ms, finished_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("export.zip", 1234, "done", 12, 0, null, Date.now(), Date.now());

  const res = await call("uploads_recent");
  expect(res.status).toBe(200);
  const rows = res.body.result as {
    filename: string; status: string; recordsInserted: number; bytes: number;
  }[];
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ filename: "export.zip", status: "done", recordsInserted: 12, bytes: 1234 });
  expect((await call("uploads_recent", { limit: "abc" })).status).toBe(400);
});

test("supplement_history returns logged days and rejects invalid windows", async () => {
  const s = supplements.createSupplement({ name: "Vitamin C", dose: 500, unit: "mg" });
  const today = localDay(Date.now(), TZ);
  supplements.logSupplement({ supplementId: s.id, day: today });

  const res = await call("supplement_history", { days: 7 });
  expect(res.status).toBe(200);
  const history = res.body.result as {
    day: string; taken: number; items: { name: string; dose: number; unit: string }[];
  }[];
  expect(history.length).toBe(1);
  expect(history[0].day).toBe(today);
  expect(history[0].taken).toBe(1);
  expect(history[0].items[0]).toMatchObject({ name: "Vitamin C", dose: 500, unit: "mg" });

  expect((await call("supplement_history", { days: "abc" })).status).toBe(400);
  expect((await call("supplement_history", { days: 0 })).status).toBe(400);
  expect((await call("supplement_history", { days: 367 })).status).toBe(400);
});

test("supplement_delete hard-deletes unused rows and archives ones with history", async () => {
  const unused = supplements.createSupplement({ name: "Unused", dose: 1, unit: "capsule" });
  const hard = await call("supplement_delete", { id: unused.id });
  expect(hard.status).toBe(200);
  expect(hard.body.result).toEqual({ deleted: true, archived: false });

  const used = supplements.createSupplement({ name: "Used", dose: 1, unit: "tablet" });
  supplements.logSupplement({ supplementId: used.id, day: localDay(Date.now(), TZ) });
  const archived = await call("supplement_delete", { id: used.id });
  expect(archived.status).toBe(200);
  expect(archived.body.result).toEqual({ deleted: false, archived: true });
  expect(supplements.listSupplements(true).length).toBe(0);
  expect(supplements.listSupplements(false).find((s) => s.id === used.id)?.active).toBe(0);

  expect((await call("supplement_delete", { id: 999999 })).status).toBe(404);
  expect((await call("supplement_delete", { id: "abc" })).status).toBe(400);
});
