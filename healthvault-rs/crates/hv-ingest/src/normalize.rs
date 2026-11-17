//! Unit and timestamp normalization ported verbatim from `src/lib/xml.ts`.

use chrono::{DateTime, NaiveDateTime, Utc};

use crate::error::IngestError;

/// Apple writes `2026-09-01 07:30:00 +0800`; parse the offset with a colon like the TS app does.
pub fn ms_of(raw: &str) -> Result<i64, IngestError> {
    if raw.is_empty() {
        return Ok(0);
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 19 {
        let date = &raw[0..10];
        let separator = bytes[10];
        let time = &raw[11..19];
        if separator == b' ' || separator == b'T' {
            let clock = format!("{date}T{time}");
            let naive = NaiveDateTime::parse_from_str(&clock, "%Y-%m-%dT%H:%M:%S")
                .map_err(|err| IngestError::Malformed(format!("bad timestamp {raw}: {err}")))?;
            let offset = raw[19..].trim();
            let formatted =
                if offset.len() == 5 && (offset.starts_with('+') || offset.starts_with('-')) {
                    format!("{}:{}", &offset[..3], &offset[3..])
                } else {
                    offset.to_owned()
                };
            if !formatted.is_empty() {
                let with_offset = format!("{clock}{formatted}");
                let dt = DateTime::parse_from_rfc3339(&with_offset).map_err(|err| {
                    IngestError::Malformed(format!("bad timestamp offset {raw}: {err}"))
                })?;
                return Ok(dt.timestamp_millis());
            }
            return Ok(dt_utc(naive));
        }
    }
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f"))
        .map_err(|err| IngestError::Malformed(format!("bad timestamp {raw}: {err}")))?;
    Ok(dt_utc(naive))
}

fn dt_utc(naive: NaiveDateTime) -> i64 {
    DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc).timestamp_millis()
}

pub fn stage_of(value: &str) -> f64 {
    match value {
        "HKCategoryValueSleepAnalysisInBed" => 1.0,
        "HKCategoryValueSleepAnalysisAsleepUnspecified" | "HKCategoryValueSleepAnalysisAsleep" => {
            2.0
        }
        "HKCategoryValueSleepAnalysisAwake" => 3.0,
        "HKCategoryValueSleepAnalysisAsleepCore" => 4.0,
        "HKCategoryValueSleepAnalysisAsleepDeep" => 5.0,
        "HKCategoryValueSleepAnalysisAsleepREM" => 6.0,
        _ => 0.0,
    }
}

pub fn to_km(value: f64, unit: Option<&str>) -> Option<f64> {
    match unit.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "km" => Some(value),
        "mi" => Some(value * 1.609_344),
        "m" => Some(value / 1000.0),
        "yd" => Some(value * 0.000_914_4),
        "ft" => Some(value * 0.000_304_8),
        _ => None,
    }
}

pub fn to_kcal(value: f64, unit: Option<&str>) -> f64 {
    match unit.unwrap_or("").to_ascii_lowercase().as_str() {
        "kj" => value * 0.239_005_7,
        "cal" => value / 1000.0,
        _ => value,
    }
}

pub fn to_seconds(value: f64, unit: Option<&str>) -> f64 {
    let unit = unit.unwrap_or("sec").to_ascii_lowercase();
    if unit.starts_with("min") {
        value * 60.0
    } else if unit.starts_with('h') {
        value * 3600.0
    } else {
        value
    }
}

pub fn number(value: Option<&str>) -> Option<f64> {
    match value {
        None | Some("") => None,
        Some(raw) => raw.parse::<f64>().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_offset_format_is_parsed() {
        assert_eq!(
            ms_of("2026-09-01 07:30:00 +0800").unwrap(),
            ms_of("2026-09-01T07:30:00+08:00").unwrap()
        );
    }

    #[test]
    fn distance_and_energy_units_normalise_like_xml_ts() {
        assert!((to_km(1.0, Some(" mi ")).unwrap() - 1.609_344).abs() < 1e-9);
        assert_eq!(to_km(5.0, Some("furlong")), None);
        assert!((to_kcal(100.0, Some("kj")) - 23.900_57).abs() < 1e-9);
        assert_eq!(to_seconds(2.0, Some("min")), 120.0);
    }

    #[test]
    fn sleep_stage_names_map_to_numbers() {
        assert_eq!(stage_of("HKCategoryValueSleepAnalysisAsleepREM"), 6.0);
        assert_eq!(stage_of("HKCategoryValueSleepAnalysisInBed"), 1.0);
        assert_eq!(stage_of("unknown"), 0.0);
    }
}
