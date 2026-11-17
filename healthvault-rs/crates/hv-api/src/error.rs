use hv_core::CoreError;
use hv_ingest::IngestError;
use hv_storage::StorageError;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("unauthenticated")]
    Unauthenticated,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("tool not found: {0}")]
    ToolNotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("internal failure")]
    Internal,
}

impl ApiError {
    pub fn status(&self) -> u16 {
        match self {
            Self::Unauthenticated => 401,
            Self::Forbidden(_) => 403,
            Self::InvalidInput(_) | Self::ToolNotFound(_) => 400,
            Self::Conflict(_) => 409,
            Self::NotFound(_) => 404,
            Self::Internal => 500,
        }
    }

    pub fn wire_code(&self) -> &'static str {
        match self {
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden(_) => "forbidden",
            Self::InvalidInput(_) => "invalid_input",
            Self::ToolNotFound(_) => "tool_not_found",
            Self::Conflict(_) => "conflict",
            Self::NotFound(_) => "not_found",
            Self::Internal => "internal_error",
        }
    }
}

impl From<CoreError> for ApiError {
    fn from(err: CoreError) -> Self {
        match err {
            CoreError::Validation { .. }
            | CoreError::InvalidDay(_)
            | CoreError::UnknownTimezone(_) => Self::InvalidInput(err.to_string()),
            CoreError::Domain(message) if message.contains("stale") => Self::Conflict(message),
            CoreError::Domain(message) => Self::InvalidInput(message),
        }
    }
}

impl From<StorageError> for ApiError {
    fn from(err: StorageError) -> Self {
        tracing::error!(error = %err, code = err.code(), "storage failure");
        match err {
            StorageError::NotFound(message) => Self::NotFound(message),
            StorageError::Busy(_) => Self::Conflict(err.to_string()),
            _ => Self::Internal,
        }
    }
}

impl From<IngestError> for ApiError {
    fn from(err: IngestError) -> Self {
        tracing::error!(error = %err, "ingest failure");
        match err {
            IngestError::TooLarge { .. } => Self::InvalidInput(err.to_string()),
            IngestError::MissingExport(_) | IngestError::Malformed(_) => {
                Self::InvalidInput(err.to_string())
            }
            _ => Self::Internal,
        }
    }
}
