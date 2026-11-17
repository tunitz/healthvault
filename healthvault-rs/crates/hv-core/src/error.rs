use std::fmt;

/// Every failure mode shared by the portable domain layer.
///
/// Shells (HTTP, MCP, GPUI) map these variants to their own wire/presentation errors at
/// exactly one boundary; no framework error type is allowed inside this crate.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CoreError {
    #[error("invalid {field}: {reason}")]
    Validation { field: String, reason: String },
    #[error("unknown IANA timezone: {0}")]
    UnknownTimezone(String),
    #[error("invalid local day: {0}")]
    InvalidDay(String),
    #[error("{0}")]
    Domain(String),
}

impl CoreError {
    pub fn validation(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Validation {
            field: field.into(),
            reason: reason.into(),
        }
    }

    pub fn domain(message: impl Into<String>) -> Self {
        Self::Domain(message.into())
    }

    /// Stable machine-readable code used by the HTTP and MCP shells.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation { .. } => "invalid_input",
            Self::UnknownTimezone(_) => "unknown_timezone",
            Self::InvalidDay(_) => "invalid_day",
            Self::Domain(_) => "domain_error",
        }
    }
}

/// Newtype for a validated IANA timezone name. Construction validates once at the boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimezoneName {
    name: String,
    tz: chrono_tz::Tz,
}

impl TimezoneName {
    pub fn parse(raw: &str) -> Result<Self, CoreError> {
        let name = raw.trim();
        let tz = name
            .parse::<chrono_tz::Tz>()
            .map_err(|_| CoreError::UnknownTimezone(name.to_owned()))?;
        Ok(Self {
            name: name.to_owned(),
            tz,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.name
    }

    pub fn tz(&self) -> chrono_tz::Tz {
        self.tz
    }
}

impl fmt::Display for TimezoneName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timezone_newtype_rejects_unknown_names() {
        assert!(TimezoneName::parse("Mars/Olympus").is_err());
        assert_eq!(
            TimezoneName::parse("Asia/Manila").unwrap().as_str(),
            "Asia/Manila"
        );
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(CoreError::domain("x").code(), "domain_error");
        assert_eq!(CoreError::InvalidDay("x".into()).code(), "invalid_day");
    }
}
