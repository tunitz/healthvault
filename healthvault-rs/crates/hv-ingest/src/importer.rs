//! Import job: one upload row, streamed `export.xml`, bounded batches, dedupe by unique keys.

use std::io::Read;
use std::path::Path;

use rusqlite::{OptionalExtension, params};

use crate::error::IngestError;
use crate::model::{HealthRecordRow, IngestReport, ParsedHealth, SummaryRow, WorkoutImportRow};
use crate::parser::HealthParser;
use hv_storage::StoreHandle;

pub const MAX_ZIP_BYTES: u64 = 200 * 1024 * 1024;
pub const MAX_XML_BYTES: u64 = 1536 * 1024 * 1024;
pub const CHUNK_ROWS: usize = 1000;
const READ_SLICE: usize = 64 * 1024;

/// Serialize imports in-process. The storage actor already serializes writes, but two concurrent
/// parses would still contend for CPU/RAM; the HTTP layer uses this same coordinator to reject a
/// second import with an explicit 409 instead of silently queueing unbounded work.
#[derive(Debug, Default)]
pub struct ImportCoordinator(std::sync::atomic::AtomicBool);

impl ImportCoordinator {
    pub fn try_start(&self) -> bool {
        self.0
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    }

    pub fn finish(&self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }

    pub fn is_running(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
}

/// Read and validate a zip file from disk, then import it.
pub fn import_file(
    store: &StoreHandle,
    path: &Path,
    filename: &str,
) -> Result<IngestReport, IngestError> {
    let metadata = std::fs::metadata(path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => IngestError::SourceMissing {
            path: path.to_path_buf(),
        },
        std::io::ErrorKind::PermissionDenied => IngestError::AccessDenied {
            path: path.to_path_buf(),
        },
        _ => IngestError::Io(err),
    })?;
    let bytes = metadata.len();
    if bytes > MAX_ZIP_BYTES {
        return Err(IngestError::TooLarge {
            size: bytes,
            limit: MAX_ZIP_BYTES,
        });
    }
    let zip = std::fs::read(path)?;
    import_zip_bytes(store, &zip, filename, bytes)
}

pub fn import_zip_bytes(
    store: &StoreHandle,
    zip: &[u8],
    filename: &str,
    bytes: u64,
) -> Result<IngestReport, IngestError> {
    if zip.len() as u64 > MAX_ZIP_BYTES {
        return Err(IngestError::TooLarge {
            size: zip.len() as u64,
            limit: MAX_ZIP_BYTES,
        });
    }
    let now = chrono::Utc::now().timestamp_millis();
    let filename = filename.to_owned();
    let upload_id: i64 = store.call(move |conn| {
        Ok(conn.query_row(
            "INSERT INTO uploads (filename, bytes, status, created_at_ms) VALUES (?1, ?2, 'running', ?3) RETURNING id",
            params![filename, bytes as i64, now],
            |row| row.get::<_, i64>(0),
        )?)
    })?;
    let result = parse_and_write(store, zip);
    match result {
        Ok((inserted, seen, me)) => {
            let warning = prefill(store, &me);
            let finished = chrono::Utc::now().timestamp_millis();
            store.call(move |conn| {
                conn.execute(
                    "UPDATE uploads SET status = 'done', records_inserted = ?1, records_duplicates = ?2,
                        message = ?3, finished_at_ms = ?4 WHERE id = ?5",
                    params![inserted, seen - inserted, warning, finished, upload_id],
                )?;
                Ok(())
            })?;
            Ok(IngestReport {
                upload_id,
                inserted,
                duplicates: seen - inserted,
            })
        }
        Err(err) => {
            let message = err.to_string();
            let finished = chrono::Utc::now().timestamp_millis();
            let _ = store.call(move |conn| {
                conn.execute(
                    "UPDATE uploads SET status = 'failed', message = ?1, finished_at_ms = ?2 WHERE id = ?3",
                    params![message, finished, upload_id],
                )?;
                Ok(())
            });
            Err(err)
        }
    }
}

fn parse_and_write(
    store: &StoreHandle,
    zip: &[u8],
) -> Result<(i64, i64, crate::model::MeCharacteristics), IngestError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip))
        .map_err(|err| IngestError::Malformed(format!("invalid export zip: {err}")))?;
    let names: Vec<String> = archive
        .file_names()
        .map(std::borrow::ToOwned::to_owned)
        .collect();
    let entry = names
        .iter()
        .find(|name| {
            name.rsplit('/')
                .next()
                .is_some_and(|leaf| leaf.eq_ignore_ascii_case("export.xml"))
        })
        .cloned()
        .ok_or_else(|| {
            IngestError::MissingExport(
                names
                    .iter()
                    .take(10)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        })?;
    let mut reader = archive.by_name(&entry)?;

    let mut parser = HealthParser::new();
    let mut buffer = [0u8; READ_SLICE];
    let mut inflated = 0u64;
    let mut inserted = 0i64;
    let mut seen = 0i64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        inflated += read as u64;
        if inflated > MAX_XML_BYTES {
            return Err(IngestError::TooLarge {
                size: inflated,
                limit: MAX_XML_BYTES,
            });
        }
        parser.write(&buffer[..read])?;
        if parser.pending() >= CHUNK_ROWS {
            let batch = parser.drain();
            seen += batch.len() as i64;
            inserted += write_batch(store, batch)?;
        }
    }
    parser.finish()?;
    let tail = parser.drain();
    seen += tail.len() as i64;
    inserted += write_batch(store, tail)?;
    let me = parser.characteristics();
    Ok((inserted, seen, me))
}

fn write_batch(store: &StoreHandle, batch: ParsedHealth) -> Result<i64, IngestError> {
    if batch.is_empty() {
        return Ok(0);
    }
    Ok(store.call(move |conn| {
        let tx = conn.transaction()?;
        let mut count = 0i64;
        {
            let mut record = tx.prepare_cached(
                "INSERT INTO records (type_identifier, unit, value, start_date, start_ms, day, end_date, end_ms, source_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT DO NOTHING",
            )?;
            for row in &batch.records {
                count += record.execute(record_params(row))? as i64;
            }
        }
        {
            let mut workout = tx.prepare_cached(
                "INSERT INTO workouts (workout_activity_type, start_date, start_ms, day, end_date, end_ms,
                    duration_seconds, total_distance, total_distance_unit, total_energy_burned,
                    total_energy_burned_unit, avg_hr, min_hr, max_hr, source_name, metadata_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT DO NOTHING",
            )?;
            for row in &batch.workouts {
                count += workout.execute(workout_params(row))? as i64;
            }
        }
        {
            let mut summary = tx.prepare_cached(
                "INSERT INTO activity_summaries (date_components, day, active_energy_burned, active_energy_burned_goal,
                    apple_move_minutes, apple_move_minutes_goal, apple_exercise_time, apple_exercise_time_goal,
                    apple_stand_hours, apple_stand_hours_goal)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT DO NOTHING",
            )?;
            for row in &batch.summaries {
                count += summary.execute(summary_params(row))? as i64;
            }
        }
        tx.commit()?;
        Ok(count)
    })?)
}

fn record_params(row: &HealthRecordRow) -> [rusqlite::types::Value; 9] {
    use rusqlite::types::Value;
    [
        Value::Text(row.type_identifier.clone()),
        Value::Text(row.unit.clone()),
        Value::Real(row.value),
        Value::Text(row.start_date.clone()),
        Value::Integer(row.start_ms),
        Value::Text(row.day.clone()),
        Value::Text(row.end_date.clone()),
        Value::Integer(row.end_ms),
        Value::Text(row.source_name.clone()),
    ]
}

fn workout_params(row: &WorkoutImportRow) -> [rusqlite::types::Value; 16] {
    use rusqlite::types::Value;
    let opt_num = |v: Option<f64>| v.map_or(Value::Null, Value::Real);
    let opt_text = |v: &Option<String>| v.clone().map_or(Value::Null, Value::Text);
    [
        Value::Text(row.workout_activity_type.clone()),
        Value::Text(row.start_date.clone()),
        Value::Integer(row.start_ms),
        Value::Text(row.day.clone()),
        Value::Text(row.end_date.clone()),
        Value::Integer(row.end_ms),
        opt_num(row.duration_seconds),
        opt_num(row.total_distance),
        opt_text(&row.total_distance_unit),
        opt_num(row.total_energy_burned),
        opt_text(&row.total_energy_burned_unit),
        opt_num(row.avg_hr),
        opt_num(row.min_hr),
        opt_num(row.max_hr),
        opt_text(&row.source_name),
        opt_text(&row.metadata_json),
    ]
}

fn summary_params(row: &SummaryRow) -> [rusqlite::types::Value; 10] {
    use rusqlite::types::Value;
    let n = |v: Option<f64>| v.map_or(Value::Null, Value::Real);
    [
        Value::Text(row.date_components.clone()),
        Value::Text(row.day.clone()),
        n(row.active_energy_burned),
        n(row.active_energy_burned_goal),
        n(row.apple_move_minutes),
        n(row.apple_move_minutes_goal),
        n(row.apple_exercise_time),
        n(row.apple_exercise_time_goal),
        n(row.apple_stand_hours),
        n(row.apple_stand_hours_goal),
    ]
}

/// `<Me>` and Height fill only fields the user has not already set. A prefill failure is a
/// warning on the upload row, never a failed import.
fn prefill(store: &StoreHandle, me: &crate::model::MeCharacteristics) -> Option<String> {
    let dob = me.date_of_birth.clone();
    let sex = me.biological_sex.clone();
    let result = store.call(move |conn| {
        let height: Option<(f64, String)> = conn
            .query_row(
                "SELECT value, unit FROM records WHERE type_identifier = 'HKQuantityTypeIdentifierHeight'
                 AND value > 0 ORDER BY start_ms DESC LIMIT 1",
                [],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let height_cm = height.map(|(value, unit)| match unit.to_ascii_lowercase().as_str() {
            "in" => value * 2.54,
            "ft" => value * 30.48,
            _ => value,
        });
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT OR IGNORE INTO profile (id, timezone, units, created_at_ms, updated_at_ms) VALUES (1, 'Asia/Shanghai', 'metric', ?1, ?1)",
            params![now],
        )?;
        if let Some(dob) = dob {
            conn.execute("UPDATE profile SET birth_date = ?1 WHERE id = 1 AND birth_date IS NULL", params![dob])?;
        }
        if let Some(sex) = sex {
            conn.execute("UPDATE profile SET sex = ?1 WHERE id = 1 AND sex IS NULL", params![sex])?;
        }
        if let Some(height_cm) = height_cm {
            conn.execute("UPDATE profile SET height_cm = ?1 WHERE id = 1 AND height_cm IS NULL", params![height_cm])?;
        }
        Ok(())
    });
    result
        .err()
        .map(|err| format!("profile prefill skipped: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(xml: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file("apple_health_export/export.xml", options)
            .unwrap();
        writer.write_all(xml.as_bytes()).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn importing_a_zip_writes_rows_and_deduplicates_on_repeat() {
        let store = StoreHandle::in_memory().unwrap();
        let xml = r#"<HealthData><Record type="HKQuantityTypeIdentifierStepCount" value="42" unit="count" startDate="2026-11-17 08:00:00 +0800" endDate="2026-11-17 08:01:00 +0800" sourceName="Phone"/></HealthData>"#;
        let zip = zip_with(xml);
        let first = import_zip_bytes(&store, &zip, "Export.zip", zip.len() as u64).unwrap();
        assert_eq!(first.inserted, 1);
        assert_eq!(first.duplicates, 0);
        let second = import_zip_bytes(&store, &zip, "Export.zip", zip.len() as u64).unwrap();
        assert_eq!(second.inserted, 0);
        assert_eq!(second.duplicates, 1);
        let count: i64 = store
            .call(|conn| {
                Ok(conn
                    .query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0))
                    .unwrap())
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn missing_export_is_reported_with_archive_contents() {
        let store = StoreHandle::in_memory().unwrap();
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("other.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"hi").unwrap();
        let zip = writer.finish().unwrap().into_inner();
        let error = import_zip_bytes(&store, &zip, "wrong.zip", zip.len() as u64).unwrap_err();
        assert!(matches!(error, IngestError::MissingExport(_)));
    }

    #[test]
    fn concurrent_import_coordinator_admits_only_one_job() {
        let coordinator = ImportCoordinator::default();
        assert!(coordinator.try_start());
        assert!(!coordinator.try_start());
        coordinator.finish();
        assert!(coordinator.try_start());
    }
}
