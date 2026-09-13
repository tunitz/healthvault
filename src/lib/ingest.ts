import { Unzip, UnzipInflate } from "fflate";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activitySummaries, records, uploads, workouts } from "@/db/schema";
import { createHealthParser } from "@/lib/xml";

export type IngestResult = { uploadId: number; inserted: number; duplicates: number };

const CHUNK = 1000;            // rows per INSERT statement
const ZIP_SLICE = 1 << 20;     // 1 MiB of zip pushed into the inflater at a time

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

/**
 * Streaming unzip: yields the bytes of `export.xml` as they are inflated, so peak memory
 * stays near the compressed size instead of the tens-to-hundreds of MB of XML.
 */
async function* exportXmlChunks(zip: Uint8Array): AsyncGenerator<Uint8Array> {
  const ready: Uint8Array[] = [];
  let sawEntry = false;
  let failure: Error | null = null;

  const unzipper = new Unzip((file) => {
    if (file.name !== "export.xml") return;
    sawEntry = true;
    file.ondata = (err, chunk) => {
      if (err) failure = err instanceof Error ? err : new Error(String(err));
      else if (chunk.length) ready.push(chunk);
    };
    file.start();
  });
  unzipper.register(UnzipInflate);

  for (let off = 0; off < zip.length; off += ZIP_SLICE) {
    const end = Math.min(off + ZIP_SLICE, zip.length);
    unzipper.push(zip.subarray(off, end), end >= zip.length);
    while (ready.length) yield ready.shift()!;
    if (failure) throw failure;
    await Promise.resolve(); // let the event loop breathe between slices
  }
  if (failure) throw failure;
  if (!sawEntry) throw new Error("export.xml not found in zip");
}

export async function runIngest(zipBytes: Uint8Array, filename: string, bytes: number): Promise<IngestResult> {
  const [handle] = await db
    .insert(uploads)
    .values({ filename, bytes, status: "running", createdAtMs: Date.now() })
    .returning({ id: uploads.id });

  try {
    const parser = createHealthParser();
    const decoder = new TextDecoder();
    let inserted = 0;
    let seen = 0;

    const flush = async () => {
      const parsed = parser.drain();
      seen += parsed.records.length + parsed.workouts.length + parsed.summaries.length;
      for (const c of chunks(parsed.records, CHUNK)) {
        inserted += (await db.insert(records).values(c).onConflictDoNothing().returning({ id: records.id })).length;
      }
      for (const c of chunks(parsed.workouts, CHUNK)) {
        inserted += (await db.insert(workouts).values(c).onConflictDoNothing().returning({ id: workouts.id })).length;
      }
      for (const c of chunks(parsed.summaries, CHUNK)) {
        inserted += (await db.insert(activitySummaries).values(c).onConflictDoNothing().returning({ id: activitySummaries.id })).length;
      }
    };

    let sawXml = false;
    for await (const chunk of exportXmlChunks(zipBytes)) {
      sawXml = true;
      parser.write(decoder.decode(chunk, { stream: true })); // stream:true keeps split UTF-8 sequences intact
      if (parser.pending() >= CHUNK) await flush();
    }
    if (!sawXml) throw new Error("export.xml not found in zip");
    parser.write(decoder.decode());
    parser.end();
    await flush();

    const duplicates = seen - inserted;
    await db.update(uploads)
      .set({ status: "done", recordsInserted: inserted, recordsDuplicates: duplicates, finishedAtMs: Date.now() })
      .where(eq(uploads.id, handle.id));
    return { uploadId: handle.id, inserted, duplicates };
  } catch (e) {
    await db.update(uploads)
      .set({ status: "failed", message: e instanceof Error ? e.message : String(e), finishedAtMs: Date.now() })
      .where(eq(uploads.id, handle.id));
    throw e;
  }
}
