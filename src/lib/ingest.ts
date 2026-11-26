import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Unzip, UnzipInflate } from "fflate";
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { invalidateRecordCaches, WORKOUT_DEDUP } from "@/db/queries";
import { uploads } from "@/db/schema";
import {
  createHealthParser,
  type HealthRecordRow,
  type MeCharacteristics,
  type SummaryRow,
  type WorkoutRow,
} from "@/lib/xml";
import { parseGpxRoute, type ParsedGpxRoute } from "@/lib/gpx";
import { parseEcgCsv, type ParsedEcg } from "@/lib/ecg";
import { prefillProfile } from "@/lib/services/profile";

type NativeIngestResult = {
  seen: number;
  inserted: number;
  routesInserted: number;
  ecgsInserted: number;
  me: MeCharacteristics;
};

let cachedNativeBinary: string | null | undefined;

function resolveNativeIngestBinary(): string | null {
  if (process.env.RUST_ANYTHING_MODE === "old" || process.env.RUST_ANYTHING_UNIT_INGEST === "original") {
    return null;
  }
  if (cachedNativeBinary !== undefined) {
    if (!cachedNativeBinary && process.env.RUST_ANYTHING_MODE === "new") {
      throw new Error("rust/ingest-rs binary (healthvault-ingest) is unavailable");
    }
    return cachedNativeBinary;
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "rust", "ingest-rs", "healthvault-ingest"),
    join(process.cwd(), "rust", "ingest-rs", "target", "release", "healthvault-ingest"),
    join(dir, "..", "..", "rust", "ingest-rs", "healthvault-ingest"),
    join(dir, "..", "..", "rust", "ingest-rs", "target", "release", "healthvault-ingest"),
  ];
  for (const candidate of candidates) {
    if (existsSync(/* turbopackIgnore: true */ candidate)) {
      cachedNativeBinary = candidate;
      return candidate;
    }
  }
  cachedNativeBinary = null;
  if (process.env.RUST_ANYTHING_MODE === "new") {
    throw new Error("rust/ingest-rs binary (healthvault-ingest) was not found");
  }
  return null;
}

/**
 * Run the Rust ingest worker in a dedicated child process.
 *
 * Isolating SQLite writes in a separate OS process avoids Linux POSIX fcntl() lock-release
 * hazards between two independent libsqlite3 copies (better-sqlite3 vs rusqlite) in one PID,
 * keeps the JS event loop completely unblocked, and streams zip -> XML/GPX/ECG -> SQLite WAL
 * with zero per-row JS allocation.
 */
function runRustIngestWorker(
  binaryPath: string,
  zipBytes: Uint8Array,
  dbPath: string,
  uploadId: number,
  chunkSize: number,
  maxXmlBytes: number,
  progressInterval: number,
): Promise<NativeIngestResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binaryPath,
      [
        dbPath,
        String(uploadId),
        String(chunkSize),
        String(maxXmlBytes),
        String(progressInterval),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, res?: NativeIngestResult) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(res!);
    };

    child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.stdin.on("error", () => {
      // Ignore EPIPE when the worker rejects early (e.g. invalid zip) before reading all of stdin.
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString("utf8").trim() || `healthvault-ingest exited with code ${code}`;
        finish(new Error(msg));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(outChunks).toString("utf8").trim()) as NativeIngestResult;
        finish(null, parsed);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    child.stdin.end(Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength));
  });
}

export type IngestResult = {
  uploadId: number;
  inserted: number;
  duplicates: number;
  routesInserted?: number;
  ecgsInserted?: number;
};

const CHUNK = Number(process.env.INGEST_CHUNK ?? 1000);
const ZIP_SLICE = Number(process.env.INGEST_SLICE ?? 1 << 20);
// A real 4-year export inflates to ~410 MB. 1.5 GiB leaves headroom without letting a
// crafted zip decompress without bound (the zip itself is capped at 200 MB by the route).
const MAX_XML_BYTES = Number(process.env.INGEST_MAX_XML ?? 1536 * 1024 * 1024);
const MAX_SIDE_FILE_BYTES = 16 * 1024 * 1024;
const PROGRESS_INTERVAL = 25_000;

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
const insertRoute = sqlite.prepare(
  `INSERT INTO workout_routes (workout_id, filename, day, start_ms, end_ms, point_count,
                               distance_km, elevation_gain_m, elevation_loss_m,
                               polyline_json, splits_json, created_at_ms)
   VALUES (@workoutId, @filename, @day, @startMs, @endMs, @pointCount,
           @distanceKm, @elevationGainM, @elevationLossM,
           @polylineJson, @splitsJson, @createdAtMs)
   ON CONFLICT DO NOTHING`,
);
const insertEcg = sqlite.prepare(
  `INSERT INTO ecg_recordings (filename, recorded_at, recorded_at_ms, day, classification,
                               avg_hr, sampling_hz, unit, sample_count, samples_json,
                               symptoms, device, created_at_ms)
   VALUES (@filename, @recordedAt, @recordedAtMs, @day, @classification,
           @avgHr, @samplingHz, @unit, @sampleCount, @samplesJson,
           @symptoms, @device, @createdAtMs)
   ON CONFLICT DO NOTHING`,
);
const updateProgressStmt = sqlite.prepare(
  `UPDATE uploads SET rows_processed = ? WHERE id = ?`,
);
const matchWorkoutStmt = sqlite.prepare(
  `WITH ${WORKOUT_DEDUP}
   SELECT id, start_ms AS startMs, end_ms AS endMs
   FROM deduped
   WHERE start_ms <= ? AND end_ms >= ?
   ORDER BY ABS(start_ms - ?) ASC
   LIMIT 1`,
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

const writeSideFiles = sqlite.transaction((routes: ParsedGpxRoute[], ecgs: ParsedEcg[]) => {
  const now = Date.now();
  let routesInserted = 0;
  for (const route of routes) {
    // Allow ±10 min slack between GPX first/last trackpoint and workout timestamps.
    const slack = 10 * 60 * 1000;
    const match = matchWorkoutStmt.get(
      route.endMs + slack,
      route.startMs - slack,
      route.startMs,
    ) as { id: number } | undefined;
    routesInserted += insertRoute.run({
      workoutId: match?.id ?? null,
      filename: route.filename,
      day: route.day,
      startMs: route.startMs,
      endMs: route.endMs,
      pointCount: route.pointCount,
      distanceKm: route.distanceKm,
      elevationGainM: route.elevationGainM,
      elevationLossM: route.elevationLossM,
      polylineJson: JSON.stringify(route.polyline),
      splitsJson: JSON.stringify(route.splits),
      createdAtMs: now,
    }).changes;
  }

  let ecgsInserted = 0;
  for (const ecg of ecgs) {
    ecgsInserted += insertEcg.run({
      filename: ecg.filename,
      recordedAt: ecg.recordedAt,
      recordedAtMs: ecg.recordedAtMs,
      day: ecg.day,
      classification: ecg.classification,
      avgHr: ecg.avgHr,
      samplingHz: ecg.samplingHz,
      unit: ecg.unit,
      sampleCount: ecg.sampleCount,
      samplesJson: JSON.stringify(ecg.samples),
      symptoms: ecg.symptoms,
      device: ecg.device,
      createdAtMs: now,
    }).changes;
  }

  return { routesInserted, ecgsInserted };
});

type SideCollectors = {
  routes: ParsedGpxRoute[];
  ecgs: ParsedEcg[];
};

async function* exportXmlChunks(
  zip: Uint8Array,
  side: SideCollectors,
): AsyncGenerator<Uint8Array> {
  const ready: Uint8Array[] = [];
  const seen: string[] = [];
  let sawEntry = false;
  let failure: Error | null = null;
  let inflated = 0;

  const unzipper = new Unzip((file) => {
    seen.push(file.name);
    const lower = file.name.toLowerCase();
    const base = lower.split("/").pop() ?? "";

    if (base === "export.xml") {
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
      return;
    }

    const isGpx = lower.endsWith(".gpx") && lower.includes("workout-routes/");
    const isEcg = lower.endsWith(".csv") && lower.includes("electrocardiograms/");
    if (!isGpx && !isEcg) return;

    const chunks: Uint8Array[] = [];
    let sideSize = 0;
    let overflowed = false;
    file.ondata = (err, chunk, final) => {
      if (err) return;
      if (chunk.length && !overflowed) {
        sideSize += chunk.length;
        if (sideSize > MAX_SIDE_FILE_BYTES) {
          overflowed = true;
          chunks.length = 0;
        } else {
          chunks.push(chunk);
        }
      }
      if (final && !overflowed && chunks.length > 0) {
        const text = Buffer.concat(chunks).toString("utf8");
        if (isGpx) {
          const parsed = parseGpxRoute(text, file.name);
          if (parsed) side.routes.push(parsed);
        } else if (isEcg) {
          const parsed = parseEcgCsv(text, file.name);
          if (parsed) side.ecgs.push(parsed);
        }
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
    await new Promise<void>((r) => setImmediate(r));
  }
  if (failure) throw failure;
  if (!sawEntry) throw new Error(`export.xml not found in zip (entries: ${seen.slice(0, 10).join(", ") || "none"})`);
}

export async function runIngest(zipBytes: Uint8Array, filename: string, bytes: number): Promise<IngestResult> {
  const [handle] = await db
    .insert(uploads)
    .values({ filename, bytes, status: "running", rowsProcessed: 0, createdAtMs: Date.now() })
    .returning({ id: uploads.id });

  try {
    let inserted = 0;
    let seen = 0;
    let routesInserted = 0;
    let ecgsInserted = 0;
    let me: MeCharacteristics = {};

    const nativeBin = resolveNativeIngestBinary();
    const dbPath = sqlite.name;
    if (nativeBin && dbPath && dbPath !== ":memory:") {
      const nativeRes = await runRustIngestWorker(
        nativeBin,
        zipBytes,
        dbPath,
        handle.id,
        CHUNK,
        MAX_XML_BYTES,
        PROGRESS_INTERVAL,
      );
      seen = nativeRes.seen;
      inserted = nativeRes.inserted;
      routesInserted = nativeRes.routesInserted;
      ecgsInserted = nativeRes.ecgsInserted;
      me = nativeRes.me ?? {};
    } else {
      const parser = createHealthParser();
      const decoder = new TextDecoder();
      const side: SideCollectors = { routes: [], ecgs: [] };
      let lastReported = 0;

      const flush = () => {
        const parsed = parser.drain();
        seen += parsed.records.length + parsed.workouts.length + parsed.summaries.length;
        inserted += writeBatch(parsed.records, parsed.workouts, parsed.summaries);
        if (seen - lastReported >= PROGRESS_INTERVAL) {
          lastReported = seen;
          updateProgressStmt.run(seen, handle.id);
        }
      };

      let sawXml = false;
      const SUB_CHUNK_CHARS = 128 * 1024;
      for await (const chunk of exportXmlChunks(zipBytes, side)) {
        sawXml = true;
        const decoded = decoder.decode(chunk, { stream: true });
        for (let off = 0; off < decoded.length; off += SUB_CHUNK_CHARS) {
          parser.write(decoded.slice(off, off + SUB_CHUNK_CHARS));
          if (parser.pending() >= CHUNK) flush();
        }
      }
      if (!sawXml) throw new Error("export.xml not found in zip");
      parser.write(decoder.decode());
      parser.end();
      flush();

      ({ routesInserted, ecgsInserted } = writeSideFiles(side.routes, side.ecgs));
      me = parser.characteristics();
    }
    invalidateRecordCaches();

    // <Me> carries birth date and biological sex; height arrives as a quantity record.
    // A prefill failure must not mark a fully imported file as failed.
    let warning: string | null = null;
    try {
      const height = sqlite
        .prepare(
          `SELECT value, unit FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierHeight'
           AND value > 0 ORDER BY start_ms DESC LIMIT 1`,
        )
        .get() as { value: number; unit: string } | undefined;
      const heightUnit = height?.unit.trim().toLowerCase();
      const heightCm = height
        ? heightUnit === "in"
          ? height.value * 2.54
          : heightUnit === "ft"
            ? height.value * 30.48
            : heightUnit === "m"
              ? height.value * 100
              : height.value
        : undefined;
      if (me.dateOfBirth || me.biologicalSex || heightCm) {
        prefillProfile({ birthDate: me.dateOfBirth, sex: me.biologicalSex, heightCm });
      }
    } catch (e) {
      warning = `profile prefill skipped: ${e instanceof Error ? e.message : String(e)}`;
    }

    const duplicates = seen - inserted;
    await db
      .update(uploads)
      .set({
        status: "done",
        rowsProcessed: seen,
        recordsInserted: inserted,
        recordsDuplicates: duplicates,
        finishedAtMs: Date.now(),
        ...(warning ? { message: warning } : {}),
      })
      .where(eq(uploads.id, handle.id));
    return { uploadId: handle.id, inserted, duplicates, routesInserted, ecgsInserted };
  } catch (e) {
    await db
      .update(uploads)
      .set({ status: "failed", message: e instanceof Error ? e.message : String(e), finishedAtMs: Date.now() })
      .where(eq(uploads.id, handle.id));
    throw e;
  }
}
