import { expect, test } from "bun:test";
import { fixtureZip, freshDbPath } from "./helpers";

process.env.DATABASE_PATH = freshDbPath();
const { runIngest } = await import("@/lib/ingest");
const { sqlite } = await import("@/db");

const count = (table: "records" | "workouts" | "activity_summaries" | "uploads") =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

test("first ingest inserts everything", async () => {
  const r = await runIngest(fixtureZip(), "fixture.zip", 1234);
  expect(r.inserted).toBe(11);
  expect([count("records"), count("workouts"), count("activity_summaries")]).toEqual([9, 1, 1]);
  const u = sqlite.prepare("SELECT status, records_inserted AS ri FROM uploads").get() as { status: string; ri: number };
  expect(u.status).toBe("done");
  expect(u.ri).toBe(11);
});

test("second ingest is fully deduped", async () => {
  const r = await runIngest(fixtureZip(), "fixture.zip", 1234);
  expect(r.inserted).toBe(0);
  expect(r.duplicates).toBe(11);
  expect([count("records"), count("workouts"), count("activity_summaries")]).toEqual([9, 1, 1]);
});

test("ingest of a non-export zip fails cleanly", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  await expect(runIngest(zipSync({ "other.txt": strToU8("hi") }), "bad.zip", 10)).rejects.toThrow("export.xml");
  expect((sqlite.prepare("SELECT COUNT(*) AS c FROM uploads WHERE status = 'failed'").get() as { c: number }).c).toBe(1);
});
