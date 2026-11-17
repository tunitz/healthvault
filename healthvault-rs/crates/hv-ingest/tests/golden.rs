//! Golden parity against outputs captured from the current TypeScript implementation.
//! Regenerate fixtures with: bun healthvault-rs/fixtures/generate-golden.ts

use hv_core::day::Day;
use hv_core::error::TimezoneName;
use hv_core::workouts::{SeriesAggregation, daily_series_single_source};
use hv_ingest::{HealthParser, normalize};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("../../../fixtures/golden.json");
const XML: &str = include_str!("../../../fixtures/apple-health-fixture.xml");

#[test]
fn day_windows_match_the_typescript_helper() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden json");
    let tz = TimezoneName::parse("Asia/Manila").expect("valid zone");
    for (day, expected) in golden["day"].as_object().expect("day map") {
        let day = Day::parse(day).expect("valid day");
        assert_eq!(
            day.start_ms(&tz),
            expected["startMs"].as_i64().expect("number")
        );
        assert_eq!(day.end_ms(&tz), expected["endMs"].as_i64().expect("number"));
        assert_eq!(
            i64::from(day.weekday_index()),
            expected["weekdayIndex"].as_i64().expect("number")
        );
        assert_eq!(
            day.week_start().to_string(),
            expected["weekStart"].as_str().expect("string")
        );
    }
}

#[test]
fn parsing_matches_the_typescript_parser_field_for_field() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden json");
    let mut parser = HealthParser::new();
    for chunk in XML.as_bytes().chunks(13) {
        parser.write(chunk).expect("parse chunk");
    }
    parser.finish().expect("finish");
    let parsed = parser.drain();

    // Convert Rust field names to the wire names the TS parser emits.
    let records: Vec<Value> = parsed
        .records
        .iter()
        .map(|r| {
            json!({
                "typeIdentifier": r.type_identifier, "unit": r.unit, "value": r.value,
                "startDate": r.start_date, "startMs": r.start_ms, "day": r.day,
                "endDate": r.end_date, "endMs": r.end_ms, "sourceName": r.source_name,
            })
        })
        .collect();
    let workouts: Vec<Value> = parsed.workouts.iter().map(|w| json!({
        "workoutActivityType": w.workout_activity_type, "startDate": w.start_date, "startMs": w.start_ms,
        "day": w.day, "endDate": w.end_date, "endMs": w.end_ms,
        "durationSeconds": w.duration_seconds, "totalDistance": w.total_distance,
        "totalDistanceUnit": w.total_distance_unit, "totalEnergyBurned": w.total_energy_burned,
        "totalEnergyBurnedUnit": w.total_energy_burned_unit, "avgHr": w.avg_hr, "minHr": w.min_hr,
        "maxHr": w.max_hr, "sourceName": w.source_name, "metadataJson": w.metadata_json,
    })).collect();
    let summaries: Vec<Value> = parsed.summaries.iter().map(|s| json!({
        "dateComponents": s.date_components, "day": s.day,
        "activeEnergyBurned": s.active_energy_burned, "activeEnergyBurnedGoal": s.active_energy_burned_goal,
        "appleMoveMinutes": s.apple_move_minutes, "appleMoveMinutesGoal": s.apple_move_minutes_goal,
        "appleExerciseTime": s.apple_exercise_time, "appleExerciseTimeGoal": s.apple_exercise_time_goal,
        "appleStandHours": s.apple_stand_hours, "appleStandHoursGoal": s.apple_stand_hours_goal,
    })).collect();
    let expected = &golden["parsed"];
    let mut actual_records = json!(records);
    let mut actual_workouts = json!(workouts);
    let mut actual_summaries = json!(summaries);
    let mut expected_records = expected["records"].clone();
    let mut expected_workouts = expected["workouts"].clone();
    let mut expected_summaries = expected["summaries"].clone();
    for value in [
        &mut actual_records,
        &mut actual_workouts,
        &mut actual_summaries,
        &mut expected_records,
        &mut expected_workouts,
        &mut expected_summaries,
    ] {
        normalize_numbers(value);
        strip_nulls(value);
    }
    assert_eq!(actual_records, expected_records);
    assert_eq!(actual_workouts, expected_workouts);
    assert_eq!(actual_summaries, expected_summaries);
    assert_eq!(
        json!({"dateOfBirth": parsed.me.date_of_birth, "biologicalSex": parsed.me.biological_sex}),
        expected["me"]
    );
}

#[test]
fn normalization_matches_the_typescript_helpers() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden json");
    let n = &golden["normalization"];
    assert_eq!(normalize::to_km(1.0, Some("mi")), n["kmFromMiles"].as_f64());
    assert_eq!(
        normalize::to_km(1000.0, Some("m")),
        n["kmFromMeters"].as_f64()
    );
    assert!(
        (normalize::to_kcal(100.0, Some("kj")) - n["kcalFromKj"].as_f64().unwrap()).abs() < 1e-9
    );
    assert_eq!(
        normalize::to_seconds(40.0, Some("min")),
        n["secondsFromMin"].as_f64().expect("number")
    );
    assert_eq!(
        normalize::ms_of("2026-09-01 07:30:00 +0800").expect("timestamp"),
        n["appleTimestampMs"].as_i64().expect("number")
    );
}

#[test]
fn single_source_per_day_selects_phone_over_watch_by_sample_count() {
    let mut parser = HealthParser::new();
    parser.write(XML.as_bytes()).expect("parse");
    parser.finish().expect("finish");
    let parsed = parser.drain();
    let records: Vec<hv_core::workouts::QuantityRecord> = parsed
        .records
        .into_iter()
        .enumerate()
        .map(|(id, row)| hv_core::workouts::QuantityRecord {
            id: id as i64,
            type_identifier: row.type_identifier,
            unit: row.unit,
            value: row.value,
            start_date: row.start_date,
            start_ms: row.start_ms,
            day: Day::parse(&row.day).expect("valid day"),
            end_date: row.end_date,
            end_ms: row.end_ms,
            source_name: row.source_name,
        })
        .collect();
    let series = daily_series_single_source(
        &records,
        "HKQuantityTypeIdentifierStepCount",
        &Day::parse("2026-11-01").expect("valid day"),
        SeriesAggregation::Sum,
    );
    assert_eq!(series.len(), 1);
    // Phone has two samples, Watch one: Phone wins by sample count, giving 2000 rather than
    // the 5700 that a naive all-device sum would produce.
    assert_eq!(series[0].source, "Phone");
    assert_eq!(series[0].value, 2000.0);
}

/// `serde_json` distinguishes `1200` from `1200.0`; the wire values are numerically equal.
fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            if let Some(float) = number.as_f64() {
                *value = json!(float);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Value::Object(map) => map.values_mut().for_each(normalize_numbers),
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

/// JSON.stringify omits `undefined` fields; Rust serialises them as null.
fn strip_nulls(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(strip_nulls),
        Value::Object(map) => {
            map.retain(|_, child| !child.is_null());
            map.values_mut().for_each(strip_nulls);
        }
        Value::Null | Value::Number(_) | Value::Bool(_) | Value::String(_) => {}
    }
}
