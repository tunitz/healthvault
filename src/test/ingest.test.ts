import { beforeEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fixtureXml, fixtureZip, freshDbPath, resetDatabase } from "./helpers";

process.env.DATABASE_PATH = freshDbPath();
const { runIngest } = await import("@/lib/ingest");
const { sqlite } = await import("@/db");
const queries = await import("@/db/queries");

// Every test starts from empty tables: bun test may share one db handle across files.
beforeEach(resetDatabase);

// the fixture holds 10 records (5 steps from two devices, 3 heart rate, 2 sleep), 1 workout, 1 summary
const FIXTURE_ROWS = 12;

const count = (table: "records" | "workouts" | "activity_summaries" | "uploads") =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

test("first ingest inserts everything", async () => {
  const r = await runIngest(fixtureZip(), "fixture.zip", 1234);
  expect(r.inserted).toBe(FIXTURE_ROWS);
  expect(r.duplicates).toBe(0);
  expect([count("records"), count("workouts"), count("activity_summaries")]).toEqual([10, 1, 1]);
  const u = sqlite.prepare("SELECT status, records_inserted AS ri FROM uploads").get() as { status: string; ri: number };
  expect(u.status).toBe("done");
  expect(u.ri).toBe(FIXTURE_ROWS);
});

test("second ingest is fully deduped", async () => {
  await runIngest(fixtureZip(), "fixture.zip", 1234);
  const r = await runIngest(fixtureZip(), "fixture.zip", 1234);
  expect(r.inserted).toBe(0);
  expect(r.duplicates).toBe(FIXTURE_ROWS);
  expect([count("records"), count("workouts"), count("activity_summaries")]).toEqual([10, 1, 1]);
});

test("a workout keeps its distance, energy and heart rate from WorkoutStatistics", async () => {
  await runIngest(fixtureZip(), "fixture.zip", 1234);
  const w = sqlite.prepare(`
    SELECT duration_seconds AS seconds, total_distance AS km, total_distance_unit AS kmUnit,
           total_energy_burned AS kcal, total_energy_burned_unit AS kcalUnit,
           avg_hr AS avgHr, min_hr AS minHr, max_hr AS maxHr
    FROM workouts`).get() as Record<string, number | string | null>;

  // duration="32" durationUnit="min" must land as 1920 s, not 32 s
  expect(w.seconds).toBe(1920);
  expect(w.km).toBeCloseTo(5.2, 5);
  expect(w.kmUnit).toBe("km");
  expect(w.kcal).toBeCloseTo(320.5, 5);
  expect(w.kcalUnit).toBe("kcal");
  expect(w.avgHr).toBeCloseTo(148.5, 5);
  expect(w.minHr).toBe(96);
  expect(w.maxHr).toBe(181);
});

test("a day's steps are never summed across devices", async () => {
  await runIngest(fixtureZip(), "fixture.zip", 1234);
  const day = queries.stepsDaily(365).find((d) => d.day === "2026-09-01");
  // the watch has 3 samples (1000+2000+3000), the phone 2 (1500+2500): the watch wins,
  // so 6000 is right and 10000 would be double counting
  expect(day?.value).toBe(6000);
  expect(day?.source).toBe("Apple Watch");
});

test("nothing is left on disk: no uploaded copy, no extracted xml", async () => {
  await resetDatabase();
  const dbFile = (sqlite.prepare("PRAGMA database_list").all() as { file: string }[])[0]!.file;
  const dbDir = dirname(dbFile);
  const dbDirBefore = new Set(readdirSync(dbDir));
  const tmpBefore = new Set(readdirSync(tmpdir()));

  const result = await runIngest(fixtureZip(), "export.zip", 1234);
  expect(result.inserted).toBe(FIXTURE_ROWS);

  // the database (plus its WAL sidecars) is the only thing allowed to appear
  const newInDbDir = readdirSync(dbDir).filter((f) => !dbDirBefore.has(f));
  expect(newInDbDir.filter((f) => !/\.db(-wal|-shm)?$/.test(f))).toEqual([]);

  // and no upload/extract artifact anywhere in the temp dir
  const newInTmp = readdirSync(tmpdir()).filter((f) => !tmpBefore.has(f));
  expect(newInTmp.filter((f) => /\.(zip|xml)$|export|healthvault/i.test(f))).toEqual([]);
});

test("a multi-batch export inserts every row", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const many = Array.from({ length: 2500 }, (_, i) =>
    `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-10-${String((i % 28) + 1).padStart(2, "0")} 05:00:0${i % 10} +0800" endDate="2026-10-${String((i % 28) + 1).padStart(2, "0")} 05:05:00 +0800" value="${i}"/>`,
  ).join("");
  const xml = `<HealthData locale="en_US">${many}</HealthData>`;
  const r = await runIngest(zipSync({ "export.xml": strToU8(xml) }), "big.zip", xml.length);
  expect(r.inserted).toBe(2500);
  expect(r.duplicates).toBe(0);
  expect(count("records")).toBe(2500);
});

test("finds export.xml nested in apple_health_export/ (real iOS layout)", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const zip = zipSync({
    "apple_health_export/export.xml": strToU8(fixtureXml()),
    "apple_health_export/export_cda.xml": strToU8("<ClinicalDocument/>"),
    "apple_health_export/workout-routes/route.gpx": strToU8("<gpx/>"),
  });
  const r = await runIngest(zip, "export.zip", zip.length);
  expect(r.inserted).toBe(FIXTURE_ROWS);
  expect(count("records")).toBe(10);
});

test("ingest of a non-export zip fails cleanly", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  await expect(runIngest(zipSync({ "other.txt": strToU8("hi") }), "bad.zip", 10)).rejects.toThrow("export.xml");
  expect((sqlite.prepare("SELECT COUNT(*) AS c FROM uploads WHERE status = 'failed'").get() as { c: number }).c).toBe(1);
});
