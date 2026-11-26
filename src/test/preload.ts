/**
 * `bun test` preload (wired in `bunfig.toml`), so every test process started with this config —
 * including one that sets `NODE_ENV=production`, or spawns a child — is marked as a test run
 * before any test module can import `@/db`.
 *
 * Bun resolves `bunfig.toml` from the working directory, so a `bun test` started at the repo root
 * gets this preload; one started elsewhere may not, which is why the same guard also runs inside
 * `src/db/index.ts` at import time.
 *
 * Without `--isolate`, all test files share one module registry, so a suite's own
 * `process.env.DATABASE_PATH = …` assignment can arrive after a sibling already imported the
 * initializer. This preload removes the race: the marker is set here first, and when no
 * `DATABASE_PATH` was supplied it allocates a throwaway database under /tmp so a bare `bun test`
 * can never fall through to the live `./data/health.db`. An explicitly supplied path is checked
 * with the same guard the initializer uses, so a live path fails here with an actionable message
 * rather than at the first import.
 *
 * Per-file isolation is owned by the `test` scripts in package.json (`bun run test` and
 * `bun run test:src`, both `bun test --isolate`), not by this file or `bunfig.toml`: Bun has no
 * `isolate` key there. `--isolate` re-runs preloads for each file, giving every file a fresh
 * scratch database instead of one shared by the whole run. A bare `bun test` is still safe, just
 * shared — files then compete for the single database this preload allocated.
 *
 * The Rust rewrite was abandoned, but its old worktree still has `target/debug/healthvault`.
 * `db-migrate-cross-stack.test.ts` auto-discovers any such binary, so a bare run would boot the
 * stale runner and fail; the opt-out below keeps it skipping unless `HEALTHVAULT_RUST_BIN` is set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TEST_MARKER_ENV,
  testDatabaseSymlinkViolation,
  testDatabaseViolation,
} from "../db/guard";

process.env[TEST_MARKER_ENV] = "1";

// The cross-stack suite treats a set-but-missing `HEALTHVAULT_RUST_BIN` as "no binary" and skips;
// it only falls back to auto-discovery when the variable is unset or blank. Point it at a path
// that does not exist so the abandoned worktree binary is never picked up implicitly, while an
// explicit real path still opts in.
if (!process.env.HEALTHVAULT_RUST_BIN?.trim()) {
  // A path under a directory nothing creates: existsSync is false without racing a real file.
  process.env.HEALTHVAULT_RUST_BIN = join(tmpdir(), "healthvault-rust-disabled", "healthvault");
}

/** `/tmp/opencode` is this host's scratch convention; fall back to the OS temp dir elsewhere. */
function scratchRoot(): string {
  const preferred = "/tmp/opencode";
  try {
    return mkdtempSync(join(preferred, "healthvault-test-"));
  } catch {
    return mkdtempSync(join(tmpdir(), "healthvault-test-"));
  }
}

const configured = process.env.DATABASE_PATH?.trim();
if (configured === undefined || configured === "") {
  const directory = scratchRoot();
  process.env.DATABASE_PATH = join(directory, "health.db");
  // Remove the throwaway database at exit; a crash leaves it under /tmp/opencode, never in data/.
  process.on("exit", () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover scratch directory is harmless.
    }
  });
} else {
  // Normalize before anything reads it, so a padded value is not a second, different path.
  process.env.DATABASE_PATH = configured;
  // Fail here, before any test file loads, if the supplied path is live data. `@/db` repeats the
  // check at import time, which is what covers a spawn that bypasses this preload.
  const violation =
    testDatabaseViolation(configured) ?? testDatabaseSymlinkViolation(configured);
  if (violation) {
    throw new Error(
      `refusing to run tests against ${configured}: ${violation}. Set DATABASE_PATH to a ` +
        "fresh scratch file (for example /tmp/opencode/healthvault-test.db), or unset it and " +
        "let the preload allocate one.",
    );
  }
}
