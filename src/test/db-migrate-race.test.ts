/**
 * `next build` collects page data in several parallel worker processes, and each one imports the
 * app's db module. A fresh database must therefore be brought up by exactly one of them while
 * the others wait — not fail on a half-applied schema. Runs against a throwaway SQLite file
 * under /tmp, never `data/health.db`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const scratchDir = mkdtempSync(join("/tmp/opencode", "healthvault-migrate-race-"));
const dbPath = join(scratchDir, "health.db");
const WORKERS = 8;

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Boot the db module in its own process, the way a build worker does. */
function bootWorker(): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["-e", 'import("./src/db/index.ts").then((mod) => mod.sqlite.close());'],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_PATH: dbPath },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function expectedMigrationCount(): number {
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

describe("concurrent first boot", () => {
  test(
    "parallel workers migrate a fresh database once and all succeed",
    async () => {
      const results = await Promise.all(Array.from({ length: WORKERS }, () => bootWorker()));
      for (const [index, result] of results.entries()) {
        expect(result.stderr).not.toContain("already exists");
        expect(result.stderr, `worker ${index} stderr`).toBe("");
        expect(result.code, `worker ${index} exit code`).toBe(0);
      }

      const raw = new Database(dbPath, { readonly: true });
      try {
        expect(raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });

        const tables = (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((row) => row.name);
        for (const table of [
          "uploads",
          "records",
          "workouts",
          "foods",
          "food_log",
          "measures",
          "recipes",
          "recipe_ingredients",
          "profile",
          "measurements",
          "nutrition_targets",
          "supplements",
          "supplement_logs",
          "activity_summaries",
        ]) {
          expect(tables).toContain(table);
        }

        const applied = raw
          .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
          .get() as { count: number };
        expect(applied.count).toBe(expectedMigrationCount());
      } finally {
        raw.close();
      }
    },
    60_000,
  );

  test(
    "parallel workers on an already-migrated database only read the schema",
    async () => {
      const results = await Promise.all(Array.from({ length: WORKERS }, () => bootWorker()));
      for (const result of results) expect(result.code).toBe(0);

      const raw = new Database(dbPath, { readonly: true });
      try {
        expect(raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        const applied = raw
          .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
          .get() as { count: number };
        expect(applied.count).toBe(expectedMigrationCount());
      } finally {
        raw.close();
      }
    },
    60_000,
  );
});
