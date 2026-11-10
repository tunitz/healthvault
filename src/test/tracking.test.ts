import { beforeEach, expect, test } from "bun:test";
import { freshDbPath, resetDatabase } from "./helpers";
import { localDay, localTimeMs, addDays } from "@/lib/day";

process.env.DATABASE_PATH = freshDbPath();
const { sqlite } = await import("@/db");
const queries = await import("@/db/queries");
const nutrition = await import("@/lib/services/nutrition");
const supplements = await import("@/lib/services/supplements");
const profile = await import("@/lib/services/profile");
const measurements = await import("@/lib/services/measurements");
const context = await import("@/lib/services/context");
const { POST } = await import("@/app/api/agent/[tool]/route");
const { runIngest } = await import("@/lib/ingest");
const { zipSync, strToU8 } = await import("fflate");

beforeEach(resetDatabase);

function insertRecord(opts: {
  type: string; value: number; source: string; day: string;
  unit?: string; startDate?: string; startMs?: number; endMs?: number;
}) {
  const startDate = opts.startDate ?? `${opts.day} 10:00:00 +0800`;
  const startMs = opts.startMs ?? localTimeMs(opts.day, "10:00", "Asia/Shanghai");
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
      opts.source,
    );
}

test("dashboard steps are single-source, not phone + watch", () => {
  const day = localDay(Date.now(), "Asia/Shanghai");
  insertRecord({ type: "HKQuantityTypeIdentifierStepCount", value: 1000, source: "Apple Watch", day });
  insertRecord({ type: "HKQuantityTypeIdentifierStepCount", value: 900, source: "iPhone", day });
  const s = queries.stepsSummary(30);
  expect(s.totalInWindow).toBe(1000);
  expect(s.days).toBe(1);
  expect(s.allTimeSteps).toBe(1000); // the same rule all-time
});

test("sleepByDayStage groups midnight-crossing segments into one night", () => {
  const today = localDay(Date.now(), "Asia/Shanghai");
  const yesterday = addDays(today, -1);

  // Night 1 starts 23:00 yesterday and crosses midnight (00:30 today), in two stages.
  const a = localTimeMs(yesterday, "23:00", "Asia/Shanghai");
  insertRecord({
    type: "HKCategoryTypeIdentifierSleepAnalysis", value: 4, source: "Apple Watch", unit: "",
    day: yesterday, startDate: `${yesterday} 23:00:00 +0800`, startMs: a, endMs: a + 3600_000,
  });
  const b = localTimeMs(today, "00:30", "Asia/Shanghai");
  insertRecord({
    type: "HKCategoryTypeIdentifierSleepAnalysis", value: 5, source: "Apple Watch", unit: "",
    day: today, startDate: `${today} 00:30:00 +0800`, startMs: b, endMs: b + 3600_000,
  });
  // Night 2 is today, 30 minutes of core.
  const c = localTimeMs(today, "22:00", "Asia/Shanghai");
  insertRecord({
    type: "HKCategoryTypeIdentifierSleepAnalysis", value: 4, source: "Apple Watch", unit: "",
    day: today, startDate: `${today} 22:00:00 +0800`, startMs: c, endMs: c + 1800_000,
  });

  const rows = queries.sleepByDayStage(2);
  expect(new Set(rows.map((r) => r.day))).toEqual(new Set([yesterday, today]));
  expect(rows.length).toBe(3); // (night, stage) pairs, not calendar-day fragments
  const key = (r: { day: string; stage: number }) => `${r.day}:${r.stage}`;
  expect(new Set(rows.map(key)).size).toBe(rows.length);

  const lastNight = rows.filter((r) => r.day === yesterday);
  expect(lastNight.find((r) => r.stage === 4)?.hours).toBeCloseTo(1, 5);
  expect(lastNight.find((r) => r.stage === 5)?.hours).toBeCloseTo(1, 5);
  expect(queries.sleepSummary(30).nights).toBe(2);
  expect(queries.sleepSummary(30).totalHours).toBeCloseTo(2.5, 5);
});

test("windows are exactly N local days and use the export-local day", () => {
  const today = localDay(Date.now(), "Asia/Shanghai");
  for (const offset of [0, 1, 2, 3]) {
    const day = addDays(today, -offset);
    insertRecord({ type: "HKQuantityTypeIdentifierStepCount", value: 100, source: "Watch", day });
  }
  expect(queries.stepsDaily(3).length).toBe(3);
  expect(queries.stepsDaily(3).at(-1)?.day).toBe(today);
});

test("single-source picks the device with the most samples, not the biggest total", () => {
  const day = localDay(Date.now(), "Asia/Shanghai");
  // Phone: 3 samples totaling 900. Watch: 1 sample of 1000. The phone day wins.
  for (const [i, value] of [300, 300, 300].entries()) {
    insertRecord({
      type: "HKQuantityTypeIdentifierStepCount", value, source: "iPhone", day,
      startDate: `${day} 09:0${i}:00 +0800`,
    });
  }
  insertRecord({ type: "HKQuantityTypeIdentifierStepCount", value: 1000, source: "Apple Watch", day });
  const point = queries.stepsDaily(30).find((d) => d.day === day);
  expect(point?.value).toBe(900);
  expect(point?.source).toBe("iPhone");
});

test("a meal logged from a food snapshots macros and scales on edit", () => {
  const food = nutrition.addFood({
    name: "Test oats", per100g: { kcal: 380, proteinG: 13, carbsG: 60, fatG: 7, fibreG: 10 },
  });
  const logged = nutrition.logMeal({
    day: "2026-11-01", meal: "breakfast", entries: [{ foodId: food.id, grams: 150 }],
  });
  expect(logged.entries[0].kcal).toBeCloseTo(570, 5);

  const day = nutrition.dayNutrition("2026-11-01");
  expect(day.totals.kcal).toBeCloseTo(570, 5);
  expect(day.totals.proteinG).toBeCloseTo(19.5, 5);
  expect(day.entries.length).toBe(1);

  const updated = nutrition.updateEntry(logged.entries[0].id, { grams: 200 });
  expect(updated.grams).toBe(200);
  expect(updated.kcal).toBeCloseTo(760, 5);
  expect(nutrition.dayNutrition("2026-11-01").totals.kcal).toBeCloseTo(760, 5);

  nutrition.deleteEntry(updated.id);
  expect(nutrition.dayNutrition("2026-11-01").entries.length).toBe(0);
});

test("an estimated hand-entered meal is flagged and keeps its macros", () => {
  const { entries } = nutrition.logMeal({
    day: "2026-11-02", meal: "lunch",
    entries: [{ name: "Canteen rice bowl", grams: 400, kcal: 650, proteinG: 25, carbsG: 80, fatG: 22 }],
  });
  expect(entries[0].estimated).toBe(1);
  const day = nutrition.dayNutrition("2026-11-02");
  expect(day.totals.kcal).toBe(650);
  expect(day.estimatedEntries).toBe(1);
});

test("nutrition targets are effective-dated and partial updates preserve macros", () => {
  const suggested = nutrition.resolveTargets("2026-11-01");
  expect(suggested.source).toBe("suggested");
  expect(suggested.kcal).toBeGreaterThan(1000);

  nutrition.setTargets({
    effectiveFrom: "2026-11-01", kcal: 2100, proteinG: 150, carbsG: 200, fatG: 70, fibreG: 30, sodiumMg: 2200,
  });
  expect(nutrition.resolveTargets("2026-11-01").kcal).toBe(2100);
  expect(nutrition.resolveTargets("2026-10-31").source).toBe("suggested");

  // Updating only kcal must not zero the does-not-arrive macros.
  nutrition.setTargets({ effectiveFrom: "2026-11-01", kcal: 2000 });
  const updated = nutrition.resolveTargets("2026-11-15");
  expect(updated).toMatchObject({ kcal: 2000, proteinG: 150, carbsG: 200, fatG: 70, fibreG: 30, sodiumMg: 2200 });

  // A new effective date with only kcal inherits the rest from the earlier row.
  nutrition.setTargets({ effectiveFrom: "2026-11-20", kcal: 2200 });
  expect(nutrition.resolveTargets("2026-11-21")).toMatchObject({ kcal: 2200, proteinG: 150, fatG: 70 });
  expect(nutrition.resolveTargets("2026-11-19").kcal).toBe(2000);
  expect(() => nutrition.setTargets({ effectiveFrom: "2026-11-01" })).toThrow("at least one target value");
});

test("supplement logging upserts once per day and can be undone", () => {
  const s = supplements.createSupplement({ name: "Vitamin D", dose: 1, unit: "capsule", schedule: { time: "08:00" } });
  const first = supplements.logSupplement({ supplementId: s.id, day: "2026-11-03" });
  expect(first.log?.dose).toBe(1);
  const second = supplements.logSupplement({ supplementId: s.id, day: "2026-11-03", dose: 2 });
  expect(second.log?.dose).toBe(2);
  const rows = sqlite.prepare("SELECT COUNT(*) AS c FROM supplement_logs").get() as { c: number };
  expect(rows.c).toBe(1);

  const checklist = supplements.todayChecklist("2026-11-03");
  expect(checklist.total).toBe(1);
  expect(checklist.taken).toBe(1);

  const undone = supplements.logSupplement({ supplementId: s.id, day: "2026-11-03", taken: false });
  expect(undone.logged).toBe(false);
  expect(supplements.todayChecklist("2026-11-03").taken).toBe(0);
});

test("manual weight merges with Apple BodyMass and keeps the source", () => {
  const day = "2026-11-04";
  insertRecord({
    type: "HKQuantityTypeIdentifierBodyMass", value: 70.5, unit: "kg", source: "Apple Watch",
    day, startDate: `${day} 07:00:00 +0800`, startMs: localTimeMs(day, "07:00", "Asia/Shanghai"),
  });
  measurements.addMeasurement({ kind: "weight", value: 69.8, day, takenAt: localTimeMs(day, "20:00", "Asia/Shanghai") });

  const points = measurements.measurementHistory("weight", 3650);
  const sources = new Set(points.map((p) => p.source));
  expect(sources).toEqual(new Set(["manual", "apple"]));
  expect(measurements.latestMeasurement("weight")?.value).toBeCloseTo(69.8, 5);
});

test("<Me> prefills empty profile fields and never overwrites edits", async () => {
  const xml = `<HealthData locale="en_US">
    <Me HKCharacteristicTypeIdentifierDateOfBirth="1988-04-12" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexFemale"/>
    <Record type="HKQuantityTypeIdentifierHeight" sourceName="Health" unit="cm" startDate="2026-01-01 09:00:00 +0800" endDate="2026-01-01 09:00:00 +0800" value="168.5"/>
  </HealthData>`;
  await runIngest(zipSync({ "export.xml": strToU8(xml) }), "me.zip", xml.length);
  let p = profile.getProfile();
  expect(p.birthDate).toBe("1988-04-12");
  expect(p.sex).toBe("female");
  expect(p.heightCm).toBe(168.5);

  profile.updateProfile({ birthDate: "1990-01-01", heightCm: 170 });
  profile.prefillProfile({ birthDate: "1988-04-12", sex: "male", heightCm: 168.5 });
  p = profile.getProfile();
  expect(p.birthDate).toBe("1990-01-01");
  expect(p.heightCm).toBe(170);
});

test("agent API logs a meal and returns matching totals", async () => {
  const call = async (tool: string, body: unknown) => {
    const res = await POST(
      new Request(`http://localhost/api/agent/${tool}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ tool }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const logged = await call("meal_log", {
    day: "2026-11-05", meal: "dinner",
    entries: [{ name: "Salmon rice", grams: 350, kcal: 700, proteinG: 45, carbsG: 70, fatG: 25 }],
  });
  expect(logged.status).toBe(200);
  expect(logged.body.ok).toBe(true);

  const day = await call("nutrition_day", { day: "2026-11-05" });
  expect(day.status).toBe(200);
  const result = day.body.result as { totals: { kcal: number }; entries: unknown[] };
  expect(result.totals.kcal).toBe(700);
  expect(result.entries.length).toBe(1);

  const missing = await call("meal_delete", { id: 999999 });
  expect(missing.status).toBe(404);

  const unknown = await call("not_a_tool", {});
  expect(unknown.status).toBe(404);

  const badJson = await POST(
    new Request("http://localhost/api/agent/meal_log", { method: "POST", body: "{oops" }),
    { params: Promise.resolve({ tool: "meal_log" }) },
  );
  expect(badJson.status).toBe(400);
});

test("supplement history windows by the logged day, not by now", () => {
  const s = supplements.createSupplement({ name: "Magnesium", dose: 200, unit: "mg" });
  supplements.logSupplement({ supplementId: s.id, day: localDay(Date.now(), "Asia/Shanghai") });
  supplements.logSupplement({ supplementId: s.id, day: "2020-01-01" });

  const history = supplements.supplementHistory(30);
  expect(history.length).toBe(1);
  expect(history[0].day).toBe(localDay(Date.now(), "Asia/Shanghai"));
  expect(history[0].items[0].name).toBe("Magnesium");
});

test("copyDay copies same-minute entries and is idempotent", () => {
  nutrition.logMeal({
    day: "2026-11-06", meal: "lunch",
    entries: [
      { name: "Rice", grams: 200, kcal: 260, proteinG: 5 },
      { name: "Chicken", grams: 150, kcal: 250, proteinG: 35 },
    ],
  });
  const first = nutrition.copyDay("2026-11-06", "2026-11-07");
  expect(first.copied).toBe(2);
  expect(nutrition.dayNutrition("2026-11-07").entries.length).toBe(2);
  const second = nutrition.copyDay("2026-11-06", "2026-11-07");
  expect(second.copied).toBe(0);
  expect(nutrition.dayNutrition("2026-11-07").entries.length).toBe(2);
});

test("measurements reject implausible weight and impossible days", () => {
  expect(() => measurements.addMeasurement({ kind: "weight", value: 0 })).toThrow("20 and 400");
  expect(() => measurements.addMeasurement({ kind: "weight", value: 75, day: "2026-02-30" })).toThrow(
    "YYYY-MM-DD",
  );
});

test("agent API rejects invalid numeric parameters with 400, not 500", async () => {
  const call = async (tool: string, body: unknown) => {
    const res = await POST(
      new Request(`http://localhost/api/agent/${tool}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ tool }) },
    );
    return res.status;
  };
  expect(await call("measurement_history", { days: "abc" })).toBe(400);
  expect(await call("measurement_history", { kind: "bodyfat" })).toBe(400);
  expect(await call("nutrition_summary", { days: "abc" })).toBe(400);
  expect(await call("workouts_recent", { limit: "abc" })).toBe(400);
  expect(await call("food_search", { limit: "abc" })).toBe(400);
  expect(await call("nutrition_day", { day: "nonsense" })).toBe(400);
});

test("healthvault_context exposes today, profile, nutrition and freshness", () => {
  const ctx = context.healthvaultContext();
  expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(ctx.timezone).toBe("Asia/Shanghai");
  expect(ctx.profile.started).toBe(false);
  expect(ctx.nutrition.day).toBe(ctx.today);
  expect(ctx.data.counts.records).toBe(0);
});
