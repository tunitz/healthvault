import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

export function fixtureXml(): string {
  return readFileSync(join(import.meta.dir, "export-fixture.xml"), "utf8");
}

export function fixtureZip(): Uint8Array {
  return zipSync({ "export.xml": strToU8(fixtureXml()) });
}

export function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "healthvault-test-")), "test.db");
}

/** bun test may share one module registry (and therefore one db handle) across test files, so
 * every file starts from empty tables instead of whatever the previous file left behind. */
export async function resetDatabase(): Promise<void> {
  const { sqlite } = await import("@/db");
  for (const table of ["records", "workouts", "activity_summaries", "uploads"]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
}
