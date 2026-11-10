/**
 * WAL-safe database backup using SQLite's online backup API.
 *
 * The app runs with journal_mode=WAL, so copying health.db while the server is live can
 * capture a torn state (the newest commits still live in health.db-wal). The sqlite CLI is
 * not installed on this host, so this uses the same better-sqlite3 driver the app already
 * depends on.
 *
 *   bun scripts/backup-db.ts [destination]
 *
 * Default destination: data/backups/health-YYYY-MM-DDTHH-mm-ss.db
 */
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

const source = process.env.DATABASE_PATH ?? join(process.cwd(), "data", "health.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
const dest = resolve(process.argv[2] ?? join(dirname(source), "backups", `health-${stamp}.db`));

mkdirSync(dirname(dest), { recursive: true });

// readonly: a backup must never write to the live database.
const db = new Database(source, { readonly: true });
const check = db.pragma("integrity_check", { simple: true });
if (check !== "ok") {
  db.close();
  throw new Error(`integrity_check failed on ${source}: ${String(check)}`);
}

await db.backup(dest);
db.close();

// The database contains health data: never leave a backup group/world readable.
chmodSync(dest, 0o600);

const { size } = statSync(dest);
console.log(`backup ok: ${dest} (${(size / 1024 / 1024).toFixed(1)} MB, integrity ok)`);
