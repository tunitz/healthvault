import { expect, test } from "bun:test";
import { freshDbPath, fixtureZip } from "./helpers";

process.env.DATABASE_PATH = freshDbPath();
const { POST } = await import("@/app/api/upload/route");
const { sqlite } = await import("@/db");

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
  // ingest.test.ts shares this process, so the same fixture rows may already exist:
  // assert the arithmetic invariant instead of a fixed insert count.
  expect(body.inserted + body.duplicates).toBe(11);
  expect((sqlite.prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c).toBe(9);
});
