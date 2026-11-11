/**
 * Cross-stack migration lock: the Next.js initializer (`src/db/index.ts`) and the Rust runner
 * (`src/db.rs`) must serialize migration checks and DDL on `${DATABASE_PATH}.migrate-lock`.
 * These tests boot both stacks concurrently against one scratch database — fresh and pre-0003 —
 * and assert that every process succeeds and the result is a consistent schema.
 *
 * The Rust binary is optional. Point `HEALTHVAULT_RUST_BIN` at it, or keep the rewrite worktree
 * next to this repository (it is discovered through `git worktree list`). Without it the suite
 * skips rather than pretending the cooperation was tested.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const WORKERS_PER_STACK = 4;
const scratchRoot = mkdtempSync(join("/tmp/opencode", "healthvault-cross-stack-"));

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

function findRustBinary(): string | undefined {
  const fromEnv = process.env.HEALTHVAULT_RUST_BIN?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (listed.status !== 0) return undefined;
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length).trim();
    if (!/rust/i.test(worktree)) continue;
    const binary = join(worktree, "target", "debug", "healthvault");
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

const rustBinary = findRustBinary();
const describeCrossStack = rustBinary ? describe : describe.skip;

interface RunResult {
  code: number | null;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  databasePath: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: databasePath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/** Boot the db module in its own process, like a Next build worker or the app. */
function bootNext(databasePath: string): Promise<RunResult> {
  return run(
    process.execPath,
    ["-e", 'import("./src/db/index.ts").then((mod) => mod.sqlite.close());'],
    databasePath,
  );
}

/** `healthvault migrate` — the Rust runner's own initializer. */
function bootRust(binary: string, databasePath: string): Promise<RunResult> {
  return run(binary, ["migrate"], databasePath);
}

function newDatabase(name: string): string {
  const directory = join(scratchRoot, name);
  mkdirSync(directory, { recursive: true });
  return join(directory, "health.db");
}

/** The committed migration folder pinned at 0002, for a legacy-shaped scratch database. */
function writeLegacyMigrations(directory: string): string {
  const folder = join(directory, "migrations-0002");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, 3);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    copyFileSync(
      join(process.cwd(), "drizzle", `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  }
  return folder;
}

async function shapeAsLegacy(databasePath: string, directory: string): Promise<void> {
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const raw = new Database(databasePath);
  try {
    migrate(drizzle(raw), { migrationsFolder: writeLegacyMigrations(directory) });
    raw
      .prepare(
        "INSERT INTO uploads (filename, bytes, status, records_inserted, records_duplicates, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("Legacy.zip", 42, "done", 0, 0, 1);
  } finally {
    raw.close();
  }
}

function expectedMigrationCount(): number {
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

function verifyDatabase(databasePath: string, legacyRow: boolean): void {
  const raw = new Database(databasePath, { readonly: true });
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
      "food_log_ingredients",
      "food_log_revisions",
      "food_revisions",
      "measures",
      "recipes",
      "recipe_ingredients",
      "profile",
      "measurements",
      "nutrition_targets",
      "supplements",
      "supplement_logs",
      "activity_summaries",
      "hv_migrations",
    ]) {
      expect(tables).toContain(table);
    }

    const applied = raw
      .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    expect(applied.count).toBe(expectedMigrationCount());
    const recorded = raw
      .prepare("SELECT COUNT(*) AS count FROM hv_migrations")
      .get() as { count: number };
    expect(recorded.count).toBe(expectedMigrationCount());

    if (legacyRow) {
      const uploads = raw
        .prepare("SELECT filename FROM uploads")
        .all() as { filename: string }[];
      expect(uploads).toEqual([{ filename: "Legacy.zip" }]);
    }
  } finally {
    raw.close();
  }

  // Both stacks used the agreed sidecar, and no process left it held.
  const lockPath = `${databasePath}.migrate-lock`;
  expect(existsSync(lockPath)).toBe(true);
  const lock = new Database(lockPath, { timeout: 250 });
  try {
    lock.exec("BEGIN IMMEDIATE; COMMIT;");
  } finally {
    lock.close();
  }
}

function expectAllSucceeded(results: RunResult[], stack: string): void {
  for (const [index, result] of results.entries()) {
    expect(result.code, `${stack} worker ${index}: ${result.stderr}`).toBe(0);
    expect(result.stderr, `${stack} worker ${index} stderr`).not.toContain("timed out");
    expect(result.stderr, `${stack} worker ${index} stderr`).not.toContain("SQLITE_BUSY");
    expect(result.stderr, `${stack} worker ${index} stderr`).not.toContain("panicked");
  }
}

describeCrossStack(
  "cross-stack migration lock",
  () => {
    // The skip branch never runs a test, so the assertion below is only reached with a binary.
    const binary = rustBinary as string;

    test(
      "Next and Rust workers migrate one fresh database without a race",
      async () => {
        const dbPath = newDatabase("fresh");
        const results = await Promise.all([
          ...Array.from({ length: WORKERS_PER_STACK }, () => bootNext(dbPath)),
          ...Array.from({ length: WORKERS_PER_STACK }, () => bootRust(binary, dbPath)),
        ]);
        expectAllSucceeded(results.slice(0, WORKERS_PER_STACK), "Next");
        expectAllSucceeded(results.slice(WORKERS_PER_STACK), "Rust");
        verifyDatabase(dbPath, false);
      },
      120_000,
    );

    test(
      "Next and Rust workers upgrade one legacy database additively",
      async () => {
        const directory = join(scratchRoot, "legacy");
        mkdirSync(directory, { recursive: true });
        const dbPath = join(directory, "health.db");
        await shapeAsLegacy(dbPath, directory);

        const results = await Promise.all([
          ...Array.from({ length: WORKERS_PER_STACK }, () => bootNext(dbPath)),
          ...Array.from({ length: WORKERS_PER_STACK }, () => bootRust(binary, dbPath)),
        ]);
        expectAllSucceeded(results.slice(0, WORKERS_PER_STACK), "Next");
        expectAllSucceeded(results.slice(WORKERS_PER_STACK), "Rust");
        verifyDatabase(dbPath, true);
      },
      120_000,
    );
  },
);
