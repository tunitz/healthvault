import { Unzip, UnzipInflate } from "fflate";
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { uploads } from "@/db/schema";
import { createHealthParser, type HealthRecordRow, type SummaryRow, type WorkoutRow } from "@/lib/xml";
import { prefillProfile } from "@/lib/services/profile";

export type IngestResult = { uploadId: number; inserted: number; duplicates: number };

const CHUNK = Number(process.env.INGEST_CHUNK ?? 1000);
const ZIP_SLICE = Number(process.env.INGEST_SLICE ?? 1 << 20);
// A real 4-year export inflates to ~410 MB. 1.5 GiB leaves headroom without letting a
// crafted zip decompress without bound (the zip itself is capped at 200 MB by the route).
const MAX_XML_BYTES = Number(process.env.INGEST_MAX_XML ?? 1536 * 1024 * 1024);

/**
 * Inserts go through raw prepared statements, not the query builder.
 *
 * Why: the builder rebuilds a statement with CHUNK x N placeholders for every batch and
 * `.returning()` materialises a row object per insert. On a 910k-row export that is ~900
 * builds and ~910k throwaway objects, which dominated both runtime and peak memory.
 * Prepared statements are compiled once; `changes` reports what actually landed, so the
 * duplicate count falls out without RETURNING.
 */
const insertRecord = sqlite.prepare(
  `INSERT INTO records (type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name)
   VALUES (@typeIdentifier, @unit, @value, @startDate, @startMs, @day, @endDate, @endMs, @sourceName)
   ON CONFLICT DO NOTHING`,
);
const insertWorkout = sqlite.prepare(
  `INSERT INTO workouts (workout_activity_type, start_date, start_ms, day, end_date, end_ms,
                         duration_seconds, total_distance, total_distance_unit, total_energy_burned,
                         total_energy_burned_unit, avg_hr, min_hr, max_hr, source_name, metadata_json)
   VALUES (@workoutActivityType, @startDate, @startMs, @day, @endDate, @endMs,
           @durationSeconds, @totalDistance, @totalDistanceUnit, @totalEnergyBurned,
           @totalEnergyBurnedUnit, @avgHr, @minHr, @maxHr, @sourceName, @metadataJson)
   ON CONFLICT DO NOTHING`,
);
const insertSummary = sqlite.prepare(
  `INSERT INTO activity_summaries (date_components, day, active_energy_burned, active_energy_burned_goal,
                                   apple_move_minutes, apple_move_minutes_goal, apple_exercise_time,
                                   apple_exercise_time_goal, apple_stand_hours, apple_stand_hours_goal)
   VALUES (@dateComponents, @day, @activeEnergyBurned, @activeEnergyBurnedGoal,
           @appleMoveMinutes, @appleMoveMinutesGoal, @appleExerciseTime,
           @appleExerciseTimeGoal, @appleStandHours, @appleStandHoursGoal)
   ON CONFLICT DO NOTHING`,
);

// better-sqlite3 rejects `undefined` bindings; SQLite wants NULL for absent fields.
const orNull = <T extends object>(row: T): T => {
  const out = { ...row } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) out[k] = null;
  return out as T;
};

/** One transaction per batch: sync (better-sqlite3), so it cannot be awaited mid-way. */
const writeBatch = sqlite.transaction((records: HealthRecordRow[], workouts: WorkoutRow[], summaries: SummaryRow[]) => {
  let n = 0;
  for (const r of records) n += insertRecord.run(r).changes;
  for (const w of workouts) n += insertWorkout.run(orNull(w)).changes;
  for (const s of summaries) n += insertSummary.run(orNull(s)).changes;
  return n;
});

async function* exportXmlChunks(zip: Uint8Array): AsyncGenerator<Uint8Array> {
  const ready: Uint8Array[] = [];
  const seen: string[] = [];
  let sawEntry = false;
  let failure: Error | null = null;
  let inflated = 0;

  const unzipper = new Unzip((file) => {
    seen.push(file.name);
    if (file.name.toLowerCase().split("/").pop() !== "export.xml") return;
    sawEntry = true;
    file.ondata = (err, chunk) => {
      if (err) failure = err instanceof Error ? err : new Error(String(err));
      else if (chunk.length) {
        inflated += chunk.length;
        if (inflated > MAX_XML_BYTES) {
          failure = new Error(
            `export.xml exceeds the ${(MAX_XML_BYTES / 1024 / 1024).toFixed(0)} MB uncompressed cap; ` +
              `set INGEST_MAX_XML to raise it`,
          );
          return;
        }
        ready.push(chunk);
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);

  for (let off = 0; off < zip.length; off += ZIP_SLICE) {
    const end = Math.min(off + ZIP_SLICE, zip.length);
    unzipper.push(zip.subarray(off, end), end >= zip.length);
    while (ready.length) yield ready.shift()!;
    if (failure) throw failure;
    await Promise.resolve();
  }
  if (failure) throw failure;
  if (!sawEntry) throw new Error(`export.xml not found in zip (entries: ${seen.slice(0, 10).join(", ") || "none"})`);
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

    const flush = () => {
      const parsed = parser.drain();
      seen += parsed.records.length + parsed.workouts.length + parsed.summaries.length;
      inserted += writeBatch(parsed.records, parsed.workouts, parsed.summaries);
    };

    let sawXml = false;
    for await (const chunk of exportXmlChunks(zipBytes)) {
      sawXml = true;
      parser.write(decoder.decode(chunk, { stream: true })); // stream:true keeps split UTF-8 sequences intact
      if (parser.pending() >= CHUNK) flush();
    }
    if (!sawXml) throw new Error("export.xml not found in zip");
    parser.write(decoder.decode());
    parser.end();
    flush();

    // <Me> carries birth date and biological sex; height arrives as a quantity record.
    // A prefill failure must not mark a fully imported file as failed.
    let warning: string | null = null;
    try {
      const me = parser.characteristics();
      const height = sqlite
        .prepare(
          `SELECT value, unit FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierHeight'
           AND value > 0 ORDER BY start_ms DESC LIMIT 1`,
        )
        .get() as { value: number; unit: string } | undefined;
      const heightCm = height
        ? height.unit.toLowerCase() === "in"
          ? height.value * 2.54
          : height.unit.toLowerCase() === "ft"
            ? height.value * 30.48
            : height.value
        : undefined;
      if (me.dateOfBirth || me.biologicalSex || heightCm) {
        prefillProfile({ birthDate: me.dateOfBirth, sex: me.biologicalSex, heightCm });
      }
    } catch (e) {
      warning = `profile prefill skipped: ${e instanceof Error ? e.message : String(e)}`;
    }

    const duplicates = seen - inserted;
    await db.update(uploads)
      .set({
        status: "done",
        recordsInserted: inserted,
        recordsDuplicates: duplicates,
        finishedAtMs: Date.now(),
        ...(warning ? { message: warning } : {}),
      })
      .where(eq(uploads.id, handle.id));
    return { uploadId: handle.id, inserted, duplicates };
  } catch (e) {
    await db.update(uploads)
      .set({ status: "failed", message: e instanceof Error ? e.message : String(e), finishedAtMs: Date.now() })
      .where(eq(uploads.id, handle.id));
    throw e;
  }
}
