import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const file = process.env.DATABASE_PATH ?? join(process.cwd(), "data", "health.db");
const dir = dirname(file);
const defaultDataDir = join(process.cwd(), "data");
const dirExisted = existsSync(dir);
mkdirSync(dir, { recursive: true, mode: 0o700 });
export const sqlite = new Database(file);
// Health data: the database file is user-private. Only lock down the directory when it is
// ours (the default data dir, or one this process just created) — never chmod /tmp or cwd
// because DATABASE_PATH happened to point inside it.
try {
  if (dir === defaultDataDir || !dirExisted) chmodSync(dir, 0o700);
  if (existsSync(file)) chmodSync(file, 0o600);
} catch {
  // Best effort: a filesystem that cannot chmod (e.g. some containers) must still work.
}
sqlite.pragma("journal_mode = WAL");
export const db = drizzle(sqlite, { schema });

// Idempotent: brings a brand-new file (tests, first boot) up to the current schema.
migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });

// An ingest cannot survive a restart: any row still "running" at boot was interrupted.
// Mark it failed so the UI stops showing a spinner that will never finish.
//
// Only old rows: a short-lived script that opens this module (seed, diagnostic) must not
// kill an upload that the live service is running right now.
sqlite
  .prepare(
    `UPDATE uploads SET status = 'failed',
       message = COALESCE(message, 'interrupted by a service restart'),
       finished_at_ms = COALESCE(finished_at_ms, ?)
     WHERE status = 'running' AND created_at_ms < ?`,
  )
  .run(Date.now(), Date.now() - 10 * 60 * 1000);
