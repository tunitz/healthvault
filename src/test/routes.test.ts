import { beforeEach, expect, test } from "bun:test";
import { freshDbPath, fixtureZip, resetDatabase } from "./helpers";

process.env.DATABASE_PATH = freshDbPath();
const { POST } = await import("@/app/api/upload/route");
const { sqlite } = await import("@/db");

beforeEach(resetDatabase);

test("upload route rejects a form without the file field", async () => {
  const res = await POST(new Request("http://localhost/api/upload", { method: "POST", body: new FormData() }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("file");
});

test("upload route ingests a real fixture zip", async () => {
  const form = new FormData();
  const zip = fixtureZip();
  const part = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
  form.append("file", new File([part], "fixture.zip", { type: "application/zip" }));
  const res = await POST(new Request("http://localhost/api/upload", { method: "POST", body: form }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.inserted).toBe(11);
  expect(body.duplicates).toBe(0);
  // the fixture's own row landed
  const step = sqlite
    .prepare(
      "SELECT COUNT(*) AS c FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierStepCount' " +
        "AND start_date = '2026-09-01 07:30:00 +0800' AND value = 1234",
    )
    .get() as { c: number };
  expect(step.c).toBe(1);
});
