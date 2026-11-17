//! Browser-facing surface for the portable core. Deliberately core-only: SQLite, streams and
//! GPUI stay behind the native adapter until the storage-on-WASM ADR is resolved.

use hv_core::day::{Day, local_day};
use hv_core::error::TimezoneName;
use hv_core::history::{HistoryChange, HistoryScope, hash_changes};
use hv_core::macros::Macros;
use hv_core::nutrition::{FoodState, SnapshotValues, basis_grams, rescale_snapshot};
use hv_core::workouts::{WorkoutRow, distance_km, five_k_best, night_of, reconcile_workouts};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn core_version() -> String {
    "hv-core 0.1.0".into()
}

/// Local calendar day of an epoch-millis instant in a validated IANA zone.
#[wasm_bindgen]
pub fn local_day_string(epoch_ms: i64, timezone: &str) -> Result<String, JsValue> {
    let tz = TimezoneName::parse(timezone).map_err(|err| JsValue::from_str(&err.to_string()))?;
    Ok(local_day(epoch_ms, &tz).to_string())
}

/// Sum six macro values passed as a JSON array. The JSON boundary keeps the surface small.
#[wasm_bindgen]
pub fn sum_macros_json(rows_json: &str) -> Result<String, JsValue> {
    let rows: Vec<Macros> =
        serde_json::from_str(rows_json).map_err(|err| JsValue::from_str(&err.to_string()))?;
    serde_json::to_string(&Macros::sum(rows)).map_err(|err| JsValue::from_str(&err.to_string()))
}

/// SHA-256 of a scoped change set, cross-runtime compatible with the TypeScript app.
#[wasm_bindgen]
pub fn preview_hash(scope_json: &str, changes_json: &str) -> Result<String, JsValue> {
    let scope: HistoryScope =
        serde_json::from_str(scope_json).map_err(|err| JsValue::from_str(&err.to_string()))?;
    let changes: Vec<HistoryChange> =
        serde_json::from_str(changes_json).map_err(|err| JsValue::from_str(&err.to_string()))?;
    Ok(hash_changes(&scope, &changes))
}

/// One row per workout session, with the phone/watch duplicate rule applied.
#[wasm_bindgen]
pub fn dedupe_workouts_json(rows_json: &str) -> Result<String, JsValue> {
    let rows: Vec<WorkoutRow> =
        serde_json::from_str(rows_json).map_err(|err| JsValue::from_str(&err.to_string()))?;
    serde_json::to_string(&reconcile_workouts(rows))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

#[wasm_bindgen]
pub fn workout_distance_km(value: f64, unit: &str) -> Option<f64> {
    distance_km(Some(value), Some(unit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_and_macro_functions_work_in_native_tests() {
        assert_eq!(local_day_string(0, "Asia/Manila").unwrap(), "1970-01-01");
        assert_eq!(sum_macros_json(r#"[{"kcal":100.0,"protein_g":1.0,"carbs_g":0.0,"fat_g":0.0,"fibre_g":0.0,"sodium_mg":0.0}]"#).unwrap(),
            "{\"kcal\":100.0,\"protein_g\":1.0,\"carbs_g\":0.0,\"fat_g\":0.0,\"fibre_g\":0.0,\"sodium_mg\":0.0}");
    }
}

/// DST-safe local day window as epoch millis `[start, end]`.
#[wasm_bindgen]
pub fn day_window(day: &str, timezone: &str) -> Result<Vec<i64>, JsValue> {
    let day = Day::parse(day).map_err(|err| JsValue::from_str(&err.to_string()))?;
    let tz = TimezoneName::parse(timezone).map_err(|err| JsValue::from_str(&err.to_string()))?;
    let (start, end) = day.window_ms(&tz);
    Ok(vec![start, end])
}

#[wasm_bindgen]
pub fn shift_day(day: &str, days: i64) -> Result<String, JsValue> {
    Day::parse(day)
        .map(|value| value.add(days).to_string())
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

#[wasm_bindgen]
pub fn sunday_of(day: &str) -> Result<String, JsValue> {
    Day::parse(day)
        .map(|value| value.week_start().to_string())
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

/// Convert weighed grams to the food's macro basis; returns an error rather than guessing
/// when the states disagree and no yield factor was declared.
#[wasm_bindgen]
pub fn convert_basis_grams(
    grams: f64,
    weighed_as: &str,
    basis_state: &str,
    yield_factor: f64,
) -> Result<f64, JsValue> {
    let weighed_as =
        FoodState::parse(weighed_as).map_err(|err| JsValue::from_str(&err.to_string()))?;
    let basis_state =
        FoodState::parse(basis_state).map_err(|err| JsValue::from_str(&err.to_string()))?;
    basis_grams(grams, weighed_as, basis_state, yield_factor, "wasm")
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

/// Rescale a logged portion from its immutable per-serving snapshot JSON.
#[wasm_bindgen]
pub fn rescale_snapshot_json(
    current: &str,
    per_serving: &str,
    fraction: f64,
) -> Result<String, JsValue> {
    let current: SnapshotValues =
        serde_json::from_str(current).map_err(|err| JsValue::from_str(&err.to_string()))?;
    let per_serving: SnapshotValues =
        serde_json::from_str(per_serving).map_err(|err| JsValue::from_str(&err.to_string()))?;
    serde_json::to_string(&rescale_snapshot(&current, &per_serving, fraction))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

/// Night bucketing for sleep segments after midnight.
#[wasm_bindgen]
pub fn sleep_night(day: &str, start_date: &str) -> Result<String, JsValue> {
    let day = Day::parse(day).map_err(|err| JsValue::from_str(&err.to_string()))?;
    Ok(night_of(&day, start_date).to_string())
}

#[wasm_bindgen]
pub fn best_five_k_json(workouts_json: &str, from_day: &str) -> Result<String, JsValue> {
    let rows: Vec<WorkoutRow> =
        serde_json::from_str(workouts_json).map_err(|err| JsValue::from_str(&err.to_string()))?;
    let from = Day::parse(from_day).map_err(|err| JsValue::from_str(&err.to_string()))?;
    serde_json::to_string(&five_k_best(&rows, &from))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

#[cfg(test)]
mod extra_tests {
    use super::*;

    #[test]
    fn wasm_day_and_basis_helpers_are_deterministic() {
        assert_eq!(shift_day("2026-11-17", 1).unwrap(), "2026-11-18");
        assert_eq!(sunday_of("2026-11-17").unwrap(), "2026-11-15");
        assert_eq!(
            sleep_night("2026-11-18", "2026-11-18 01:00:00 +0800").unwrap(),
            "2026-11-17"
        );
        assert_eq!(
            convert_basis_grams(150.0, "cooked", "raw", 0.75).unwrap(),
            200.0
        );
        assert_eq!(day_window("2026-11-17", "Asia/Manila").unwrap().len(), 2);
    }
}
