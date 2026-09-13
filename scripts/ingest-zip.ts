#!/usr/bin/env bun
/**
 * Ingest an Apple Health export straight from disk (no server, no browser):
 *   bun scripts/ingest-zip.ts /path/to/Export.zip
 * Honours DATABASE_PATH like the app does.
 */
import { readFileSync, statSync } from "node:fs";
import { runIngest } from "@/lib/ingest";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/ingest-zip.ts <Export.zip>");
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(path));
const started = Date.now();
const result = await runIngest(bytes, path.split("/").pop() ?? "export.zip", statSync(path).size);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `ingested ${result.inserted} rows (${result.duplicates} duplicates) in ${seconds}s\n` +
    `zip: ${(statSync(path).size / 1e6).toFixed(1)} MB  →  db: ${process.env.DATABASE_PATH ?? "./data/health.db"}`,
);
