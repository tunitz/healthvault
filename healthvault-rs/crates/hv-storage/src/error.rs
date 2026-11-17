use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database path refused: {0}")]
    PathRefused(String),
    #[error("database is busy after waiting for the lock: {0}")]
    Busy(String),
    #[error("migration failed: {0}")]
    Migration(String),
    #[error("record not found: {0}")]
    NotFound(String),
    #[error("database failure: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("io failure on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PathRefused(_) => "path_refused",
            Self::Busy(_) => "busy",
            Self::Migration(_) => "migration_failed",
            Self::NotFound(_) => "not_found",
            Self::Sql(_) => "database_error",
            Self::Io { .. } => "io_error",
        }
    }
}

/// Stable wire envelope for errors crossing the storage actor. The source chain is logged at the
/// handling site, so only code and message need to survive the channel.
#[derive(serde::Serialize, serde::Deserialize)]
struct StorageErrorWire {
    code: String,
    message: String,
}

impl serde::Serialize for StorageError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        StorageErrorWire {
            code: self.code().into(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

impl<'de> serde::Deserialize<'de> for StorageError {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = StorageErrorWire::deserialize(deserializer)?;
        Ok(match wire.code.as_str() {
            "path_refused" => Self::PathRefused(wire.message),
            "busy" => Self::Busy(wire.message),
            "migration_failed" => Self::Migration(wire.message),
            "not_found" => Self::NotFound(wire.message),
            "io_error" => Self::Io {
                path: Default::default(),
                source: std::io::Error::other(wire.message),
            },
            _ => Self::Sql(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                Some(wire.message),
            )),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_variant_survives_the_wire_envelope() {
        let json = serde_json::to_string(&StorageError::Busy("locked".into())).unwrap();
        let decoded: StorageError = serde_json::from_str(&json).unwrap();
        assert!(matches!(decoded, StorageError::Busy(_)));
    }
}
