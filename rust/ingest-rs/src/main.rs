//! Streaming Rust hot loop for Apple Health `Export.zip` ingestion.
//!
//! Runs as an isolated child process (100% SQLite WAL multi-process safe — avoids Linux POSIX
//! `fcntl()` close-lock hazards between two independent `libsqlite3` copies in one process):
//! - Reads zip bytes from stdin.
//! - Inflates `export.xml`, `workout-routes/*.gpx`, and `electrocardiograms/*.csv` with `zip` + `zlib-rs`.
//! - Streams `export.xml` through `xml_rs::port::stream_health_xml` with zero per-record heap
//!   allocation and zero per-row JS crossing.
//! - Batch-inserts rows directly into SQLite via `rusqlite` prepared statements in WAL mode,
//!   updating `uploads.rows_processed` every `progress_interval` rows.
//! - Writes one JSON result line to stdout.

#![forbid(unsafe_code)]

mod side;

use std::io::{BufReader, Cursor, Read};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Statement, params};
use serde::Serialize;
use xml_rs::port::{HealthRecordRef, HealthSink, SummaryOwned, WorkoutOwned, stream_health_xml};
use zip::ZipArchive;

use crate::side::{ParsedEcg, ParsedGpxRoute, parse_ecg_csv, parse_gpx_route};

const MAX_SIDE_FILE_BYTES: usize = 16 * 1024 * 1024;
const ROUTE_MATCH_SLACK_MS: i64 = 10 * 60 * 1000;

const SQL_INSERT_RECORD: &str = "\
INSERT INTO records (type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT DO NOTHING";

const SQL_INSERT_WORKOUT: &str = "\
INSERT INTO workouts (workout_activity_type, start_date, start_ms, day, end_date, end_ms,
                      duration_seconds, total_distance, total_distance_unit, total_energy_burned,
                      total_energy_burned_unit, avg_hr, min_hr, max_hr, source_name, metadata_json)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
ON CONFLICT DO NOTHING";

const SQL_INSERT_SUMMARY: &str = "\
INSERT INTO activity_summaries (date_components, day, active_energy_burned, active_energy_burned_goal,
                                apple_move_minutes, apple_move_minutes_goal, apple_exercise_time,
                                apple_exercise_time_goal, apple_stand_hours, apple_stand_hours_goal)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT DO NOTHING";

const SQL_INSERT_ROUTE: &str = "\
INSERT INTO workout_routes (workout_id, filename, day, start_ms, end_ms, point_count,
                            distance_km, elevation_gain_m, elevation_loss_m,
                            polyline_json, splits_json, created_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
ON CONFLICT DO NOTHING";

const SQL_INSERT_ECG: &str = "\
INSERT INTO ecg_recordings (filename, recorded_at, recorded_at_ms, day, classification,
                            avg_hr, sampling_hz, unit, sample_count, samples_json,
                            symptoms, device, created_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
ON CONFLICT DO NOTHING";

const SQL_UPDATE_PROGRESS: &str = "UPDATE uploads SET rows_processed = ?1 WHERE id = ?2";

// Exact match with WORKOUT_DEDUP + WORKOUT_DISTANCE_KM in src/db/queries.ts and matchWorkoutStmt in src/lib/ingest.ts.
const SQL_MATCH_WORKOUT: &str = "\
WITH deduped AS (
  SELECT * FROM (
    SELECT w.*,
           ROW_NUMBER() OVER (
             PARTITION BY w.workout_activity_type, w.start_date, w.end_date
             ORDER BY ((CASE
               WHEN total_distance IS NULL THEN NULL
               WHEN lower(trim(total_distance_unit)) = 'km' THEN total_distance
               WHEN lower(trim(total_distance_unit)) = 'mi' THEN total_distance * 1.609344
               WHEN lower(trim(total_distance_unit)) = 'm' THEN total_distance / 1000.0
               WHEN lower(trim(total_distance_unit)) = 'yd' THEN total_distance * 0.0009144
               WHEN lower(trim(total_distance_unit)) = 'ft' THEN total_distance * 0.0003048
               ELSE NULL
             END) IS NOT NULL) DESC,
             (w.duration_seconds IS NOT NULL) DESC,
             w.id ASC
           ) AS rn
    FROM workouts w
  )
  WHERE rn = 1
)
SELECT id
FROM deduped
WHERE start_ms <= ?1 AND end_ms >= ?2
ORDER BY ABS(start_ms - ?3) ASC
LIMIT 1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestMe {
    #[serde(skip_serializing_if = "Option::is_none")]
    date_of_birth: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    biological_sex: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestCoreResult {
    seen: u64,
    inserted: u64,
    routes_inserted: u64,
    ecgs_inserted: u64,
    me: IngestMe,
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct CappedReader<R> {
    inner: R,
    read_bytes: u64,
    max_bytes: u64,
}

impl<R: Read> Read for CappedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read_bytes = self.read_bytes.saturating_add(n as u64);
        if self.read_bytes > self.max_bytes {
            let mb = (self.max_bytes as f64 / 1024.0 / 1024.0).round() as u64;
            return Err(std::io::Error::other(format!(
                "export.xml exceeds the {mb} MB uncompressed cap; set INGEST_MAX_XML to raise it"
            )));
        }
        Ok(n)
    }
}

struct SqliteXmlSink<'conn> {
    conn: &'conn Connection,
    insert_record: Statement<'conn>,
    insert_workout: Statement<'conn>,
    insert_summary: Statement<'conn>,
    update_progress: Statement<'conn>,
    upload_id: i64,
    tx_batch: u64,
    progress_interval: u64,
    in_tx: bool,
    batch_rows: u64,
    seen: u64,
    inserted: u64,
    last_reported: u64,
}

impl<'conn> SqliteXmlSink<'conn> {
    fn new(
        conn: &'conn Connection,
        upload_id: i64,
        chunk_size: u64,
        progress_interval: u64,
    ) -> Result<Self, String> {
        let insert_record = conn
            .prepare(SQL_INSERT_RECORD)
            .map_err(|e| format!("prepare insert_record: {e}"))?;
        let insert_workout = conn
            .prepare(SQL_INSERT_WORKOUT)
            .map_err(|e| format!("prepare insert_workout: {e}"))?;
        let insert_summary = conn
            .prepare(SQL_INSERT_SUMMARY)
            .map_err(|e| format!("prepare insert_summary: {e}"))?;
        let update_progress = conn
            .prepare(SQL_UPDATE_PROGRESS)
            .map_err(|e| format!("prepare update_progress: {e}"))?;

        conn.execute_batch("BEGIN")
            .map_err(|e| format!("begin tx: {e}"))?;

        let progress_interval = progress_interval.max(1);
        Ok(Self {
            conn,
            insert_record,
            insert_workout,
            insert_summary,
            update_progress,
            upload_id,
            tx_batch: chunk_size.max(progress_interval),
            progress_interval,
            in_tx: true,
            batch_rows: 0,
            seen: 0,
            inserted: 0,
            last_reported: 0,
        })
    }

    #[inline]
    fn after_row(&mut self, changed: usize) -> Result<(), String> {
        self.seen += 1;
        self.inserted += changed as u64;
        self.batch_rows += 1;

        let report_due = self.seen - self.last_reported >= self.progress_interval;
        if report_due || self.batch_rows >= self.tx_batch {
            if report_due {
                self.last_reported = self.seen;
                self.update_progress
                    .execute(params![self.seen as i64, self.upload_id])
                    .map_err(|e| format!("update progress: {e}"))?;
            }
            self.conn
                .execute_batch("COMMIT; BEGIN")
                .map_err(|e| format!("rotate tx: {e}"))?;
            self.batch_rows = 0;
        }
        Ok(())
    }

    fn finish(mut self) -> Result<(u64, u64), String> {
        if self.in_tx {
            if self.seen != self.last_reported {
                self.update_progress
                    .execute(params![self.seen as i64, self.upload_id])
                    .map_err(|e| format!("final progress: {e}"))?;
            }
            self.conn
                .execute_batch("COMMIT")
                .map_err(|e| format!("commit tx: {e}"))?;
            self.in_tx = false;
        }
        Ok((self.seen, self.inserted))
    }
}

impl Drop for SqliteXmlSink<'_> {
    fn drop(&mut self) {
        if self.in_tx {
            let _ = self.conn.execute_batch("ROLLBACK");
            self.in_tx = false;
        }
    }
}

#[inline]
fn f64_to_ms_i64(ms: f64) -> i64 {
    if ms.is_finite() { ms as i64 } else { 0 }
}

impl HealthSink for SqliteXmlSink<'_> {
    fn on_record(&mut self, r: &HealthRecordRef<'_>) -> Result<(), String> {
        let changed = self
            .insert_record
            .execute(params![
                r.type_identifier,
                r.unit,
                r.value,
                r.start_date,
                f64_to_ms_i64(r.start_ms),
                r.day,
                r.end_date,
                f64_to_ms_i64(r.end_ms),
                r.source_name,
            ])
            .map_err(|e| format!("insert record: {e}"))?;
        self.after_row(changed)
    }

    fn on_workout(&mut self, w: WorkoutOwned) -> Result<(), String> {
        let changed = self
            .insert_workout
            .execute(params![
                w.workout_activity_type,
                w.start_date,
                f64_to_ms_i64(w.start_ms),
                w.day,
                w.end_date,
                f64_to_ms_i64(w.end_ms),
                w.duration_seconds,
                w.total_distance,
                w.total_distance_unit,
                w.total_energy_burned,
                w.total_energy_burned_unit,
                w.avg_hr,
                w.min_hr,
                w.max_hr,
                w.source_name,
                w.metadata_json,
            ])
            .map_err(|e| format!("insert workout: {e}"))?;
        self.after_row(changed)
    }

    fn on_summary(&mut self, s: SummaryOwned) -> Result<(), String> {
        let changed = self
            .insert_summary
            .execute(params![
                s.date_components,
                s.day,
                s.active_energy_burned,
                s.active_energy_burned_goal,
                s.apple_move_minutes,
                s.apple_move_minutes_goal,
                s.apple_exercise_time,
                s.apple_exercise_time_goal,
                s.apple_stand_hours,
                s.apple_stand_hours_goal,
            ])
            .map_err(|e| format!("insert summary: {e}"))?;
        self.after_row(changed)
    }
}

fn read_side_entry_text<R: Read>(mut entry: R) -> Option<String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 32 * 1024];
    loop {
        match entry.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if bytes.len() + n > MAX_SIDE_FILE_BYTES {
                    return None;
                }
                bytes.extend_from_slice(&chunk[..n]);
            }
            Err(_) => return None,
        }
    }
    if bytes.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn write_side_files(
    conn: &mut Connection,
    routes: &[ParsedGpxRoute],
    ecgs: &[ParsedEcg],
) -> Result<(u64, u64), String> {
    if routes.is_empty() && ecgs.is_empty() {
        return Ok((0, 0));
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin side files tx: {e}"))?;
    let now = now_epoch_ms();
    let mut routes_inserted: u64 = 0;
    let mut ecgs_inserted: u64 = 0;

    {
        let mut match_workout = tx
            .prepare(SQL_MATCH_WORKOUT)
            .map_err(|e| format!("prepare match_workout: {e}"))?;
        let mut insert_route = tx
            .prepare(SQL_INSERT_ROUTE)
            .map_err(|e| format!("prepare insert_route: {e}"))?;
        let mut insert_ecg = tx
            .prepare(SQL_INSERT_ECG)
            .map_err(|e| format!("prepare insert_ecg: {e}"))?;

        for route in routes {
            let workout_id: Option<i64> = match_workout
                .query_row(
                    params![
                        route.end_ms + ROUTE_MATCH_SLACK_MS,
                        route.start_ms - ROUTE_MATCH_SLACK_MS,
                        route.start_ms,
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("match workout: {e}"))?;

            routes_inserted += insert_route
                .execute(params![
                    workout_id,
                    route.filename,
                    route.day,
                    route.start_ms,
                    route.end_ms,
                    route.point_count,
                    route.distance_km,
                    route.elevation_gain_m,
                    route.elevation_loss_m,
                    route.polyline_json,
                    route.splits_json,
                    now,
                ])
                .map_err(|e| format!("insert route: {e}"))? as u64;
        }

        for ecg in ecgs {
            ecgs_inserted += insert_ecg
                .execute(params![
                    ecg.filename,
                    ecg.recorded_at,
                    ecg.recorded_at_ms,
                    ecg.day,
                    ecg.classification,
                    ecg.avg_hr,
                    ecg.sampling_hz,
                    ecg.unit,
                    ecg.sample_count,
                    ecg.samples_json,
                    ecg.symptoms,
                    ecg.device,
                    now,
                ])
                .map_err(|e| format!("insert ecg: {e}"))? as u64;
        }
    }

    tx.commit()
        .map_err(|e| format!("commit side files tx: {e}"))?;
    Ok((routes_inserted, ecgs_inserted))
}

fn run_ingest_core(
    zip_bytes: &[u8],
    db_path: &str,
    upload_id: i64,
    chunk_size: u64,
    max_xml_bytes: u64,
    progress_interval: u64,
) -> Result<IngestCoreResult, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("invalid zip archive: {e}"))?;

    let mut seen_entries: Vec<String> = Vec::with_capacity(10);
    let mut xml_index: Option<usize> = None;
    let mut gpx_indices: Vec<(usize, String)> = Vec::new();
    let mut ecg_indices: Vec<(usize, String)> = Vec::new();

    for i in 0..archive.len() {
        let entry = archive
            .by_index_raw(i)
            .map_err(|e| format!("zip entry metadata error: {e}"))?;
        let name = entry
            .name()
            .map_err(|e| format!("zip entry name error: {e}"))?
            .into_owned();
        if seen_entries.len() < 10 {
            seen_entries.push(name.clone());
        }
        let lower = name.to_ascii_lowercase();
        let base = lower.rsplit('/').next().unwrap_or("");
        if base == "export.xml" && xml_index.is_none() {
            xml_index = Some(i);
        } else if lower.ends_with(".gpx") && lower.contains("workout-routes/") {
            gpx_indices.push((i, name));
        } else if lower.ends_with(".csv") && lower.contains("electrocardiograms/") {
            ecg_indices.push((i, name));
        }
    }

    let Some(xml_idx) = xml_index else {
        let list = if seen_entries.is_empty() {
            "none".to_string()
        } else {
            seen_entries.join(", ")
        };
        return Err(format!("export.xml not found in zip (entries: {list})"));
    };

    let mut conn = Connection::open(db_path).map_err(|e| format!("open sqlite {db_path}: {e}"))?;
    conn.busy_timeout(Duration::from_millis(30_000))
        .map_err(|e| format!("set busy_timeout: {e}"))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -64000;
         PRAGMA mmap_size = 268435456;
         PRAGMA synchronous = NORMAL;",
    )
    .map_err(|e| format!("configure sqlite pragmas: {e}"))?;

    let (seen, inserted, me) = {
        let xml_entry = archive
            .by_index(xml_idx)
            .map_err(|e| format!("open export.xml in zip: {e}"))?;
        let capped = CappedReader {
            inner: xml_entry,
            read_bytes: 0,
            max_bytes: max_xml_bytes,
        };
        let reader = BufReader::with_capacity(256 * 1024, capped);
        let mut sink = SqliteXmlSink::new(&conn, upload_id, chunk_size, progress_interval)?;
        let me = stream_health_xml(reader, &mut sink)?;
        let (seen, inserted) = sink.finish()?;
        (seen, inserted, me)
    };

    let mut routes: Vec<ParsedGpxRoute> = Vec::with_capacity(gpx_indices.len());
    for (idx, name) in gpx_indices {
        if let Ok(entry) = archive.by_index(idx)
            && let Some(text) = read_side_entry_text(entry)
            && let Some(parsed) = parse_gpx_route(&text, &name)
        {
            routes.push(parsed);
        }
    }

    let now = now_epoch_ms();
    let mut ecgs: Vec<ParsedEcg> = Vec::with_capacity(ecg_indices.len());
    for (idx, name) in ecg_indices {
        if let Ok(entry) = archive.by_index(idx)
            && let Some(text) = read_side_entry_text(entry)
            && let Some(parsed) = parse_ecg_csv(&text, &name, now)
        {
            ecgs.push(parsed);
        }
    }

    let (routes_inserted, ecgs_inserted) = write_side_files(&mut conn, &routes, &ecgs)?;

    Ok(IngestCoreResult {
        seen,
        inserted,
        routes_inserted,
        ecgs_inserted,
        me: IngestMe {
            date_of_birth: me.date_of_birth,
            biological_sex: me.biological_sex,
        },
    })
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        return Err(
            "usage: healthvault-ingest <db_path> <upload_id> <chunk_size> <max_xml_bytes> <progress_interval>"
                .into(),
        );
    }
    let db_path = &args[1];
    let upload_id: i64 = args[2]
        .parse()
        .map_err(|_| format!("invalid upload_id: {}", args[2]))?;
    let chunk_size: u64 = args[3]
        .parse()
        .map_err(|_| format!("invalid chunk_size: {}", args[3]))?;
    let max_xml_bytes: u64 = args[4]
        .parse()
        .map_err(|_| format!("invalid max_xml_bytes: {}", args[4]))?;
    let progress_interval: u64 = args[5]
        .parse()
        .map_err(|_| format!("invalid progress_interval: {}", args[5]))?;

    let mut zip_bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut zip_bytes)
        .map_err(|e| format!("read zip from stdin: {e}"))?;

    let result = run_ingest_core(
        &zip_bytes,
        db_path,
        upload_id,
        chunk_size,
        max_xml_bytes,
        progress_interval,
    )?;
    let json = serde_json::to_string(&result).map_err(|e| format!("serialize result: {e}"))?;
    println!("{json}");
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("{msg}");
            ExitCode::FAILURE
        }
    }
}
