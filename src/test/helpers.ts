import { afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

export function fixtureXml(): string {
  return readFileSync(join(import.meta.dir, "export-fixture.xml"), "utf8");
}

export function fixtureZip(): Uint8Array {
  return zipSync({ "export.xml": strToU8(fixtureXml()) });
}

// Every temp database created by a test file is deleted when that file finishes: the suite
// must not leave scratch state behind on a box this small.
const tempDirs: string[] = [];

export function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "healthvault-test-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

afterAll(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** bun test may share one module registry (and therefore one db handle) across test files, so
 * every file starts from empty tables instead of whatever the previous file left behind. */
export async function resetDatabase(): Promise<void> {
  const { sqlite } = await import("@/db");
  for (const table of [
    "food_log",
    "foods",
    "nutrition_targets",
    "measurements",
    "supplement_logs",
    "supplements",
    "profile",
    "records",
    "workouts",
    "activity_summaries",
    "uploads",
  ]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
}
