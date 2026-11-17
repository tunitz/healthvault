//! Incremental Apple Health XML parser. Accepts arbitrary byte chunks (including UTF-8 sequences
//! split across boundaries), keeps only the current workout in memory and drains rows in bounded
//! batches. Mirrors `createHealthParser()` in `src/lib/xml.ts`.

use std::collections::HashMap;
use std::io::Cursor;

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use crate::error::IngestError;
use crate::model::{
    HealthRecordRow, MeCharacteristics, ParsedHealth, SummaryRow, WorkoutImportRow,
};
use crate::normalize::{ms_of, number, stage_of, to_kcal, to_km, to_seconds};

#[derive(Debug, Default)]
struct WorkoutStat {
    sum: Option<String>,
    average: Option<String>,
    minimum: Option<String>,
    maximum: Option<String>,
    unit: Option<String>,
}

#[derive(Debug)]
pub struct HealthParser {
    rows: ParsedHealth,
    pending_bytes: Vec<u8>,
    in_correlation: bool,
    record: Option<HashMap<String, String>>,
    workout: Option<HashMap<String, String>>,
    meta: HashMap<String, String>,
    stats: HashMap<String, WorkoutStat>,
    finished: bool,
}

impl Default for HealthParser {
    fn default() -> Self {
        Self::new()
    }
}

impl HealthParser {
    pub fn new() -> Self {
        Self {
            rows: ParsedHealth::default(),
            pending_bytes: Vec::new(),
            in_correlation: false,
            record: None,
            workout: None,
            meta: HashMap::new(),
            stats: HashMap::new(),
            finished: false,
        }
    }

    /// Feed raw bytes. A tag is processed only once fully received (ignoring `>` inside quoted
    /// attribute values), so arbitrary chunk boundaries are safe. Retained bytes are bounded by
    /// the largest single tag, not by the size of the export.
    pub fn write(&mut self, chunk: &[u8]) -> Result<(), IngestError> {
        if self.finished {
            return Err(IngestError::Malformed("parser already closed".into()));
        }
        self.pending_bytes.extend_from_slice(chunk);
        loop {
            let Some((start, end)) = next_tag(&self.pending_bytes) else {
                break;
            };
            let token: Vec<u8> = self.pending_bytes.drain(start..end).collect();
            self.parse_tag(&token)?;
        }
        if let Some(ix) = self.pending_bytes.iter().rposition(|b| *b == b'<')
            && ix > 0
        {
            self.pending_bytes.drain(..ix);
        }
        Ok(())
    }

    /// Parse one complete tag with a fresh quick-xml reader.
    fn parse_tag(&mut self, token: &[u8]) -> Result<(), IngestError> {
        let mut reader = Reader::from_reader(Cursor::new(token));
        reader.config_mut().trim_text(true);
        // Each tag is parsed in isolation; opening tags live in earlier chunks/tokens.
        reader.config_mut().check_end_names = false;
        reader.config_mut().allow_unmatched_ends = true;
        let mut buf = Vec::new();
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(tag)) => self.open(tag.name().as_ref(), &tag)?,
            Ok(Event::Empty(tag)) => {
                self.open(tag.name().as_ref(), &tag)?;
                let name = tag.name().as_ref().to_vec();
                self.close(&name)?;
            }
            Ok(Event::End(tag)) => self.close(tag.name().as_ref())?,
            Ok(
                Event::Eof
                | Event::Comment(_)
                | Event::Decl(_)
                | Event::Text(_)
                | Event::CData(_)
                | Event::PI(_)
                | Event::DocType(_),
            ) => {}
            Err(err) => return Err(IngestError::Malformed(format!("XML parse error: {err}"))),
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), IngestError> {
        if !self.pending_bytes.is_empty() {
            let rest = std::mem::take(&mut self.pending_bytes);
            self.parse_tag(&rest)?;
        }
        if self.record.is_some() || self.workout.is_some() {
            return Err(IngestError::Malformed(
                "unclosed Record or Workout element".into(),
            ));
        }
        self.finished = true;
        Ok(())
    }

    pub fn pending(&self) -> usize {
        self.rows.len()
    }

    pub fn drain(&mut self) -> ParsedHealth {
        self.rows.drain()
    }

    pub fn characteristics(&self) -> MeCharacteristics {
        self.rows.me.clone()
    }

    fn open(
        &mut self,
        name: &[u8],
        tag: &quick_xml::events::BytesStart<'_>,
    ) -> Result<(), IngestError> {
        let attrs = attributes(tag)?;
        match name {
            b"Correlation" => self.in_correlation = true,
            b"Me" => {
                let dob = attrs
                    .get("HKCharacteristicTypeIdentifierDateOfBirth")
                    .cloned()
                    .unwrap_or_default();
                let sex = attrs
                    .get("HKCharacteristicTypeIdentifierBiologicalSex")
                    .cloned()
                    .unwrap_or_default();
                if is_day(&dob) {
                    self.rows.me.date_of_birth = Some(dob);
                }
                if !sex.is_empty() {
                    self.rows.me.biological_sex = Some(
                        sex.strip_prefix("HKBiologicalSex")
                            .unwrap_or(&sex)
                            .to_ascii_lowercase(),
                    );
                }
            }
            b"WorkoutStatistics" if self.workout.is_some() => {
                let key = attrs.get("type").cloned().unwrap_or_default();
                if !key.is_empty() {
                    self.stats.insert(
                        key,
                        WorkoutStat {
                            sum: attrs.get("sum").cloned(),
                            average: attrs.get("average").cloned(),
                            minimum: attrs.get("minimum").cloned(),
                            maximum: attrs.get("maximum").cloned(),
                            unit: attrs.get("unit").cloned(),
                        },
                    );
                }
            }
            b"MetadataEntry" if self.workout.is_some() => {
                if let (Some(key), Some(value)) = (attrs.get("key"), attrs.get("value")) {
                    self.meta.insert(key.clone(), value.clone());
                }
            }
            b"Workout" if !self.in_correlation => {
                self.workout = Some(attrs);
                self.meta.clear();
                self.stats.clear();
            }
            b"ActivitySummary" if !self.in_correlation => {
                let components = attrs.get("dateComponents").cloned().unwrap_or_default();
                let get = |key: &str| number(attrs.get(key).map(String::as_str));
                self.rows.summaries.push(SummaryRow {
                    day: day_of(&components),
                    date_components: components,
                    active_energy_burned: get("activeEnergyBurned"),
                    active_energy_burned_goal: get("activeEnergyBurnedGoal"),
                    apple_move_minutes: get("appleMoveMinutes"),
                    apple_move_minutes_goal: get("appleMoveMinutesGoal"),
                    apple_exercise_time: get("appleExerciseTime"),
                    apple_exercise_time_goal: get("appleExerciseTimeGoal"),
                    apple_stand_hours: get("appleStandHours"),
                    apple_stand_hours_goal: get("appleStandHoursGoal"),
                });
            }
            b"Record" if !self.in_correlation && self.workout.is_none() => {
                self.record = Some(attrs);
            }
            _ => {}
        }
        Ok(())
    }

    fn close(&mut self, name: &[u8]) -> Result<(), IngestError> {
        match name {
            b"Correlation" => self.in_correlation = false,
            b"Workout" => {
                if let Some(attrs) = self.workout.take() {
                    self.rows
                        .workouts
                        .push(build_workout(&attrs, &self.stats, &self.meta)?);
                }
            }
            b"Record" => {
                if let Some(attrs) = self.record.take() {
                    self.rows.records.push(build_record(&attrs)?);
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// Locate a complete `<...>` token, ignoring `>` inside quoted attribute values.
fn next_tag(bytes: &[u8]) -> Option<(usize, usize)> {
    let start = bytes.iter().position(|b| *b == b'<')?;
    if bytes.get(start + 1) == Some(&b'!')
        && bytes.get(start + 2) == Some(&b'-')
        && bytes.get(start + 3) == Some(&b'-')
    {
        let end = bytes[start..].windows(3).position(|w| w == b"-->")? + start + 3;
        return Some((start, end));
    }
    let mut quote = 0u8;
    for ix in start + 1..bytes.len() {
        let byte = bytes[ix];
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
        } else if byte == b'\'' || byte == b'"' {
            quote = byte;
        } else if byte == b'>' {
            return Some((start, ix + 1));
        }
    }
    None
}

fn attributes(
    tag: &quick_xml::events::BytesStart<'_>,
) -> Result<HashMap<String, String>, IngestError> {
    let mut out = HashMap::new();
    for attr in tag.attributes() {
        let attr =
            attr.map_err(|err| IngestError::Malformed(format!("bad XML attribute: {err}")))?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let raw = String::from_utf8_lossy(&attr.value);
        let value = quick_xml::escape::unescape(&raw)
            .map_err(|err| IngestError::Malformed(format!("bad XML entity: {err}")))?
            .into_owned();
        out.insert(key, value);
    }
    Ok(out)
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn is_day(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(ix, b)| ix == 4 || ix == 7 || b.is_ascii_digit())
}

fn day_of(iso: &str) -> String {
    iso.chars().take(10).collect()
}

fn build_record(attrs: &HashMap<String, String>) -> Result<HealthRecordRow, IngestError> {
    let type_identifier = attrs.get("type").cloned().unwrap_or_default();
    let raw_value = attrs.get("value").cloned().unwrap_or_default();
    let value = if type_identifier == "HKCategoryTypeIdentifierSleepAnalysis" {
        stage_of(&raw_value)
    } else if type_identifier.starts_with("HKQuantity") {
        number(Some(&raw_value)).unwrap_or(0.0)
    } else {
        1.0
    };
    let start_date = attrs.get("startDate").cloned().unwrap_or_default();
    let end_date = attrs
        .get("endDate")
        .cloned()
        .unwrap_or_else(|| start_date.clone());
    Ok(HealthRecordRow {
        type_identifier,
        unit: attrs.get("unit").cloned().unwrap_or_default(),
        value,
        start_ms: ms_of(&start_date)?,
        day: day_of(&start_date),
        start_date,
        end_ms: ms_of(&end_date)?,
        end_date,
        source_name: attrs.get("sourceName").cloned().unwrap_or_default(),
    })
}

fn pick_stat<'a>(
    stats: &'a HashMap<String, WorkoutStat>,
    needles: &[&str],
    contains: &str,
) -> Option<&'a WorkoutStat> {
    for needle in needles {
        if let Some(stat) = stats.get(*needle) {
            return Some(stat);
        }
    }
    stats
        .iter()
        .find(|(key, _)| key.to_ascii_lowercase().contains(contains))
        .map(|(_, value)| value)
}

fn build_workout(
    attrs: &HashMap<String, String>,
    stats: &HashMap<String, WorkoutStat>,
    meta: &HashMap<String, String>,
) -> Result<WorkoutImportRow, IngestError> {
    let start_date = attrs.get("startDate").cloned().unwrap_or_default();
    let end_date = attrs.get("endDate").cloned().unwrap_or_default();
    let distance = pick_stat(
        stats,
        &["HKQuantityTypeIdentifierDistanceWalkingRunning"],
        "distance",
    );
    let energy = pick_stat(
        stats,
        &["HKQuantityTypeIdentifierActiveEnergyBurned"],
        "energyburned",
    );
    let hr = pick_stat(stats, &["HKQuantityTypeIdentifierHeartRate"], "heartrate");

    let distance_raw = distance
        .and_then(|s| number(s.sum.as_deref()))
        .or_else(|| number(attrs.get("totalDistance").map(String::as_str)));
    let distance_unit = distance
        .and_then(|s| s.unit.clone())
        .or_else(|| attrs.get("totalDistanceUnit").cloned());
    let distance_km = distance_raw.and_then(|v| to_km(v, distance_unit.as_deref()));
    let unsupported = distance_raw.is_some()
        && distance_km.is_none()
        && distance_unit.as_ref().is_some_and(|u| !u.trim().is_empty());
    let total_distance = distance_km.or_else(|| unsupported.then_some(distance_raw).flatten());
    let total_distance_unit = if distance_km.is_some() || distance_raw.is_none() {
        Some("km".into())
    } else if unsupported {
        distance_unit
    } else {
        None
    };
    let energy_raw = energy
        .and_then(|s| number(s.sum.as_deref()))
        .or_else(|| number(attrs.get("totalEnergyBurned").map(String::as_str)));
    let energy_unit = energy
        .and_then(|s| s.unit.clone())
        .or_else(|| attrs.get("totalEnergyBurnedUnit").cloned());

    let metadata_json = if meta.is_empty() {
        None
    } else {
        // JSON.stringify of an object preserves insertion order; build the same bytes.
        let fields: Vec<String> = meta
            .iter()
            .map(|(key, value)| format!("{}:{}", quote(key), quote(value)))
            .collect();
        Some(format!("{{{}}}", fields.join(",")))
    };

    Ok(WorkoutImportRow {
        workout_activity_type: attrs
            .get("workoutActivityType")
            .cloned()
            .unwrap_or_else(|| "Unknown".into()),
        start_ms: ms_of(&start_date)?,
        day: day_of(&start_date),
        start_date,
        end_ms: ms_of(&end_date)?,
        end_date,
        duration_seconds: number(attrs.get("duration").map(String::as_str))
            .map(|v| to_seconds(v, attrs.get("durationUnit").map(String::as_str))),
        total_distance,
        total_distance_unit,
        total_energy_burned: energy_raw.map(|v| to_kcal(v, energy_unit.as_deref())),
        total_energy_burned_unit: Some("kcal".into()),
        avg_hr: hr.and_then(|s| number(s.average.as_deref())),
        min_hr: hr.and_then(|s| number(s.minimum.as_deref())),
        max_hr: hr.and_then(|s| number(s.maximum.as_deref())),
        source_name: attrs.get("sourceName").cloned(),
        metadata_json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_chunks_and_split_utf8_are_buffered() {
        let xml = "<HealthData><Record type=\"HKQuantityTypeIdentifierStepCount\" value=\"42\" unit=\"count\" startDate=\"2026-11-17 08:00:00 +0800\" endDate=\"2026-11-17 08:01:00 +0800\" sourceName=\"Phone\"/></HealthData>";
        let mut parser = HealthParser::new();
        for chunk in xml.as_bytes().chunks(7) {
            parser.write(chunk).unwrap();
        }
        parser.finish().unwrap();
        let parsed = parser.drain();
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].value, 42.0);
        assert_eq!(parsed.records[0].day, "2026-11-17");
    }

    #[test]
    fn correlations_are_skipped_but_top_level_records_kept() {
        let xml = "<HealthData><Correlation><Record type=\"HKQuantityTypeIdentifierStepCount\" value=\"99\" startDate=\"2026-11-17 08:00:00 +0800\"/></Correlation><Record type=\"HKQuantityTypeIdentifierStepCount\" value=\"1\" startDate=\"2026-11-17 08:00:00 +0800\"/></HealthData>";
        let mut parser = HealthParser::new();
        parser.write(xml.as_bytes()).unwrap();
        parser.finish().unwrap();
        let parsed = parser.drain();
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].value, 1.0);
    }

    #[test]
    fn workout_statistics_and_duration_units_are_normalised() {
        let xml = "<HealthData><Workout workoutActivityType=\"HKWorkoutActivityTypeRunning\" startDate=\"2026-11-17 06:00:00 +0800\" endDate=\"2026-11-17 06:40:00 +0800\" duration=\"40\" durationUnit=\"min\" sourceName=\"Watch\"><WorkoutStatistics type=\"HKQuantityTypeIdentifierDistanceWalkingRunning\" sum=\"5\" unit=\"km\"/><WorkoutStatistics type=\"HKQuantityTypeIdentifierHeartRate\" average=\"150\" minimum=\"120\" maximum=\"175\" unit=\"count/min\"/><MetadataEntry key=\"weather\" value=\"sunny\"/></Workout></HealthData>";
        let mut parser = HealthParser::new();
        parser.write(xml.as_bytes()).unwrap();
        parser.finish().unwrap();
        let parsed = parser.drain();
        assert_eq!(parsed.workouts.len(), 1);
        let workout = &parsed.workouts[0];
        assert_eq!(workout.duration_seconds, Some(2400.0));
        assert_eq!(workout.total_distance, Some(5.0));
        assert_eq!(workout.avg_hr, Some(150.0));
        assert!(
            workout
                .metadata_json
                .as_ref()
                .is_some_and(|v| v.contains("weather"))
        );
    }
}
