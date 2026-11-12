import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolveDatabasePath } from "./guard";
import * as schema from "./schema";

// Fails closed before anything is opened: a test process may never reach the live database.
const file = resolveDatabasePath(process.env);
const dir = dirname(file);
const defaultDataDir = join(process.cwd(), "data");
const dirExisted = existsSync(dir);
mkdirSync(dir, { recursive: true, mode: 0o700 });
/**
 * How long this process waits for the migration lock or a competing SQLite write. The Rust
 * runner uses the same 30 s, so neither stack declares the other's migration timed out while
 * it is still working.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;
export const sqlite = new Database(file, { timeout: MIGRATION_LOCK_TIMEOUT_MS });
// Health data: the database file is user-private. Only lock down the directory when it is
// ours (the default data dir, or one this process just created) — never chmod /tmp or cwd
// because DATABASE_PATH happened to point inside it.
try {
  if (dir === defaultDataDir || !dirExisted) chmodSync(dir, 0o700);
  // turbopackIgnore: this is the runtime database path, not a bundled asset.
  if (existsSync(/* turbopackIgnore: true */ file)) chmodSync(/* turbopackIgnore: true */ file, 0o600);
} catch {
  // Best effort: a filesystem that cannot chmod (e.g. some containers) must still work.
}
const migrationsFolder = join(process.cwd(), "drizzle");
const MIGRATION_LOCK_SUFFIX = ".migrate-lock";

/**
 * The lock every process must agree on. Resolving the database first means a `DATABASE_PATH`
 * that is a symlink and its target share one lock; resolving the parent covers a fresh file,
 * which does not exist yet when the lock is taken.
 */
function migrationLockPath(databasePath: string): string {
  try {
    return `${realpathSync(databasePath)}${MIGRATION_LOCK_SUFFIX}`;
  } catch {
    try {
      return `${join(realpathSync(dirname(databasePath)), basename(databasePath))}${MIGRATION_LOCK_SUFFIX}`;
    } catch {
      return `${databasePath}${MIGRATION_LOCK_SUFFIX}`;
    }
  }
}

/** better-sqlite3 reports SQLite result codes such as `SQLITE_BUSY` on `error.code`. */
function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || code === "SQLITE_LOCKED";
}

/** Replace a bare SQLite busy error with the process and path that were actually competing. */
function migrationBusyError(
  error: unknown,
  lockFile: string,
  action: string,
): Error | undefined {
  if (!isBusy(error)) return undefined;
  return new Error(
    `${action} timed out after ${MIGRATION_LOCK_TIMEOUT_MS / 1_000}s: ${lockFile} is locked by ` +
      `another process. Another HealthVault process (a Next build worker, a script, or the Rust ` +
      `runner) is migrating ${file}; retry once it finishes.`,
    { cause: error },
  );
}

/**
 * `next build` collects page data in parallel worker processes, and each one imports this
 * module against the same database. Drizzle's migrator reads the applied-migrations row
 * *before* it opens its transaction, so two workers booting a fresh file can both decide to
 * build the schema, and the loser dies with "table ... already exists".
 *
 * Serialize initialization with a write transaction in a sibling SQLite file, `${db}.migrate-lock`.
 * The Rust runner takes the same lock with `BEGIN IMMEDIATE`, so a Next build and a Rust
 * `migrate`/`serve` boot cannot race each other either. SQLite releases the lock when the
 * process exits (even after a crash), which a timeout-based lock file cannot promise. The lock
 * database stores nothing: it exists only to be locked.
 */
function withMigrationLock(run: () => void) {
  if (file === ":memory:") {
    run();
    return;
  }
  const lockFile = migrationLockPath(file);
  const lock = new Database(lockFile, { timeout: MIGRATION_LOCK_TIMEOUT_MS });
  try {
    try {
      chmodSync(lockFile, 0o600);
    } catch {
      // Best effort, as above; the lock file holds no health data.
    }
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw migrationBusyError(error, lockFile, "acquiring the migration lock") ?? error;
    }
    try {
      run();
    } catch (error) {
      throw migrationBusyError(error, lockFile, "migrating") ?? error;
    } finally {
      try {
        lock.exec("COMMIT");
      } catch {
        // Nothing was written; closing the handle releases the lock regardless.
      }
    }
  } finally {
    lock.close();
  }
}

export const db = drizzle(sqlite, { schema });

// Idempotent: brings a brand-new file (tests, first boot) up to the current schema. Setting the
// journal mode under the same lock keeps concurrent first boots from contending on it too.
withMigrationLock(() => {
  sqlite.pragma("journal_mode = WAL");
  migrate(db, { migrationsFolder });
});

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
