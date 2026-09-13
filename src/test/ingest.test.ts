import { beforeEach, expect, test } from "bun:test";
import { fixtureXml, fixtureZip, freshDbPath, resetDatabase } from "./helpers";

process.env.DATABASE_PATH = freshDbPath();
const { runIngest } = await import("@/lib/ingest");
const { sqlite } = await import("@/db");

// Every test starts from empty tables: bun test may share one db handle across files.
beforeEach(resetDatabase);

const count = (table: "records" | "workouts" | "activity_summaries" | "uploads") =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

test("first ingest inserts everything", async () => {
  const r = await runIngest(fixtureZip(), "fixture.zip", 1234);
  expect(r.inserted).toBe(11);
  expect(r.duplicates).toBe(0);
  expect([count("records"), count("workouts"), count("activity_summaries")]).toEqual([9, 1, 1]);
  const u = sqlite.prepare("SELECT status, records_inserted AS ri FROM uploads").get() as { status: string; ri: number };
  expect(u.status).toBe("done");
  expect(u.ri).toBe(11);
});

test("second ingest is fully deduped", async () => {
  await runIngest(fixtureZip(), "fixture.zip", 1234);
  const r = await runIngest(fixtureZip(), "fixture.zip", 1234);
  expect(r.inserted).toBe(0);
  expect(r.duplicates).toBe(11);
  expect([count("records"), count("workouts"), count("activity_summaries")]).toEqual([9, 1, 1]);
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
  expect(r.inserted).toBe(11);
  expect(count("records")).toBe(9);
});

test("ingest of a non-export zip fails cleanly", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  await expect(runIngest(zipSync({ "other.txt": strToU8("hi") }), "bad.zip", 10)).rejects.toThrow("export.xml");
  expect((sqlite.prepare("SELECT COUNT(*) AS c FROM uploads WHERE status = 'failed'").get() as { c: number }).c).toBe(1);
});
