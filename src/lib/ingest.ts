import { unzipSync } from "fflate";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activitySummaries, records, uploads, workouts } from "@/db/schema";
import { parseHealthXml } from "@/lib/xml";

export type IngestResult = { uploadId: number; inserted: number; duplicates: number };

const CHUNK = 1000;

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

export async function runIngest(zipBytes: Uint8Array, filename: string, bytes: number): Promise<IngestResult> {
  const [handle] = await db
    .insert(uploads)
    .values({ filename, bytes, status: "running", createdAtMs: Date.now() })
    .returning({ id: uploads.id });

  try {
    const files = unzipSync(zipBytes);
    const xmlBytes = files["export.xml"];
    if (!xmlBytes) throw new Error("export.xml not found in zip");
    const parsed = parseHealthXml(new TextDecoder().decode(xmlBytes));

    let inserted = 0;
    for (const c of chunks(parsed.records, CHUNK)) {
      inserted += (await db.insert(records).values(c).onConflictDoNothing().returning({ id: records.id })).length;
    }
    for (const c of chunks(parsed.workouts, CHUNK)) {
      inserted += (await db.insert(workouts).values(c).onConflictDoNothing().returning({ id: workouts.id })).length;
    }
    for (const c of chunks(parsed.summaries, CHUNK)) {
      inserted += (await db.insert(activitySummaries).values(c).onConflictDoNothing().returning({ id: activitySummaries.id })).length;
    }

    const total = parsed.records.length + parsed.workouts.length + parsed.summaries.length;
    await db.update(uploads)
      .set({ status: "done", recordsInserted: inserted, recordsDuplicates: total - inserted, finishedAtMs: Date.now() })
      .where(eq(uploads.id, handle.id));
    return { uploadId: handle.id, inserted, duplicates: total - inserted };
  } catch (e) {
    await db.update(uploads)
      .set({ status: "failed", message: String(e), finishedAtMs: Date.now() })
      .where(eq(uploads.id, handle.id));
    throw e;
  }
}
