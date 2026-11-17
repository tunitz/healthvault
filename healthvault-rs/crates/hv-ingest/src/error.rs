use std::path::PathBuf;

/// Failure table for `ingest_export`:
/// missing file / denied access -> `SourceMissing` / `AccessDenied` (report, no retry);
/// malformed zip or XML -> Malformed (fail the upload row, keep prior rows);
/// oversize zip or XML -> `TooLarge` (reject before further reads);
/// export.xml absent -> `MissingExport` (report archive contents);
/// storage contention -> Busy (surface as retryable).
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("source file not found: {path}")]
    SourceMissing { path: PathBuf },
    #[error("permission denied reading {path}")]
    AccessDenied { path: PathBuf },
    #[error("malformed export: {0}")]
    Malformed(String),
    #[error("input is {size} bytes; limit is {limit}")]
    TooLarge { size: u64, limit: u64 },
    #[error("export.xml not found in archive (entries: {0})")]
    MissingExport(String),
    #[error("storage unavailable: {0}")]
    Storage(#[from] hv_storage::StorageError),
    #[error("io failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip failure: {0}")]
    Zip(#[from] zip::result::ZipError),
}
