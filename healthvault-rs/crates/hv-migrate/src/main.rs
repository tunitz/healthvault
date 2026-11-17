#![allow(clippy::print_stdout, reason = "CLI stdout is the report interface")]
//! Data migration and verification tool. Reads a copy of the existing SQLite database, checks
//! counts/aggregates and schema compatibility, and can produce a verified backup. It never writes
//! to the source unless `--apply` is given with an explicit path outside the live data directory.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use hv_storage::{StoreHandle, migrations};

#[derive(Debug, Parser)]
#[command(
    name = "hv-migrate",
    about = "HealthVault database migration and parity verification"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Verify that a database (or a copy) is at the current schema version.
    Verify {
        #[arg(long)]
        path: PathBuf,
    },
    /// Write a consistent WAL-safe backup of a database into a new file.
    Backup {
        #[arg(long)]
        from: PathBuf,
        #[arg(long)]
        to: PathBuf,
    },
    /// Compare counts and aggregates between two database copies (dual-run signoff).
    Compare {
        #[arg(long)]
        a: PathBuf,
        #[arg(long)]
        b: PathBuf,
    },
    /// Apply migrations to an explicitly named copy of the database.
    Apply {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        allow_write: bool,
    },
}

fn refuse_live_data(path: &Path) -> Result<()> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let components: Vec<String> = canonical
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if components
        .windows(2)
        .any(|pair| pair[0] == "data" && pair[1].ends_with(".db"))
    {
        bail!(
            "refusing to operate on a file inside a project data/ directory: {}",
            canonical.display()
        );
    }
    Ok(())
}

/// Read-only aggregate fingerprint used for dual-run parity checks. Nothing is migrated here.
fn fingerprint(path: &Path) -> Result<serde_json::Value> {
    use rusqlite::OpenFlags;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = rusqlite::Connection::open_with_flags(path, flags)?;
    let scalar = |sql: &str| -> Result<i64> {
        Ok(conn
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0))
    };
    let real = |sql: &str| -> Result<f64> {
        Ok(conn
            .query_row(sql, [], |row| row.get::<_, f64>(0))
            .unwrap_or(0.0))
    };
    Ok(serde_json::json!({
        "records": scalar("SELECT COUNT(*) FROM records")?,
        "workouts": scalar("SELECT COUNT(*) FROM workouts")?,
        "foods": scalar("SELECT COUNT(*) FROM foods")?,
        "foodLogEntries": scalar("SELECT COUNT(*) FROM food_log")?,
        "ingredientSnapshots": scalar("SELECT COUNT(*) FROM food_log_ingredients")?,
        "revisions": scalar("SELECT COUNT(*) FROM food_log_revisions")?,
        "recordValueSum": real("SELECT COALESCE(SUM(value),0) FROM records")?,
        "workoutDistanceSum": real("SELECT COALESCE(SUM(total_distance),0) FROM workouts")?,
        "lastRecordDay": conn.query_row("SELECT COALESCE(MAX(day),'') FROM records", [], |r| r.get::<_, String>(0))?,
        "integrity": conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))?,
    }))
}

fn verification(store: &StoreHandle) -> Result<serde_json::Value> {
    let report = store.call(|conn| {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let records: i64 = conn.query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))?;
        let workouts: i64 =
            conn.query_row("SELECT COUNT(*) FROM workouts", [], |row| row.get(0))?;
        let foods: i64 = conn.query_row("SELECT COUNT(*) FROM foods", [], |row| row.get(0))?;
        let entries: i64 = conn.query_row("SELECT COUNT(*) FROM food_log", [], |row| row.get(0))?;
        let last_record_day: Option<String> =
            conn.query_row("SELECT MAX(day) FROM records", [], |row| row.get(0))?;
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        Ok(serde_json::json!({
            "userVersion": version,
            "expectedVersion": migrations::MIGRATIONS.len(),
            "records": records,
            "workouts": workouts,
            "foods": foods,
            "foodLogEntries": entries,
            "lastRecordDay": last_record_day,
            "integrity": integrity,
        }))
    })?;
    Ok(report)
}

fn main() -> Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    let cli = Cli::parse();
    match cli.command {
        Command::Compare { a, b } => {
            refuse_live_data(&a)?;
            refuse_live_data(&b)?;
            let left = fingerprint(&a)?;
            let right = fingerprint(&b)?;
            let mut different = Vec::new();
            if let (Some(left), Some(right)) = (left.as_object(), right.as_object()) {
                for (key, value) in left {
                    if right.get(key) != Some(value) {
                        different.push(key.clone());
                    }
                }
            }
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({ "a": left, "b": right, "different": different })
                )?
            );
            if !different.is_empty() {
                bail!("dual-run parity check failed for: {}", different.join(", "));
            }
            Ok(())
        }
        Command::Verify { path } => {
            refuse_live_data(&path)?;
            let store = StoreHandle::open(&path)?;
            let report = verification(&store)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report["integrity"] != "ok" {
                bail!("integrity check failed");
            }
            Ok(())
        }
        Command::Backup { from, to } => {
            refuse_live_data(&from)?;
            if to.exists() {
                bail!("backup destination already exists: {}", to.display());
            }
            let store = StoreHandle::open(&from)?;
            store.backup_to(&to)?;
            let restored = StoreHandle::open(&to)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&verification(&restored)?)?
            );
            Ok(())
        }
        Command::Apply { path, allow_write } => {
            refuse_live_data(&path)?;
            if !allow_write {
                bail!(
                    "--apply requires --allow-write and an explicit copy path; use verify for read-only checks"
                );
            }
            let store = StoreHandle::open(&path)?;
            println!("{}", serde_json::to_string_pretty(&verification(&store)?)?);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_data_paths_are_refused() {
        assert!(
            refuse_live_data(Path::new(
                "/home/tunitz/projects/healthvault/data/health.db"
            ))
            .is_err()
        );
        assert!(refuse_live_data(Path::new("/tmp/copy-of-health.db")).is_ok());
    }

    #[test]
    fn verification_reports_schema_and_integrity() {
        let store = StoreHandle::in_memory().unwrap();
        let report = verification(&store).unwrap();
        assert_eq!(report["userVersion"], 7);
        assert_eq!(report["integrity"], "ok");
    }
}

#[cfg(test)]
mod compare_tests {
    use super::*;

    #[test]
    fn identical_copies_have_identical_fingerprints() {
        let store = StoreHandle::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.db");
        let b = dir.path().join("b.db");
        store.backup_to(&a).unwrap();
        store.backup_to(&b).unwrap();
        assert_eq!(fingerprint(&a).unwrap(), fingerprint(&b).unwrap());
    }
}
