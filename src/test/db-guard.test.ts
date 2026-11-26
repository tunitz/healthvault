/**
 * Fail-closed database-path protection.
 *
 * The regression these tests pin: `bun test` shares one module registry, so a suite's own
 * `process.env.DATABASE_PATH` assignment can arrive after a sibling already imported `@/db`. When
 * no suite won that race the initializer fell through to `./data/health.db` — the live database.
 *
 * Every path here is fake. Live-path refusal is proven by pure path resolution against throwaway
 * project roots under /tmp/opencode, and by spawning the initializer only inside a *fake* project
 * whose `data/health.db` is deliberately unopenable, so a guard bypass would surface as a SQLite
 * error instead of a refusal. No test names, reads, stats or opens this repository's `data/`
 * directory, and no test points a process at the live database.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DATABASE_FILENAME,
  TEST_MARKER_ENV,
  findProjectRoot,
  isTestProcess,
  resolveDatabasePath,
  testDatabaseViolation,
} from "@/db/guard";

/** Source locations only — resolved from this repo's package.json/drizzle, never from data/. */
const repoRoot = findProjectRoot();
const scratchRoot = mkdtempSync(join("/tmp/opencode", "healthvault-guard-test-"));

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** A throwaway "project" with the layout `findProjectRoot` looks for. */
function fakeProject(name: string): string {
  const root = join(scratchRoot, name);
  mkdirSync(join(root, "drizzle", "meta"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "drizzle", "meta", "_journal.json"), '{"entries":[]}');
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

interface RunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** Run a snippet in its own process, the way a build worker or a spawned test helper would. */
function runBun(
  script: string,
  options: { cwd: string; env: Record<string, string | undefined> },
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.on("close", (code: number | null) => resolve({ code, stderr, stdout }));
  });
}

const guardModule = JSON.stringify(join(repoRoot, "src", "db", "guard.ts"));
const initializerModule = JSON.stringify(join(repoRoot, "src", "db", "index.ts"));

describe("test-process detection", () => {
  test("the preload marker, NODE_ENV=test and a test-file entry each identify a test run", () => {
    expect(isTestProcess({ env: { [TEST_MARKER_ENV]: "1" }, argv: [], bunMain: "" })).toBe(true);
    expect(isTestProcess({ env: { NODE_ENV: "test" }, argv: [], bunMain: "" })).toBe(true);
    // NODE_ENV=production bun test: no marker and no NODE_ENV=test, so the entry file decides.
    expect(
      isTestProcess({ env: { NODE_ENV: "production" }, argv: ["bun"], bunMain: "/repo/a/x.spec.mts" }),
    ).toBe(true);
    expect(isTestProcess({ env: {}, argv: ["bun", "/repo/scripts/seed.ts"], bunMain: "" })).toBe(
      false,
    );
  });

  test("dot and underscore test/spec names are recognised", () => {
    for (const entry of [
      "/repo/src/test/a.test.ts",
      "/repo/src/test/a.spec.ts",
      "/repo/src/test/a_test.ts",
      "/repo/src/test/a_spec.ts",
      "/repo/src/test/a_test.mts",
      "/repo/src/test/a.test.tsx",
    ]) {
      expect(isTestProcess({ env: {}, argv: [], bunMain: entry })).toBe(true);
    }
  });

  test("a name that merely ends in test/spec is not a test file", () => {
    for (const entry of [
      "/repo/scripts/latest.ts",
      "/repo/scripts/contest.ts",
      "/repo/x_testing.ts",
      "/repo/test.ts",
    ]) {
      expect(isTestProcess({ env: {}, argv: [], bunMain: entry })).toBe(false);
    }
  });
});

describe("test harness ownership", () => {
  test("per-file isolation is owned by the test script, not the preload config", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const testScript = pkg.scripts?.test ?? "";
    expect(testScript).toContain("bun test");
    expect(testScript).toContain("--isolate");
    const bunfig = readFileSync(join(repoRoot, "bunfig.toml"), "utf8");
    expect(bunfig).toContain("preload");
    // No isolation key exists in Bun's test config: the flag can only come from the script.
    expect(bunfig).not.toMatch(/^\s*isolate\s*=/m);
  });
});

describe("live-path refusal", () => {
  test("the project data/ directory and the default file are refused", () => {
    const root = fakeProject("refusal");
    expect(testDatabaseViolation(join(root, "data", DEFAULT_DATABASE_FILENAME), { repoRoot: root }))
      .toContain("data/ directory");
    expect(testDatabaseViolation(join(root, "data", "backups", "copy.db"), { repoRoot: root }))
      .toContain("data/ directory");
    expect(testDatabaseViolation(join(root, "data"), { repoRoot: root })).toContain(
      "data/ directory",
    );
    // The default path is refused even when resolved from a subdirectory of the project.
    expect(
      testDatabaseViolation(join("data", DEFAULT_DATABASE_FILENAME), {
        cwd: root,
        repoRoot: root,
      }),
    ).toBeDefined();
  });

  test("a sibling directory that only shares the data/ prefix is allowed", () => {
    const root = fakeProject("prefix");
    expect(testDatabaseViolation(join(root, "data-copy", "health.db"), { repoRoot: root })).toBeUndefined();
    expect(testDatabaseViolation(join(root, "database", "health.db"), { repoRoot: root })).toBeUndefined();
  });

  test("a scratch file and :memory: are allowed", () => {
    const root = fakeProject("allowed");
    expect(testDatabaseViolation(join(scratchRoot, "scratch.db"), { repoRoot: root })).toBeUndefined();
    expect(testDatabaseViolation(":memory:", { repoRoot: root })).toBeUndefined();
  });

  test("an absolute live path is refused even when cwd is outside the project", () => {
    const root = fakeProject("elsewhere");
    const livePath = join(root, "data", DEFAULT_DATABASE_FILENAME);
    // cwd is deliberately unrelated, so the path's own project root has to be discovered from
    // the path itself; without that, <root>/data/health.db would be judged against /tmp/data.
    const violation = testDatabaseViolation(livePath, { cwd: scratchRoot, repoRoot: scratchRoot });
    expect(violation).toBeDefined();
    expect(violation!).toContain("data/ directory");
  });

  test("this repository's own default is refused without naming or touching data/", () => {
    // The real project root is discovered from package.json/drizzle only; the default path is
    // then refused by construction, so no live file is ever named, stat-ed or opened.
    expect(findProjectRoot(repoRoot)).toBe(repoRoot);
    expect(() => resolveDatabasePath({ NODE_ENV: "test" }, { cwd: repoRoot, repoRoot })).toThrow(
      /refusing to open the default database/,
    );
  });
});

describe("resolved database path", () => {
  const root = fakeProject("resolve");

  test("a non-test process still defaults to ./data/health.db", async () => {
    // Spawned, because inside a test run `Bun.main` is itself a test file — the guard's third
    // signal correctly classifies this process as a test. A plain `bun -e` is not.
    const result = await runBun(
      `import(${guardModule}).then((g) => console.log(g.resolveDatabasePath({}, { cwd: process.cwd(), repoRoot: process.cwd() })))`,
      { cwd: root, env: { NODE_ENV: undefined, DATABASE_PATH: undefined, [TEST_MARKER_ENV]: undefined } },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(join(root, "data", DEFAULT_DATABASE_FILENAME));
  });

  test("a non-test process refuses an empty DATABASE_PATH instead of defaulting", async () => {
    // `DATABASE_PATH=` in a unit file or env must not silently open ./data/health.db: that would
    // point production at a database nobody named. Spawned, because inside this suite `Bun.main`
    // is a test file and the guard would classify an in-process call as a test run.
    for (const blank of ["", "   "]) {
      const result = await runBun(
        `import(${guardModule})` +
          `.then((g) => console.log("PATH=" + g.resolveDatabasePath(process.env)))` +
          `.catch((error) => { console.error(error.message); process.exitCode = 1; })`,
        {
          cwd: root,
          env: { NODE_ENV: "production", DATABASE_PATH: blank, [TEST_MARKER_ENV]: undefined },
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("DATABASE_PATH is set but empty");
      expect(result.stdout).not.toContain("PATH=");
    }
  });

  test("a test process refuses the default instead of creating it", () => {
    expect(() => resolveDatabasePath({ NODE_ENV: "test" }, { cwd: root, repoRoot: root })).toThrow(
      /refusing to open the default database/,
    );
    // A blank value is treated as unset, so it still gets the actionable default refusal.
    expect(() =>
      resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: "" }, { cwd: root, repoRoot: root }),
    ).toThrow(/refusing to open the default database/);
    expect(() =>
      resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: "  " }, { cwd: root, repoRoot: root }),
    ).toThrow(/refusing to open the default database/);
    expect(existsSync(join(root, "data", DEFAULT_DATABASE_FILENAME))).toBe(false);
  });

  test("a test process refuses an explicitly configured live path", () => {
    expect(() =>
      resolveDatabasePath(
        { NODE_ENV: "test", DATABASE_PATH: join(root, "data", DEFAULT_DATABASE_FILENAME) },
        { cwd: root, repoRoot: root },
      ),
    ).toThrow(/refusing to open .* from a test process/);
  });

  test("a test process keeps an explicitly configured scratch path", () => {
    const scratch = join(scratchRoot, "explicit.db");
    expect(
      resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: scratch }, { cwd: root, repoRoot: root }),
    ).toBe(scratch);
  });

  test("a test process accepts :memory:", () => {
    expect(
      resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: ":memory:" }, { cwd: root, repoRoot: root }),
    ).toBe(":memory:");
  });

  test("a symlink into the data directory is refused", () => {
    const target = join(root, "data", "linked.db");
    writeFileSync(target, "");
    const link = join(scratchRoot, "innocent-looking.db");
    symlinkSync(target, link);
    expect(() =>
      resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: link }, { cwd: root, repoRoot: root }),
    ).toThrow(/resolves into the project's data\/ directory/);
  });

  test("a nonexistent leaf under a symlinked directory is refused", () => {
    // A fresh filename is the normal case: the leaf cannot be realpath'ed, so the ancestor has to
    // be, or a symlinked data/ directory would hide any not-yet-created database.
    const linkDir = join(scratchRoot, "linked-data");
    symlinkSync(join(root, "data"), linkDir);
    expect(() =>
      resolveDatabasePath(
        { NODE_ENV: "test", DATABASE_PATH: join(linkDir, DEFAULT_DATABASE_FILENAME) },
        { cwd: root, repoRoot: root },
      ),
    ).toThrow(/resolves into the project's data\/ directory/);
  });

  test("several missing segments under a symlinked directory are still resolved", () => {
    const linkDir = join(scratchRoot, "linked-data-deep");
    symlinkSync(join(root, "data"), linkDir);
    expect(() =>
      resolveDatabasePath(
        { NODE_ENV: "test", DATABASE_PATH: join(linkDir, "nested", "deeper", "fresh.db") },
        { cwd: root, repoRoot: root },
      ),
    ).toThrow(/resolves into the project's data\/ directory/);
  });

  test("a dangling symlink fails closed instead of being treated as safe", () => {
    const dangling = join(scratchRoot, "dangling.db");
    symlinkSync(join(scratchRoot, "no-such-target.db"), dangling);
    expect(() =>
      resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: dangling }, { cwd: root, repoRoot: root }),
    ).toThrow(/could not be resolved/);
  });

  test("a symlink loop fails closed instead of being treated as safe", () => {
    const first = join(scratchRoot, "loop-a");
    const second = join(scratchRoot, "loop-b");
    symlinkSync(second, first);
    symlinkSync(first, second);
    expect(() =>
      resolveDatabasePath({ NODE_ENV: "test", DATABASE_PATH: first }, { cwd: root, repoRoot: root }),
    ).toThrow(/could not be resolved/);
  });
});

describe("refusal happens before any file is opened", () => {
  test(
    "a fresh process with no DATABASE_PATH refuses and creates nothing",
    async () => {
      const root = fakeProject("no-default");
      const result = await runBun(
        `import(${guardModule}).then((g) => { g.resolveDatabasePath(process.env); console.log("OPENED"); })`,
        { cwd: root, env: { NODE_ENV: "test", DATABASE_PATH: undefined } },
      );
      expect(result.stderr).toContain("refusing to open the default database");
      expect(result.stdout).not.toContain("OPENED");
      expect(result.code).not.toBe(0);
      expect(existsSync(join(root, "data", DEFAULT_DATABASE_FILENAME))).toBe(false);
    },
    30_000,
  );

  test(
    "the initializer refuses a live-shaped path before better-sqlite3 can fail on it",
    async () => {
      // data/health.db is a *directory* here, so any attempt to open it would surface as
      // SQLITE_CANTOPEN. The only acceptable outcome is the guard's refusal.
      const root = fakeProject("unopenable");
      const livePath = join(root, "data", DEFAULT_DATABASE_FILENAME);
      mkdirSync(livePath);

      const result = await runBun(`import(${initializerModule}).then(() => console.log("OPENED"))`, {
        cwd: root,
        env: { NODE_ENV: "test", DATABASE_PATH: livePath },
      });
      expect(result.stderr).toContain("refusing to open");
      expect(result.stderr).toContain("data/ directory");
      expect(result.stderr).not.toContain("SQLITE_CANTOPEN");
      expect(result.stderr).not.toContain("unable to open database file");
      expect(result.stdout).not.toContain("OPENED");
      expect(result.code).not.toBe(0);
    },
    30_000,
  );

  test(
    "a scratch path still migrates normally",
    async () => {
      // A self-contained fake project: the migrations are copied from this repo's `drizzle/`, and
      // both the working directory and the database live under /tmp/opencode. Nothing in the real
      // project is opened.
      const root = fakeProject("migrate-scratch");
      rmSync(join(root, "drizzle"), { recursive: true, force: true });
      cpSync(join(repoRoot, "drizzle"), join(root, "drizzle"), { recursive: true });
      const dbDir = join(root, "scratch");
      mkdirSync(dbDir, { recursive: true });
      const dbPath = join(dbDir, "health.db");
      const result = await runBun(
        `import(${initializerModule}).then((m) => { m.sqlite.close(); console.log("OK"); })`,
        { cwd: root, env: { NODE_ENV: "test", DATABASE_PATH: dbPath } },
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("OK");
      expect(result.code).toBe(0);
      expect(existsSync(dbPath)).toBe(true);
    },
    60_000,
  );

  test(
    "the preload marker alone (NODE_ENV unset) is enough to refuse a live path",
    async () => {
      const root = fakeProject("marker-only");
      const livePath = join(root, "data", DEFAULT_DATABASE_FILENAME);
      const result = await runBun(`import(${initializerModule}).then(() => console.log("OPENED"))`, {
        cwd: root,
        env: { NODE_ENV: undefined, [TEST_MARKER_ENV]: "1", DATABASE_PATH: livePath },
      });
      expect(result.stderr).toContain("refusing to open");
      expect(result.stdout).not.toContain("OPENED");
      expect(result.code).not.toBe(0);
    },
    30_000,
  );
});
