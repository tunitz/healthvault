//! Apple record/workout reconciliation rules, ported from `src/db/queries.ts`.
//!
//! These are pure functions over rows supplied by a repository. The TS app keeps them in SQL
//! CTEs (`WORKOUT_DEDUP`, single-source-per-day); here the same rules are applied in memory so
//! they are testable without a database and reusable by the native, HTTP and WASM shells.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::day::Day;

pub const STEP_COUNT: &str = "HKQuantityTypeIdentifierStepCount";
pub const HEART_RATE: &str = "HKQuantityTypeIdentifierHeartRate";
pub const RESTING_HEART_RATE: &str = "HKQuantityTypeIdentifierRestingHeartRate";
pub const VO2_MAX: &str = "HKQuantityTypeIdentifierVO2Max";
pub const WALKING_HEART_RATE: &str = "HKQuantityTypeIdentifierWalkingHeartRateAverage";
pub const SLEEP_ANALYSIS: &str = "HKCategoryTypeIdentifierSleepAnalysis";

pub const FIVE_K_MIN_KM: f64 = 4.9;
pub const FIVE_K_MAX_KM: f64 = 5.5;
pub const FIVE_K_BEST_MIN_KM: f64 = 4.95;

/// One imported Apple Health quantity/category record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuantityRecord {
    pub id: i64,
    pub type_identifier: String,
    pub unit: String,
    pub value: f64,
    pub start_date: String,
    pub start_ms: i64,
    pub day: Day,
    pub end_date: String,
    pub end_ms: i64,
    pub source_name: String,
}

/// One imported Apple Health workout, before or after device reconciliation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkoutRow {
    pub id: i64,
    pub activity_type: String,
    pub start_date: String,
    pub start_ms: i64,
    pub day: Day,
    pub end_date: String,
    pub end_ms: i64,
    pub duration_seconds: Option<f64>,
    pub total_distance: Option<f64>,
    pub total_distance_unit: Option<String>,
    pub total_energy_burned: Option<f64>,
    pub avg_hr: Option<f64>,
    pub min_hr: Option<f64>,
    pub max_hr: Option<f64>,
    pub source_name: Option<String>,
}

impl WorkoutRow {
    pub fn distance_km(&self) -> Option<f64> {
        distance_km(self.total_distance, self.total_distance_unit.as_deref())
    }

    pub fn pace_min_per_km(&self) -> Option<f64> {
        let km = self.distance_km()?;
        let seconds = self.duration_seconds?;
        if km > 0.0 && seconds > 0.0 {
            Some(seconds / 60.0 / km)
        } else {
            None
        }
    }
}

/// `WORKOUT_DISTANCE_KM` in `queries.ts`, applied in Rust.
pub fn distance_km(distance: Option<f64>, unit: Option<&str>) -> Option<f64> {
    let value = distance?;
    if !value.is_finite() {
        return None;
    }
    match unit.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "km" => Some(value),
        "mi" => Some(value * 1.609_344),
        "m" => Some(value / 1000.0),
        "yd" => Some(value * 0.000_914_4),
        "ft" => Some(value * 0.000_304_8),
        // A blank or unknown unit is unknown, never silently treated as kilometres.
        _ => None,
    }
}

/// The only workout reconciliation rule in the product. One row per
/// `(activity_type, start_date, end_date)`: prefer normalised distance, then duration, then
/// lowest id. Input order does not affect the result.
pub fn reconcile_workouts(rows: impl IntoIterator<Item = WorkoutRow>) -> Vec<WorkoutRow> {
    let mut groups: HashMap<(String, String, String), WorkoutRow> = HashMap::new();
    for row in rows {
        let key = (
            row.activity_type.clone(),
            row.start_date.clone(),
            row.end_date.clone(),
        );
        let better = groups.get(&key).is_none_or(|best| rank(&row) > rank(best));
        if better {
            groups.insert(key, row);
        }
    }
    let mut result: Vec<WorkoutRow> = groups.into_values().collect();
    result.sort_unstable_by(|a, b| b.start_ms.cmp(&a.start_ms).then_with(|| a.id.cmp(&b.id)));
    result
}

fn rank(row: &WorkoutRow) -> (u8, u8, std::cmp::Reverse<i64>) {
    (
        u8::from(row.distance_km().is_some()),
        u8::from(row.duration_seconds.is_some()),
        std::cmp::Reverse(row.id),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeriesAggregation {
    Sum,
    Avg,
}

/// One day's value from the source with the most samples that day (ties: higher value).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyPoint {
    pub day: Day,
    pub value: f64,
    pub source: String,
}

/// `dailySeriesSingleSource` in `queries.ts`: summing all devices double counts phone+watch.
pub fn daily_series_single_source(
    records: &[QuantityRecord],
    type_identifier: &str,
    from: &Day,
    aggregation: SeriesAggregation,
) -> Vec<DailyPoint> {
    #[derive(Default)]
    struct Bucket {
        sum: f64,
        count: usize,
        source: String,
    }
    let mut per_source: BTreeMap<(Day, String), Bucket> = BTreeMap::new();
    for row in records {
        if row.type_identifier != type_identifier || row.day < *from {
            continue;
        }
        let bucket = per_source
            .entry((row.day, row.source_name.clone()))
            .or_default();
        bucket.sum += row.value;
        bucket.count += 1;
        bucket.source = row.source_name.clone();
    }

    let mut per_day: BTreeMap<Day, DailyPoint> = BTreeMap::new();
    for ((day, source), bucket) in per_source {
        let value = match aggregation {
            SeriesAggregation::Sum => bucket.sum,
            SeriesAggregation::Avg => bucket.sum / bucket.count as f64,
        };
        let candidate = DailyPoint { day, value, source };
        let replace = per_day.get(&day).is_none_or(|best| {
            bucket.count > best_count(records, &best.source, day)
                || (bucket.count == best_count(records, &best.source, day) && value > best.value)
        });
        if replace {
            per_day.insert(day, candidate);
        }
    }
    per_day.into_values().collect()
}

fn best_count(records: &[QuantityRecord], source: &str, day: Day) -> usize {
    records
        .iter()
        .filter(|row| row.day == day && row.source_name == source)
        .count()
}

/// A sleep segment belongs to the night that started the previous evening.
pub fn night_of(day: &Day, start_date: &str) -> Day {
    let hour = start_date
        .get(11..13)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    if hour < 12 { day.add(-1) } else { *day }
}

/// `InBed` (1) and Awake (3) are excluded from asleep totals.
pub fn is_asleep(value: f64) -> bool {
    matches!(value as i64, 2 | 4 | 5 | 6)
}

pub fn is_sleep_stage(value: f64) -> bool {
    matches!(value as i64, 2..=6)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FiveKAttempt {
    pub day: Day,
    pub km: f64,
    pub seconds: f64,
    pub pace_min_per_km: f64,
}

fn attempt_of(row: &WorkoutRow) -> Option<FiveKAttempt> {
    let km = row.distance_km()?;
    let seconds = row.duration_seconds?;
    if !(FIVE_K_MIN_KM..=FIVE_K_MAX_KM).contains(&km) || seconds <= 0.0 {
        return None;
    }
    Some(FiveKAttempt {
        day: row.day,
        km,
        seconds,
        pace_min_per_km: seconds / 60.0 / km,
    })
}

/// Deduped running sessions between 4.9 and 5.5 km, oldest first.
pub fn five_k_attempts(workouts: &[WorkoutRow], from: &Day) -> Vec<FiveKAttempt> {
    let mut attempts: Vec<FiveKAttempt> = workouts
        .iter()
        .filter(|row| row.activity_type.contains("Running") && row.day >= *from)
        .filter_map(attempt_of)
        .collect();
    attempts.sort_unstable_by(|a, b| {
        a.day
            .cmp(&b.day)
            .then_with(|| a.seconds.total_cmp(&b.seconds))
    });
    attempts
}

/// Fastest pace wins; ties go to shorter duration. Rows shorter than 4.95 km cannot win.
pub fn five_k_best(workouts: &[WorkoutRow], from: &Day) -> Option<FiveKAttempt> {
    five_k_attempts(workouts, from)
        .into_iter()
        .filter(|attempt| attempt.km >= FIVE_K_BEST_MIN_KM)
        .min_by(|a, b| {
            a.pace_min_per_km
                .total_cmp(&b.pace_min_per_km)
                .then_with(|| a.seconds.total_cmp(&b.seconds))
                .then_with(|| a.day.cmp(&b.day))
        })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeeklyVolume {
    pub week_start: Day,
    pub week_end: Day,
    pub sessions: usize,
    pub minutes: f64,
    pub km: f64,
    pub avg_hr: Option<f64>,
}

pub fn weekly_training(workouts: &[WorkoutRow], from: &Day) -> Vec<WeeklyVolume> {
    let mut buckets: BTreeMap<Day, Vec<&WorkoutRow>> = BTreeMap::new();
    for row in workouts {
        if row.day >= *from && row.day <= Day::parse("9999-12-31").unwrap_or(*from) {
            buckets.entry(row.day.week_start()).or_default().push(row);
        }
    }
    buckets
        .into_iter()
        .map(|(week_start, rows)| {
            let minutes = rows.iter().filter_map(|r| r.duration_seconds).sum::<f64>() / 60.0;
            let km = rows.iter().filter_map(|r| r.distance_km()).sum();
            let hrs: Vec<f64> = rows.iter().filter_map(|r| r.avg_hr).collect();
            let avg_hr = (!hrs.is_empty()).then(|| hrs.iter().sum::<f64>() / hrs.len() as f64);
            WeeklyVolume {
                week_start,
                week_end: week_start.add(6),
                sessions: rows.len(),
                minutes,
                km,
                avg_hr,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> Day {
        Day::parse(s).unwrap()
    }

    fn workout(id: i64, km: Option<f64>, duration: Option<f64>) -> WorkoutRow {
        WorkoutRow {
            id,
            activity_type: "HKWorkoutActivityTypeRunning".into(),
            start_date: "2026-11-17 06:00:00 +0800".into(),
            start_ms: id,
            day: day("2026-11-17"),
            end_date: "2026-11-17 06:40:00 +0800".into(),
            end_ms: id + 100,
            duration_seconds: duration,
            total_distance: km,
            total_distance_unit: Some("km".into()),
            total_energy_burned: None,
            avg_hr: None,
            min_hr: None,
            max_hr: None,
            source_name: Some("iPhone".into()),
        }
    }

    #[test]
    fn unit_normalisation_matches_sql_case() {
        assert_eq!(distance_km(Some(1.0), Some(" mi ")), Some(1.609_344));
        assert_eq!(distance_km(Some(1000.0), Some("m")), Some(1.0));
        assert_eq!(distance_km(Some(5.0), Some("furlong")), None);
        assert_eq!(distance_km(Some(5.0), None), None);
    }

    #[test]
    fn duplicate_devices_collapse_to_one_session_preferring_distance() {
        let rows = vec![
            workout(3, None, Some(2400.0)),
            workout(2, Some(5.0), None),
            workout(1, Some(5.0), Some(2400.0)),
        ];
        let dedup = reconcile_workouts(rows);
        assert_eq!(dedup.len(), 1);
        assert_eq!(dedup[0].id, 1);
    }

    #[test]
    fn selected_source_has_the_most_samples_not_the_largest_sum() {
        let records = vec![
            QuantityRecord {
                id: 1,
                type_identifier: STEP_COUNT.into(),
                unit: "count".into(),
                value: 9000.0,
                start_date: "s".into(),
                start_ms: 1,
                day: day("2026-11-17"),
                end_date: "e".into(),
                end_ms: 2,
                source_name: "Phone".into(),
            },
            QuantityRecord {
                id: 2,
                type_identifier: STEP_COUNT.into(),
                unit: "count".into(),
                value: 2000.0,
                start_date: "s".into(),
                start_ms: 3,
                day: day("2026-11-17"),
                end_date: "e".into(),
                end_ms: 4,
                source_name: "Phone".into(),
            },
            QuantityRecord {
                id: 3,
                type_identifier: STEP_COUNT.into(),
                unit: "count".into(),
                value: 9500.0,
                start_date: "s".into(),
                start_ms: 5,
                day: day("2026-11-17"),
                end_date: "e".into(),
                end_ms: 6,
                source_name: "Watch".into(),
            },
        ];
        let series = daily_series_single_source(
            &records,
            STEP_COUNT,
            &day("2026-11-01"),
            SeriesAggregation::Sum,
        );
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].source, "Phone");
        assert_eq!(series[0].value, 11_000.0);
    }

    #[test]
    fn sleep_after_midnight_belongs_to_the_previous_night() {
        assert_eq!(
            night_of(&day("2026-11-18"), "2026-11-18 01:30:00 +0800"),
            day("2026-11-17")
        );
        assert_eq!(
            night_of(&day("2026-11-17"), "2026-11-17 23:30:00 +0800"),
            day("2026-11-17")
        );
        assert!(!is_asleep(1.0));
        assert!(is_asleep(2.0));
    }

    #[test]
    fn best_5k_requires_at_least_495_km_and_fastest_pace() {
        let mut rows = vec![
            workout(1, Some(4.92), Some(1300.0)),
            workout(2, Some(5.0), Some(1500.0)),
        ];
        rows[1].start_ms = 2;
        let best = five_k_best(&rows, &day("2026-11-01")).unwrap();
        assert_eq!(best.km, 5.0);
    }
}
