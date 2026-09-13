import { Unzip, UnzipInflate } from "fflate";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activitySummaries, records, uploads, workouts } from "@/db/schema";
import { createHealthParser } from "@/lib/xml";

export type IngestResult = { uploadId: number; inserted: number; duplicates: number };

const CHUNK = Number(process.env.INGEST_CHUNK ?? 1000);          // rows per INSERT statement
const ZIP_SLICE = Number(process.env.INGEST_SLICE ?? 1 << 20);   // zip bytes pushed into the inflater at a time
const DEBUG = process.env.INGEST_DEBUG === "1";

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

/**
 * Streaming unzip: yields the bytes of `export.xml` as they are inflated, so peak memory
 * stays near the compressed size instead of the tens-to-hundreds of MB of XML.
 */
async function* exportXmlChunks(zip: Uint8Array): AsyncGenerator<Uint8Array> {
  const ready: Uint8Array[] = [];
  const seen: string[] = [];
  let sawEntry = false;
  let failure: Error | null = null;

  const unzipper = new Unzip((file) => {
    seen.push(file.name);
    // Real exports from the iPhone Files app live at `apple_health_export/export.xml`;
    // older/repacked ones put it at the root. Match on the basename, not the full path.
    if (file.name.toLowerCase().split("/").pop() !== "export.xml") return;
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
  if (!sawEntry) {
    throw new Error(`export.xml not found in zip (entries: ${seen.slice(0, 10).join(", ") || "none"})`);
  }
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

    let flushes = 0;
    const flush = async () => {
      flushes++;
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
      // NOTE: forcing Bun.gc(true) every 200k rows was measured *worse* (1.9 GB peak vs 1.42 GB
      // without), so GC is left to the runtime. Peak RSS on a 410 MB export is ~1.4 GB.
    };

    let sawXml = false;
    for await (const chunk of exportXmlChunks(zipBytes)) {
      sawXml = true;
      parser.write(decoder.decode(chunk, { stream: true })); // stream:true keeps split UTF-8 sequences intact
      if (parser.pending() >= CHUNK) await flush();
      if (DEBUG && flushes % 100 === 0) {
        const m = process.memoryUsage();
        console.error(
          `[mem] rows=${seen} rss=${(m.rss / 1e6).toFixed(0)}MB heap=${(m.heapUsed / 1e6).toFixed(0)}MB ` +
            `ext=${(m.external / 1e6).toFixed(0)}MB ab=${(m.arrayBuffers / 1e6).toFixed(0)}MB`,
        );
      }
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
