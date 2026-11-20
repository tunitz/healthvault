import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { sqlite } from "@/db";
import { requireSessionOr401 } from "@/lib/auth";
import { currentDay } from "@/lib/services/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated WAL-safe SQLite database backup download.
 * Uses SQLite's online backup API (`sqlite.backup()`) so active WAL transactions are
 * snapshotted consistently without corrupting or locking live writes.
 */
export async function GET() {
  const denied = await requireSessionOr401();
  if (denied) return denied;

  const tmpPath = path.join(os.tmpdir(), `healthvault-backup-${randomUUID()}.db`);
  try {
    await sqlite.backup(tmpPath);
    const bytes = await readFile(tmpPath);
    const stamp = currentDay();
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="healthvault-backup-${stamp}.db"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Backup failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}
