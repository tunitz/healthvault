#!/usr/bin/env bun
/**
 * Guards against the opaque Turbopack failure
 *   "Failed to load external module better-sqlite3-<hash>: Cannot find module ..."
 * which only ever means the native module could not be loaded at boot.
 * Runs as `predev` (and can be run by hand: `bun scripts/check-native.ts`).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkgDir = join(root, "node_modules", "better-sqlite3");

const lockfiles = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].filter(
  (f) => existsSync(join(root, f)),
);

function fail(detail: string) {
  const prebuilds = existsSync(join(pkgDir, "prebuilds"))
    ? readdirSync(join(pkgDir, "prebuilds")).filter((f) => f.endsWith(".node")).join(", ")
    : "(none found)";

  console.error(
    [
      "",
      "✖ better-sqlite3 cannot be loaded — the dev server would crash with",
      '  "Failed to load external module better-sqlite3-<hash>".',
      "",
      `  platform   : ${process.platform}-${process.arch} (bun ${Bun.version})`,
      `  package dir: ${existsSync(pkgDir) ? "present" : "MISSING"} (${pkgDir})`,
      `  prebuilds  : ${prebuilds}`,
      `  lockfiles  : ${lockfiles.join(", ") || "(none)"}`,
      `  detail     : ${detail}`,
      "",
      "  Fix (one of these):",
      "    1. rm -rf node_modules .next && bun install && bun run dev      # clean reinstall with bun (the committed lockfile)",
      "    2. bun pm untrusted                                             # see blocked lifecycle scripts; trust with `bun pm trust better-sqlite3`",
      "    3. If you installed with npm/pnpm/yarn: drop it and use bun — mixing lockfiles leaves a layout",
      "       Turbopack cannot resolve for native modules (pnpm's symlinked node_modules is the usual culprit).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!existsSync(pkgDir)) fail("node_modules/better-sqlite3 is not installed (did you run `bun install`?)");

try {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  db.exec("CREATE TABLE probe (a)");
  db.close();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

console.log(`✓ better-sqlite3 loads (${process.platform}-${process.arch}, bun ${Bun.version})`);
