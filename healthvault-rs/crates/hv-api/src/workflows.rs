//! Domain workflows used by the native UI but deliberately outside the frozen 38-tool agent
//! contract: whey one-tap/undo, manual strength sets, and planned-session status.

use chrono::Utc;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use hv_core::day::Day;
use hv_core::nutrition::Meal;

use crate::error::ApiError;
use crate::service::Service;

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
        .is_ok()
    {
        return hex::encode(bytes);
    }
    format!(
        "{:032x}",
        Utc::now().timestamp_nanos_opt().unwrap_or(0) as u128
    )
}

#[derive(Debug, Clone)]
struct WheyLink {
    food_id: i64,
    supplement_id: Option<i64>,
    grams: f64,
    meal: Meal,
}

fn whey_link(service: &Service) -> Result<WheyLink, ApiError> {
    let raw: Option<String> = service.store.call(|conn| {
        Ok(conn
            .query_row(
                "SELECT whey_link_json FROM profile WHERE id = 1",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    })?;
    let value: Value = serde_json::from_str(&raw.unwrap_or_default()).unwrap_or(Value::Null);
    let food_id = value.get("foodId").and_then(Value::as_i64).ok_or_else(|| {
        ApiError::Conflict("one-tap whey is not configured — choose a saved whey food first".into())
    })?;
    let supplement_id = value.get("supplementId").and_then(Value::as_i64);
    let grams = value.get("grams").and_then(Value::as_f64).unwrap_or(32.4);
    let meal = Meal::parse(value.get("meal").and_then(Value::as_str).unwrap_or("snack"))
        .map_err(ApiError::from)?;
    let exists: bool = service.store.call(move |conn| {
        Ok(conn
            .query_row(
                "SELECT 1 FROM foods WHERE id = ?1",
                params![food_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    })?;
    if !exists {
        return Err(ApiError::Conflict(
            "whey link points at a food that no longer exists".into(),
        ));
    }
    Ok(WheyLink {
        food_id,
        supplement_id,
        grams,
        meal,
    })
}

pub fn whey_status(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let day = match input.get("day").and_then(Value::as_str) {
        Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
        None => service.today()?,
    };
    let configured = whey_link(service).is_ok();
    let day_string = day.to_string();
    let logged: bool = service.store.call(move |conn| {
        Ok(conn
            .query_row(
                "SELECT 1 FROM food_log WHERE whey_action_day = ?1",
                params![day_string],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    })?;
    Ok(json!({ "day": day.to_string(), "configured": configured, "logged": logged }))
}

/// Log the configured serving exactly once, with an immutable association for Undo.
pub fn whey_log(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let day = match input.get("day").and_then(Value::as_str) {
        Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
        None => service.today()?,
    };
    let day_string = day.to_string();
    let existing: bool = service.store.call({
        let day = day_string.clone();
        move |conn| {
            Ok(conn
                .query_row(
                    "SELECT 1 FROM food_log WHERE whey_action_day = ?1",
                    params![day],
                    |_| Ok(()),
                )
                .optional()?
                .is_some())
        }
    })?;
    if existing {
        return Err(ApiError::Conflict(
            "whey is already logged for this day — undo it first".into(),
        ));
    }
    let link = whey_link(service)?;
    let mut entry = Map::new();
    entry.insert("foodId".into(), json!(link.food_id));
    entry.insert("grams".into(), json!(link.grams));
    entry.insert("weightSource".into(), json!("counted"));
    entry.insert("estimated".into(), json!(false));
    let computed = service.compute_entry(&entry)?;
    let action_id = random_id();
    let now = Utc::now().timestamp_millis();
    let tz = service.timezone()?;
    let eaten_ms = match input.get("eatenAt") {
        Some(Value::String(raw)) => day
            .time_ms(raw.get(11..19).unwrap_or(raw), &tz)
            .map_err(ApiError::from)?,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(now),
        _ => day.time_ms("12:00", &tz).map_err(ApiError::from)?,
    };

    let result = service.store.call(move |conn| {
        let tx = conn.transaction()?;
        let previous_supplement: Option<String> = match link.supplement_id {
            Some(supplement_id) => tx
                .query_row(
                    "SELECT id, supplement_id, day, taken_at_ms, dose, unit, note, created_at_ms
                     FROM supplement_logs WHERE supplement_id = ?1 AND day = ?2",
                    params![supplement_id, day_string],
                    |row| Ok(json!({
                        "id": row.get::<_, i64>(0)?, "supplementId": row.get::<_, i64>(1)?,
                        "day": row.get::<_, String>(2)?, "takenAtMs": row.get::<_, i64>(3)?,
                        "dose": row.get::<_, f64>(4)?, "unit": row.get::<_, String>(5)?,
                        "note": row.get::<_, Option<String>>(6)?, "createdAtMs": row.get::<_, i64>(7)?,
                    }).to_string()),
                )
                .optional()?,
            None => None,
        };
        let entry_id: i64 = tx.query_row(
            "INSERT INTO food_log (day, meal, eaten_at_ms, food_id, name, grams, kcal, protein_g,
                carbs_g, fat_g, fibre_g, sodium_mg, estimated, weight_source, macro_source, grams_as,
                raw_equivalent_grams, basis_state, basis_yield_factor, whey_action_day,
                created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?19, ?20, ?21, ?21) RETURNING id",
            params![day_string, link.meal.as_str(), eaten_ms, link.food_id, computed.name,
                computed.grams, computed.macros.kcal, computed.macros.protein_g, computed.macros.carbs_g,
                computed.macros.fat_g, computed.macros.fibre_g, computed.macros.sodium_mg, 0,
                "counted", computed.macro_source.as_str(), computed.weighed_as.as_str(), computed.basis,
                computed.basis_state.as_str(), computed.yield_factor, day_string, now],
            |row| row.get(0),
        )?;
        let mut supplement_log_id = None;
        if let Some(supplement_id) = link.supplement_id {
            tx.execute(
                "INSERT INTO supplement_logs (supplement_id, day, taken_at_ms, dose, unit, created_at_ms, whey_action_id)
                 VALUES (?1, ?2, ?3, 1, 'capsule', ?4, ?5)
                 ON CONFLICT(supplement_id, day) DO UPDATE SET taken_at_ms = excluded.taken_at_ms,
                   whey_action_id = excluded.whey_action_id",
                params![supplement_id, day_string, eaten_ms, now, action_id],
            )?;
            supplement_log_id = tx.query_row(
                "SELECT id FROM supplement_logs WHERE supplement_id = ?1 AND day = ?2",
                params![supplement_id, day_string], |row| row.get::<_, i64>(0)).optional()?;
        }
        let action = json!({
            "version": 1, "id": action_id, "supplementId": link.supplement_id,
            "supplementLogId": supplement_log_id,
            "previousSupplementLog": previous_supplement.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
        });
        tx.execute("UPDATE food_log SET whey_action_json = ?1 WHERE id = ?2",
            params![action.to_string(), entry_id])?;
        tx.commit()?;
        Ok(json!({ "entryId": entry_id, "day": day_string, "supplementId": link.supplement_id }))
    })?;
    Ok(result)
}

/// Undo removes only the rows recorded by the action; a later manual supplement edit is kept.
pub fn whey_undo(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let day = match input.get("day").and_then(Value::as_str) {
        Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
        None => service.today()?,
    };
    let day_string = day.to_string();
    let action: Option<(i64, String)> = service.store.call({
        let day = day_string.clone();
        move |conn| {
            Ok(conn
                .query_row(
                    "SELECT id, whey_action_json FROM food_log WHERE whey_action_day = ?1",
                    params![day],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?)
        }
    })?;
    let Some((entry_id, raw)) = action else {
        return Ok(json!({ "undone": false, "day": day.to_string(), "supplementId": Value::Null }));
    };
    let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let action_id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let supplement_id = value.get("supplementId").and_then(Value::as_i64);
    let supplement_log_id = value.get("supplementLogId").and_then(Value::as_i64);
    let previous = value
        .get("previousSupplementLog")
        .cloned()
        .filter(|v| !v.is_null());

    service.store.call(move |conn| {
        let tx = conn.transaction()?;
        if let (Some(log_id), Some(supplement_id)) = (supplement_log_id, supplement_id) {
            let owned = tx.query_row("SELECT whey_action_id FROM supplement_logs WHERE id = ?1",
                params![log_id], |row| row.get::<_, Option<String>>(0)).optional()?.flatten();
            if owned.as_deref() == Some(&action_id) {
                if let Some(previous) = &previous {
                    tx.execute("UPDATE supplement_logs SET supplement_id = ?1, day = ?2, taken_at_ms = ?3,
                        dose = ?4, unit = ?5, note = ?6, created_at_ms = ?7, whey_action_id = NULL WHERE id = ?8",
                        params![supplement_id,
                            previous.get("day").and_then(Value::as_str).unwrap_or("1970-01-01"),
                            previous.get("takenAtMs").and_then(Value::as_i64).unwrap_or(0),
                            previous.get("dose").and_then(Value::as_f64).unwrap_or(1.0),
                            previous.get("unit").and_then(Value::as_str).unwrap_or("capsule"),
                            previous.get("note").and_then(Value::as_str),
                            previous.get("createdAtMs").and_then(Value::as_i64).unwrap_or(0), log_id])?;
                } else {
                    tx.execute("DELETE FROM supplement_logs WHERE id = ?1", params![log_id])?;
                }
            }
        }
        tx.execute("DELETE FROM food_log_revisions WHERE food_log_id = ?1", params![entry_id])?;
        tx.execute("DELETE FROM food_log WHERE id = ?1", params![entry_id])?;
        tx.commit()?;
        Ok(())
    })?;
    Ok(json!({ "undone": true, "day": day.to_string(), "supplementId": supplement_id }))
}

/// Append sets for one exercise. Detail only: never changes imported workout volume or calories.
pub fn strength_add(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let day = match input.get("day").and_then(Value::as_str) {
        Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
        None => service.today()?,
    };
    let exercise = input
        .get("exercise")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 120)
        .ok_or_else(|| ApiError::InvalidInput("exercise is required (max 120 characters)".into()))?
        .to_owned();
    let sets = input
        .get("sets")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty() && rows.len() <= 100)
        .ok_or_else(|| {
            ApiError::InvalidInput("sets must be a non-empty array of at most 100 rows".into())
        })?;
    let mut values = Vec::new();
    for (index, row) in sets.iter().enumerate() {
        let object = row
            .as_object()
            .ok_or_else(|| ApiError::InvalidInput(format!("sets[{index}] must be an object")))?;
        let reps = object
            .get("reps")
            .and_then(Value::as_f64)
            .filter(|value| (0.0..=1000.0).contains(value));
        let load_kg = object
            .get("loadKg")
            .and_then(Value::as_f64)
            .filter(|value| (0.0..=1000.0).contains(value));
        if reps.is_none() && load_kg.is_none() {
            return Err(ApiError::InvalidInput(format!(
                "set {} needs reps or loadKg",
                index + 1
            )));
        }
        values.push((reps, load_kg));
    }
    let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
    let workout_id = input.get("workoutId").and_then(Value::as_i64);
    let now = Utc::now().timestamp_millis();
    let day_string = day.to_string();
    let response_exercise = exercise.clone();
    let ids: Vec<i64> = service.store.call(move |conn| {
        let tx = conn.transaction()?;
        let start: i64 = tx.query_row(
            "SELECT COALESCE(MAX(set_no), 0) FROM strength_sets WHERE day = ?1 AND exercise = ?2",
            params![day_string, exercise], |row| row.get(0))?;
        let mut ids = Vec::new();
        for (index, (reps, load_kg)) in values.into_iter().enumerate() {
            ids.push(tx.query_row(
                "INSERT INTO strength_sets (day, exercise, set_no, reps, load_kg, note, workout_id, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id",
                params![day_string, exercise, start + index as i64 + 1, reps, load_kg, note, workout_id, now],
                |row| row.get::<_, i64>(0))?);
        }
        tx.commit()?;
        Ok(ids)
    })?;
    Ok(json!({ "day": day.to_string(), "exercise": response_exercise, "ids": ids }))
}

pub fn strength_sessions(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let days = input
        .get("days")
        .and_then(Value::as_i64)
        .unwrap_or(14)
        .clamp(1, 366);
    let from = service.today()?.add(-days).to_string();
    let rows: Vec<Value> = service.store.call(move |conn| {
        hv_storage::query_rows(conn,
            "SELECT id, day, exercise, set_no AS setNo, reps, load_kg AS loadKg, workout_id AS workoutId
             FROM strength_sets WHERE day >= ?1 ORDER BY day DESC, exercise, set_no",
            params![from], &["id", "day", "exercise", "setNo", "reps", "loadKg", "workoutId"])
    })?;
    let mut by_day: std::collections::BTreeMap<String, Vec<Value>> =
        std::collections::BTreeMap::new();
    for row in rows {
        let day = row["day"].as_str().unwrap_or("").to_owned();
        by_day.entry(day).or_default().push(row);
    }
    let sessions: Vec<Value> = by_day
        .into_iter()
        .map(|(day, sets)| json!({ "day": day, "sets": sets }))
        .collect();
    Ok(json!(sessions))
}

/// Simplified 16-week block: three sessions per week with the same intent vocabulary as the app.
pub fn training_plan_state(service: &Service) -> Result<Value, ApiError> {
    let rows: Vec<Value> = service.store.call(|conn| {
        hv_storage::query_rows(conn,
            "SELECT id, day, kind, intent, title, target_json AS targetJson, status, block_start AS blockStart, week_no AS weekNo
             FROM planned_sessions ORDER BY day, id",
            [], &["id", "day", "kind", "intent", "title", "targetJson", "status", "blockStart", "weekNo"])
    })?;
    Ok(json!({ "sessions": rows, "count": rows.len() }))
}

pub fn training_plan_start(
    service: &Service,
    input: &Map<String, Value>,
) -> Result<Value, ApiError> {
    let start = match input.get("startDate").and_then(Value::as_str) {
        Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
        None => service.today()?.add(1),
    };
    let now = Utc::now().timestamp_millis();
    let mut session_days = Vec::new();
    for week in 0..16 {
        let monday = start.add(week * 7);
        let plan = if week < 4 {
            [
                ("easy", "Easy run", "{\"structure\":\"30–40 min easy\"}"),
                ("easy", "Easy run", "{\"structure\":\"30–40 min easy\"}"),
                ("easy", "Long easy", "{\"structure\":\"45–60 min easy\"}"),
            ]
        } else if week < 8 {
            [
                ("easy", "Easy run", "{\"structure\":\"35 min easy\"}"),
                (
                    "quality",
                    "Quality: 6 × 2 min",
                    "{\"structure\":\"6 × 2 min comfortably hard\"}",
                ),
                ("easy", "Long easy", "{\"structure\":\"45–60 min easy\"}"),
            ]
        } else if week < 15 {
            [
                ("easy", "Easy run", "{\"structure\":\"35 min easy\"}"),
                (
                    "quality",
                    "Progressive run",
                    "{\"structure\":\"6 × 3 min comfortably hard\"}",
                ),
                ("easy", "Long easy", "{\"structure\":\"45–60 min easy\"}"),
            ]
        } else {
            [
                ("easy", "Easy run", "{\"structure\":\"20–25 min easy\"}"),
                ("easy", "Easy run", "{\"structure\":\"15–20 min easy\"}"),
                (
                    "test",
                    "5K test",
                    "{\"structure\":\"5K time trial\",\"distanceKm\":5,\"paceMinPerKm\":6}",
                ),
            ]
        };
        for (offset, (intent, title, target)) in [(0, plan[0]), (2, plan[1]), (5, plan[2])] {
            session_days.push((
                monday.add(offset).to_string(),
                intent.to_owned(),
                title.to_owned(),
                target.to_owned(),
                week + 1,
            ));
        }
    }
    let block_start = start.to_string();
    let response_block = block_start.clone();
    let include_strength = input
        .get("includeStrength")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    service.store.call(move |conn| {
        let tx = conn.transaction()?;
        for (day, intent, title, target, week_no) in session_days {
            let kind = if title.contains("5K") { "test" } else { "run" };
            tx.execute(
                "INSERT INTO planned_sessions (day, kind, intent, title, target_json, status,
                block_start, week_no, created_at_ms, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5, 'planned', ?6, ?7, ?8, ?8)",
                params![day, kind, intent, title, target, block_start, week_no, now],
            )?;
            if include_strength && intent == "easy" {
                tx.execute(
                    "INSERT INTO planned_sessions (day, kind, intent, title, status,
                    block_start, week_no, created_at_ms, updated_at_ms)
                    VALUES (?1, 'strength', 'strength', 'Strength', 'planned', ?2, ?3, ?4, ?4)",
                    params![day, block_start, week_no, now],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(json!({ "blockStart": response_block, "sessions": 48 }))
}

pub fn session_status(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let id = input
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::InvalidInput("id is required".into()))?;
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .filter(|value| ["planned", "done", "skipped"].contains(value))
        .ok_or_else(|| ApiError::InvalidInput("status must be planned, done or skipped".into()))?;
    let now = Utc::now().timestamp_millis();
    service.exec(
        "UPDATE planned_sessions SET status = ?1, updated_at_ms = ?2 WHERE id = ?3",
        vec![
            rusqlite::types::Value::Text(status.into()),
            rusqlite::types::Value::Integer(now),
            rusqlite::types::Value::Integer(id),
        ],
    )?;
    Ok(json!({ "id": id, "status": status }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hv_storage::StoreHandle;

    fn service() -> Service {
        Service::new(StoreHandle::in_memory().unwrap())
    }

    #[test]
    fn whey_log_is_once_and_undo_restores_the_day() {
        let service = service();
        let mut profile = Map::new();
        profile.insert(
            "wheyLink".into(),
            json!({"foodId": 0, "supplementId": null, "grams": 30, "meal": "snack"}),
        );
        // Use a real food id instead of 0.
        service
            .food_add(&json_map([
                ("name".into(), json!("Whey")),
                ("kcal".into(), json!(400.0)),
            ]))
            .unwrap();
        let foods = service.food_search(&Map::new()).unwrap();
        let id = foods[0]["id"].as_i64().unwrap();
        profile.insert(
            "wheyLink".into(),
            json!({"foodId": id, "supplementId": null, "grams": 30, "meal": "snack"}),
        );
        service.profile_update(&profile).unwrap();
        assert_eq!(
            whey_status(&service, &Map::new()).unwrap()["configured"],
            true
        );
        let logged = whey_log(&service, &Map::new()).unwrap();
        assert!(logged["entryId"].as_i64().is_some());
        assert!(whey_log(&service, &Map::new()).is_err());
        let undone = whey_undo(&service, &Map::new()).unwrap();
        assert_eq!(undone["undone"], true);
        assert_eq!(whey_status(&service, &Map::new()).unwrap()["logged"], false);
    }

    #[test]
    fn strength_sets_continue_numbering_within_a_day() {
        let service = service();
        let input = json_map([
            ("day".into(), json!("2026-11-17")),
            ("exercise".into(), json!("Bench")),
            ("sets".into(), json!([{"reps": 8, "loadKg": 60}])),
        ]);
        strength_add(&service, &input).unwrap();
        strength_add(&service, &input).unwrap();
        let sessions = strength_sessions(&service, &Map::new()).unwrap();
        let sets = sessions[0]["sets"].as_array().unwrap();
        assert_eq!(sets.len(), 2);
        assert_eq!(sets[1]["setNo"], 2);
    }

    fn json_map(entries: impl IntoIterator<Item = (String, Value)>) -> Map<String, Value> {
        entries.into_iter().collect()
    }
}
