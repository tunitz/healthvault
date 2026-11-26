/**
 * Fail-closed protection for the live database path.
 *
 * By default `bun test` shares one module registry across files, so a suite that assigns
 * `process.env.DATABASE_PATH` in its own module body may do so after a sibling already imported
 * `@/db` — and a suite that forgets the assignment would otherwise fall through to
 * `./data/health.db`, which is the user's live database (and `./data/` also holds its backups).
 * A mistaken run against that file rewrites real health records, so the decision is made here,
 * before anything is opened, and a test process is refused outright.
 *
 * Deliberately dependency-free (`node:fs` / `node:path` only): importing the guard must never
 * pull in better-sqlite3 or the initializer it is protecting.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Set by `src/test/preload.ts` (wired in `bunfig.toml`). A marker that survives an explicit
 * `NODE_ENV` override, and that test-spawned subprocesses inherit through the environment.
 */
export const TEST_MARKER_ENV = "HEALTHVAULT_TESTING";
export const DEFAULT_DATABASE_FILENAME = "health.db";

/**
 * `foo.test.ts`, `foo.spec.ts`, `foo_test.ts`, `foo_spec.mts` — the `*.test.*`, `*.spec.*`,
 * `*_test.*` and `*_spec.*` patterns Bun uses to find test files. Only a dot or underscore counts,
 * so a file that merely ends in `test.ts` (`latest.ts`, or a plain `test.ts`) is not a test.
 */
const TEST_FILE_RE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Walk up from `start` to the repository root, identified by a `package.json` next to the
 * committed Drizzle folder. Using the filesystem instead of `import.meta.dir` keeps this working
 * when Next bundles the module, and finding the root from the cwd covers `bun test` run from a
 * subdirectory (where a symlinked or absolute `DATABASE_PATH` could still name the live file).
 */
export function findProjectRoot(start: string = process.cwd()): string {
  const origin = resolve(start);
  let directory = origin;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(directory, "package.json")) &&
      existsSync(join(directory, "drizzle", "meta", "_journal.json"))
    ) {
      return directory;
    }
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  return origin;
}

function isInside(candidate: string, directory: string): boolean {
  const path = resolve(candidate);
  const root = resolve(directory);
  return path === root || path.startsWith(`${root}${sep}`);
}

export interface TestProcessSignals {
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  bunMain?: string | undefined;
}

/**
 * Is this process a test runner? Three independent signals, any one of which is enough:
 *
 * - the preload marker (`HEALTHVAULT_TESTING=1`), which children inherit;
 * - `NODE_ENV=test`, which `bun test` sets by default;
 * - the entry module being a `*.test.*`, `*.spec.*`, `*_test.*` or `*_spec.*` file, which catches
 *   `NODE_ENV=production bun test` and runs from a directory where `bunfig.toml` was not found.
 */
export function isTestProcess(signals: TestProcessSignals = {}): boolean {
  const env = signals.env ?? process.env;
  if (env[TEST_MARKER_ENV] === "1") return true;
  if (env.NODE_ENV === "test") return true;
  const bunMain =
    "bunMain" in signals
      ? signals.bunMain
      : typeof Bun === "undefined"
        ? undefined
        : Bun.main;
  const argv = signals.argv ?? process.argv;
  return [bunMain, argv[1]].some(
    (candidate) => typeof candidate === "string" && TEST_FILE_RE.test(candidate),
  );
}

export interface DatabasePathContext {
  cwd?: string;
  repoRoot?: string;
}

function insideProjectData(target: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const dataDir = join(root, "data");
    if (isInside(target, dataDir)) return dataDir;
  }
  return undefined;
}

/**
 * Every project root a path could belong to: the one above `cwd`, and the one above the path
 * itself. The second matters for an absolute path handed to a test process whose cwd is somewhere
 * else (a spawned worker, a script started from /tmp) — otherwise `<repo>/data/health.db` would be
 * judged against `/tmp/data` and slip through.
 *
 * The walk starts at the path's *parent*, never at the file itself, so deciding whether
 * `data/health.db` is live does not even `stat` that file (a file cannot contain a package.json).
 */
function projectRoots(target: string, cwd: string, explicit?: string): string[] {
  const roots = new Set<string>([
    explicit ?? findProjectRoot(cwd),
    findProjectRoot(dirname(target)),
  ]);
  return [...roots];
}

/**
 * Why a test process must not open `file`, or `undefined` when it may. It resolves strings only —
 * no database handle and no reading of the target — so the live path can be judged without being
 * opened. Root discovery walks up looking for `package.json` and `drizzle/`, never reading the
 * database or its backups.
 */
export function testDatabaseViolation(
  file: string,
  context: DatabasePathContext = {},
): string | undefined {
  if (file === ":memory:") return undefined;
  const cwd = context.cwd ?? process.cwd();
  const target = resolve(cwd, file);
  const dataDir = insideProjectData(target, projectRoots(target, cwd, context.repoRoot));
  if (dataDir) {
    return (
      `it is inside the project's data/ directory (${dataDir}), which holds the live ` +
      "database and its backups"
    );
  }
  return undefined;
}

/**
 * The symlink-free form of `target`, even when the leaf does not exist yet. The deepest existing
 * ancestor is resolved and the missing segments are re-appended, so a fresh filename under a
 * symlinked directory is judged by where that directory really points.
 *
 * Throws when an existing segment cannot be resolved (a permission error or a symlink loop) or is
 * a dangling symlink. An unresolvable path is not evidence of safety, so the caller refuses
 * instead of treating the failure as "not a symlink".
 */
function resolveExistingPrefix(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    let exists = true;
    try {
      lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT/ENOTDIR: the leaf (or a segment) is simply not there yet; keep walking up.
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      exists = false;
    }
    if (exists) {
      // `realpathSync` follows the whole chain, including a dangling leaf symlink, which throws.
      const resolved = realpathSync(current);
      return missing.length > 0 ? join(resolved, ...missing.reverse()) : resolved;
    }
    const parent = resolve(current, "..");
    if (parent === current) throw new Error(`cannot resolve ${target}`);
    missing.push(basename(current));
    current = parent;
  }
}

/**
 * The same answer for a path that resolves (possibly through a symlink) into the live data
 * directory. Separate from `testDatabaseViolation` so that function stays pure; this one follows
 * symlinks, but only ever resolves paths — it never opens or reads the file it judges.
 */
export function testDatabaseSymlinkViolation(
  file: string,
  context: DatabasePathContext = {},
): string | undefined {
  if (file === ":memory:") return undefined;
  const cwd = context.cwd ?? process.cwd();
  const target = resolve(cwd, file);
  let real: string;
  try {
    real = resolveExistingPrefix(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `it could not be resolved to rule out a symlink into the live data/ directory (${reason})`;
  }
  const dataDir = insideProjectData(real, projectRoots(real, cwd, context.repoRoot));
  if (dataDir) {
    return `it resolves into the project's data/ directory (${real})`;
  }
  return undefined;
}

function refuseDefaultTestDatabase(): Error {
  return new Error(
    "refusing to open the default database (./data/health.db) in a test process: that file is " +
      "live HealthVault data. Set DATABASE_PATH to a fresh scratch file (for example " +
      "DATABASE_PATH=/tmp/healthvault-test/health.db) or run `bun test` with no DATABASE_PATH, " +
      "whose preload allocates a throwaway database automatically.",
  );
}

/**
 * The database path this process may open. Under test the default is refused instead of being
 * silently created, and a path into the project's `data/` directory is refused even when it was
 * set explicitly. Outside a test process this returns the configured path (trimmed), else
 * `./data/health.db`, except that a `DATABASE_PATH` that is present but empty is an error:
 * silently falling back to `./data/health.db` would hide a broken unit or env file and point a
 * production service at a database nobody named.
 */
export function resolveDatabasePath(
  env: Record<string, string | undefined> = process.env,
  context: DatabasePathContext = {},
): string {
  const cwd = context.cwd ?? process.cwd();
  const testProcess = isTestProcess({ env });
  // Trim before deciding: `DATABASE_PATH=` or padding around a path is a stray export, and the
  // trimmed value is what actually gets opened (a raw padded path would silently open a different
  // file). Emptiness is handled below.
  const configured = env.DATABASE_PATH?.trim();
  if (configured === undefined || configured === "") {
    if (testProcess) throw refuseDefaultTestDatabase();
    if (env.DATABASE_PATH !== undefined) {
      throw new Error(
        "DATABASE_PATH is set but empty: unset it to use ./data/health.db, or give it the " +
          "absolute path of the database this process should open.",
      );
    }
    return join(cwd, "data", DEFAULT_DATABASE_FILENAME);
  }
  if (testProcess) {
    const violation =
      testDatabaseViolation(configured, { ...context, cwd }) ??
      testDatabaseSymlinkViolation(configured, { ...context, cwd });
    if (violation) {
      throw new Error(
        `refusing to open ${configured} from a test process: ${violation}. Point ` +
          "DATABASE_PATH at a fresh scratch file instead; the live database is never test input.",
      );
    }
  }
  return configured;
}
