//! Single-writer storage actor. `rusqlite::Connection` is `Send` but not `Sync`: one OS thread
//! owns it and callers send typed closures over a channel, so SQLite lock contention becomes
//! orderly queueing instead of `SQLITE_BUSY` races between request handlers.

#[cfg(not(target_family = "wasm"))]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Params, Row};

use crate::connection::open_connection;
use crate::error::StorageError;
use crate::migrations::migrate;

type Reply = Result<Vec<u8>, Vec<u8>>;
type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

/// Cheap cloneable handle to the single database-owning thread.
#[derive(Clone)]
pub struct StoreHandle {
    sender: Sender<Job>,
}

impl std::fmt::Debug for StoreHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoreHandle")
    }
}

impl StoreHandle {
    /// Open the database, migrate it under the cross-process lock, then hand it to one thread.
    pub fn open(database: &Path) -> Result<Self, StorageError> {
        crate::connection::enforce_private_permissions(database);
        let conn = crate::connection::with_migration_lock(database, "opening", || {
            let mut conn = open_connection(database)?;
            migrate(&mut conn)?;
            let now = chrono::Utc::now().timestamp_millis();
            // Only stale rows are failed: a short-lived diagnostic tool must not kill the live
            // service's current import.
            conn.execute(
                "UPDATE uploads SET status = 'failed',
                    message = COALESCE(message, 'interrupted by a service restart'),
                    finished_at_ms = COALESCE(finished_at_ms, ?1)
                  WHERE status = 'running' AND created_at_ms < ?2",
                rusqlite::params![now, now - 600_000],
            )?;
            Ok(conn)
        })?;
        Self::from_connection(conn, "hv-sqlite-writer")
    }

    pub fn in_memory() -> Result<Self, StorageError> {
        let mut conn = crate::connection::open_memory()?;
        migrate(&mut conn)?;
        Self::from_connection(conn, "hv-sqlite-test")
    }

    fn from_connection(conn: Connection, name: &str) -> Result<Self, StorageError> {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || worker(conn, receiver))
            .map_err(|err| StorageError::Busy(format!("starting storage worker: {err}")))?;
        Ok(Self { sender })
    }

    /// Run a typed job on the storage thread. `StorageError` crosses the channel as a small wire
    /// envelope so callers get the same error variant back.
    pub fn call<T>(
        &self,
        job: impl FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
    ) -> Result<T, StorageError>
    where
        T: serde::Serialize + serde::de::DeserializeOwned + Send + 'static,
    {
        let (reply_tx, reply_rx) = mpsc::channel::<Reply>();
        let boxed: Job = Box::new(move |conn| {
            let failure = |err: serde_json::Error| {
                serde_json::to_vec(&format!("serialization failure: {err}")).unwrap_or_default()
            };
            let outcome: Reply = match job(conn) {
                Ok(value) => serde_json::to_vec(&value).map_err(failure),
                Err(err) => match serde_json::to_vec(&err) {
                    Ok(bytes) => Err(bytes),
                    Err(serialization) => Err(failure(serialization)),
                },
            };
            // Dropping the receiver only means the caller stopped waiting.
            let _ = reply_tx.send(outcome);
        });
        self.sender
            .send(boxed)
            .map_err(|_| StorageError::Busy("storage worker has stopped".into()))?;
        let envelope = reply_rx
            .recv()
            .map_err(|_| StorageError::Busy("storage worker stopped before replying".into()))?;
        let bytes = match envelope {
            Ok(value) => value,
            Err(raw) => {
                return Err(serde_json::from_slice::<StorageError>(&raw)
                    .unwrap_or(StorageError::Migration("serialization failed".into())));
            }
        };
        serde_json::from_slice(&bytes).map_err(|err| StorageError::Migration(err.to_string()))
    }

    pub fn execute(
        &self,
        sql: impl Into<String>,
        params: impl Params + Send + 'static,
    ) -> Result<usize, StorageError> {
        let sql = sql.into();
        self.call(move |conn| Ok(conn.execute(&sql, params)?))
    }

    pub fn backup_to(&self, destination: &Path) -> Result<(), StorageError> {
        let dest = destination.to_path_buf();
        self.call(move |conn| {
            let sql = format!("VACUUM INTO {}", sql_literal(&dest));
            conn.execute_batch(&sql)?;
            #[cfg(not(target_family = "wasm"))]
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600));
            Ok(())
        })
    }

    pub fn integrity_check(&self) -> Result<String, StorageError> {
        self.call(|conn| {
            Ok(conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))?)
        })
    }
}

fn worker(mut conn: Connection, receiver: Receiver<Job>) {
    while let Ok(job) = receiver.recv() {
        job(&mut conn);
    }
    let _ = conn.execute_batch("PRAGMA optimize");
}

/// Escape a path for the one place SQL identifiers cannot be bound: `VACUUM INTO`.
fn sql_literal(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// Map a SQLite row into a value using named columns and runtime type introspection.
pub fn row_to_value(row: &Row<'_>, columns: &[&str]) -> Result<serde_json::Value, StorageError> {
    let mut map = serde_json::Map::new();
    for column in columns {
        let value = match row.get_ref(*column)? {
            ValueRef::Null => serde_json::Value::Null,
            ValueRef::Integer(v) => serde_json::json!(v),
            ValueRef::Real(v) => serde_json::json!(v),
            ValueRef::Text(v) => serde_json::Value::String(String::from_utf8_lossy(v).into_owned()),
            ValueRef::Blob(_) => serde_json::Value::Null,
        };
        map.insert((*column).to_owned(), value);
    }
    Ok(serde_json::Value::Object(map))
}

pub fn query_rows(
    conn: &Connection,
    sql: &str,
    params: impl Params,
    columns: &[&str],
) -> Result<Vec<serde_json::Value>, StorageError> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query(params)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(row_to_value(row, columns)?);
    }
    Ok(out)
}

pub fn query_one(
    conn: &Connection,
    sql: &str,
    params: impl Params,
    columns: &[&str],
) -> Result<Option<serde_json::Value>, StorageError> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query(params)?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_value(row, columns)?)),
        None => Ok(None),
    }
}

pub fn scalar_i64(conn: &Connection, sql: &str, params: impl Params) -> Result<i64, StorageError> {
    Ok(conn
        .query_row(sql, params, |row| row.get::<_, i64>(0))
        .optional()?
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_runs_jobs_on_one_connection() {
        let store = StoreHandle::in_memory().unwrap();
        store.execute("CREATE TABLE note (body TEXT)", []).unwrap();
        store
            .execute("INSERT INTO note VALUES ('hello')", [])
            .unwrap();
        let value: String = store
            .call(|conn| {
                Ok(conn
                    .query_row("SELECT body FROM note", [], |r| r.get(0))
                    .unwrap())
            })
            .unwrap();
        assert_eq!(value, "hello");
    }

    #[test]
    fn errors_cross_the_actor_boundary_with_their_variant() {
        let store = StoreHandle::in_memory().unwrap();
        let result: Result<(), StorageError> =
            store.call(|_| Err(StorageError::NotFound("x".into())));
        assert!(matches!(result, Err(StorageError::NotFound(_))));
    }

    #[test]
    fn backup_uses_vacuum_into_and_integrity_check_succeeds() {
        let store = StoreHandle::in_memory().unwrap();
        assert_eq!(store.integrity_check().unwrap(), "ok");
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("backup.db");
        store.backup_to(&dest).unwrap();
        assert!(dest.exists());
    }
}
