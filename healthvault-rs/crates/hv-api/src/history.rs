//! Explicit, hash-gated past-meal correction (same preview -> apply contract as `food-history.ts`).

use std::collections::HashMap;

use chrono::Utc;
use rusqlite::params;
use serde_json::{Map, Value, json};

use hv_core::day::Day;
use hv_core::history::{
    ChangeStatus, HistoryChange, HistoryScope, MAX_HISTORY_REFRESH_ROWS, classify, hash_changes,
};
use hv_core::nutrition::SnapshotValues;

use crate::error::ApiError;
use crate::service::Service;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Candidate {
    entry_id: i64,
    ingredient_id: Option<i64>,
    food_id: Option<i64>,
    name: String,
    day: Day,
    meal: String,
    kind: String,
    previous: SnapshotValues,
    basis_state: Option<String>,
}

fn parse_scope(input: &Map<String, Value>) -> Result<HistoryScope, ApiError> {
    let ids = |key: &str| -> Result<Vec<i64>, ApiError> {
        match input.get(key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    value
                        .as_i64()
                        .filter(|v| *v > 0)
                        .ok_or_else(|| ApiError::InvalidInput(format!("{key} must contain ids")))
                })
                .collect(),
            _ => Err(ApiError::InvalidInput(format!(
                "{key} must be an array of ids"
            ))),
        }
    };
    let day = |key: &str| -> Result<Option<Day>, ApiError> {
        match input.get(key).and_then(Value::as_str) {
            None => Ok(None),
            Some(raw) => Ok(Some(Day::parse(raw).map_err(ApiError::from)?)),
        }
    };
    HistoryScope::parse(
        &ids("foodIds")?,
        &ids("entryIds")?,
        day("fromDay")?,
        day("toDay")?,
    )
    .map_err(ApiError::from)
}

fn values_of(row: &rusqlite::Row<'_>, _prefix: &str) -> Result<SnapshotValues, rusqlite::Error> {
    Ok(SnapshotValues {
        grams: row.get("grams")?,
        raw_equivalent_grams: row.get("raw_equivalent_grams")?,
        kcal: row.get("kcal")?,
        protein_g: row.get("protein_g")?,
        carbs_g: row.get("carbs_g")?,
        fat_g: row.get("fat_g")?,
        fibre_g: row.get("fibre_g")?,
        sodium_mg: row.get("sodium_mg")?,
    })
}

fn candidates(service: &Service, scope: &HistoryScope) -> Result<Vec<Candidate>, ApiError> {
    let owned_scope = scope.clone();
    let result: Result<Vec<Candidate>, hv_storage::StorageError> = service.store.call(move |conn| {
        let mut out = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT l.id, l.food_id, l.name, l.day, l.meal, l.basis_state,
                    l.grams, l.raw_equivalent_grams, l.kcal, l.protein_g, l.carbs_g,
                    l.fat_g, l.fibre_g, l.sodium_mg
                 FROM food_log l
                 WHERE l.food_id IS NOT NULL AND l.recipe_id IS NULL AND l.recipe_serving_json IS NULL
                 ORDER BY l.day, l.eaten_at_ms")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let food_id: i64 = row.get("food_id")?;
                let entry_id: i64 = row.get("id")?;
                let day = Day::parse(&row.get::<_, String>("day")?).unwrap_or_else(|_| Day::epoch());
                if !owned_scope.matches(food_id, entry_id, &day) { continue; }
                out.push(Candidate {
                    entry_id, ingredient_id: None, food_id: Some(food_id), name: row.get("name")?, day,
                    meal: row.get("meal")?, kind: "entry".into(), previous: values_of(row, "")?,
                    basis_state: row.get("basis_state")?,
                });
            }
        }
        {
            let mut stmt = conn.prepare(
                "SELECT i.id AS ingredient_id, i.food_log_id, i.food_id, i.name, i.food_state,
                    i.grams, i.raw_equivalent_grams, i.kcal, i.protein_g, i.carbs_g,
                    i.fat_g, i.fibre_g, i.sodium_mg, l.day, l.meal
                 FROM food_log_ingredients i JOIN food_log l ON l.id = i.food_log_id
                 ORDER BY i.food_log_id, i.position, i.id")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let Some(food_id) = row.get::<_, Option<i64>>("food_id")? else { continue };
                let entry_id: i64 = row.get("food_log_id")?;
                let day = Day::parse(&row.get::<_, String>("day")?).unwrap_or_else(|_| Day::epoch());
                if !owned_scope.matches(food_id, entry_id, &day) { continue; }
                out.push(Candidate {
                    entry_id, ingredient_id: Some(row.get("ingredient_id")?), food_id: Some(food_id),
                    name: row.get("name")?, day, meal: row.get("meal")?, kind: "ingredient".into(),
                    previous: values_of(row, "")?, basis_state: row.get("food_state")?,
                });
            }
        }
        out.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.entry_id.cmp(&b.entry_id)).then(a.ingredient_id.cmp(&b.ingredient_id)));
        Ok(out)
    });
    Ok(result?)
}

fn proposed_for(
    previous: &SnapshotValues,
    food: &Option<StoredFoodView>,
) -> Option<(SnapshotValues, bool)> {
    let food = food.as_ref()?;
    let basis = previous.raw_equivalent_grams?;
    let factor = basis / 100.0;
    Some((
        SnapshotValues {
            grams: previous.grams,
            raw_equivalent_grams: Some(basis),
            kcal: food.kcal_per_100g * factor,
            protein_g: food.protein_per_100g * factor,
            carbs_g: food.carbs_per_100g * factor,
            fat_g: food.fat_per_100g * factor,
            fibre_g: food.fibre_per_100g * factor,
            sodium_mg: food.sodium_per_100g * factor,
        },
        false,
    ))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredFoodView {
    kcal_per_100g: f64,
    protein_per_100g: f64,
    carbs_per_100g: f64,
    fat_per_100g: f64,
    fibre_per_100g: f64,
    sodium_per_100g: f64,
    state: String,
}

fn build_changes(
    service: &Service,
    scope: &HistoryScope,
) -> Result<(Vec<HistoryChange>, Vec<(HistoryChange, SnapshotValues)>), ApiError> {
    let rows = candidates(service, scope)?;
    if rows.len() > MAX_HISTORY_REFRESH_ROWS {
        return Err(ApiError::InvalidInput(format!(
            "scope matches {} snapshots; narrow foodIds/entryIds or the day range to at most {}",
            rows.len(),
            MAX_HISTORY_REFRESH_ROWS
        )));
    }
    let mut foods: HashMap<i64, Option<StoredFoodView>> = HashMap::new();
    for row in &rows {
        let id = row.food_id.unwrap_or(0);
        if foods.contains_key(&id) {
            continue;
        }
        let food = service.store.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
                fibre_per_100g, sodium_per_100g, state FROM foods WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => Ok(Some(StoredFoodView {
                    kcal_per_100g: row.get(0)?,
                    protein_per_100g: row.get(1)?,
                    carbs_per_100g: row.get(2)?,
                    fat_per_100g: row.get(3)?,
                    fibre_per_100g: row.get(4)?,
                    sodium_per_100g: row.get(5)?,
                    state: row.get(6)?,
                })),
                None => Ok(None),
            }
        })?;
        foods.insert(id, food);
    }
    let mut changes = Vec::new();
    let mut writes = Vec::new();
    for row in rows {
        let food = foods.get(&row.food_id.unwrap_or(0)).cloned().flatten();
        let basis_known = row.previous.raw_equivalent_grams.is_some() && row.basis_state.is_some();
        let basis_changed = food.as_ref().is_some_and(|f| {
            row.basis_state
                .as_deref()
                .is_some_and(|state| state != f.state)
        });
        let proposed = proposed_for(&row.previous, &food);
        let status = if proposed.is_none() && basis_known && !basis_changed {
            ChangeStatus::Skipped
        } else if let Some((proposed, _)) = &proposed {
            classify(&row.previous, proposed, basis_known, basis_changed)
        } else {
            ChangeStatus::Skipped
        };
        let reason = if !basis_known {
            Some("missing basis metadata".to_owned())
        } else if basis_changed {
            Some("food basis state changed".to_owned())
        } else if food.is_none() {
            Some("food no longer exists".to_owned())
        } else {
            None
        };
        let change = HistoryChange {
            kind: row.kind.clone(),
            entry_id: row.entry_id,
            ingredient_id: row.ingredient_id,
            food_id: row.food_id,
            name: row.name,
            day: row.day,
            meal: row.meal,
            status,
            reason,
            previous: Some(row.previous),
            proposed: proposed.map(|(values, _)| values),
        };
        if change.status == ChangeStatus::Changed
            && let Some(previous) = &change.previous
            && let Some((values, _)) = proposed_for(previous, &food)
        {
            writes.push((change.clone(), values));
        }
        changes.push(change);
    }
    Ok((changes, writes))
}

pub(crate) fn preview(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let scope = parse_scope(input)?;
    let (changes, _) = build_changes(service, &scope)?;
    let changed = changes
        .iter()
        .filter(|c| c.status == ChangeStatus::Changed)
        .count();
    let unchanged = changes
        .iter()
        .filter(|c| c.status == ChangeStatus::Unchanged)
        .count();
    let skipped = changes
        .iter()
        .filter(|c| c.status == ChangeStatus::Skipped)
        .count();
    let mut reasons: HashMap<String, i64> = HashMap::new();
    for change in &changes {
        if let Some(reason) = &change.reason {
            *reasons.entry(reason.clone()).or_default() += 1;
        }
    }
    let hash = hash_changes(&scope, &changes);
    Ok(json!({
        "scope": {
            "foodIds": scope.food_ids, "entryIds": scope.entry_ids,
            "fromDay": scope.from_day.map(|d| d.to_string()), "toDay": scope.to_day.map(|d| d.to_string())
        },
        "previewHash": hash, "changed": changed, "unchanged": unchanged, "skipped": skipped,
        "skippedReasons": reasons, "changes": changes
    }))
}

pub(crate) fn apply(service: &Service, input: &Map<String, Value>) -> Result<Value, ApiError> {
    let hash = input
        .get("previewHash")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidInput("previewHash is required".into()))?;
    let scope = parse_scope(input)?;
    let (changes, writes) = build_changes(service, &scope)?;
    if hash_changes(&scope, &changes) != hash {
        return Err(ApiError::Conflict(
            "history preview is stale: the food or scope changed since it was generated; run food_history_preview again".into(),
        ));
    }
    let now = Utc::now().timestamp_millis();
    let applied = writes.len();
    let entries_touched = writes
        .iter()
        .map(|(change, _)| change.entry_id)
        .collect::<std::collections::HashSet<_>>()
        .len();
    let write_clone = writes.clone();
    service.store.call(move |conn| {
        let tx = conn.transaction()?;
        for (change, proposed) in &write_clone {
            let values_json = |values: &SnapshotValues| -> String {
                serde_json::to_string(&json!({
                    "grams": values.grams, "rawEquivalentGrams": values.raw_equivalent_grams,
                    "kcal": values.kcal, "proteinG": values.protein_g, "carbsG": values.carbs_g,
                    "fatG": values.fat_g, "fibreG": values.fibre_g, "sodiumMg": values.sodium_mg
                })).unwrap_or_default()
            };
            let (table, id_field, id) = if change.kind == "ingredient" {
                ("food_log_ingredients", "id", change.ingredient_id.unwrap_or(0))
            } else {
                ("food_log", "id", change.entry_id)
            };
            // Table names are hard-coded allowlist values, never user input.
            let sql = format!("UPDATE {table} SET grams = ?1, kcal = ?2, protein_g = ?3, carbs_g = ?4,
                fat_g = ?5, fibre_g = ?6, sodium_mg = ?7 WHERE {id_field} = ?8");
            tx.execute(&sql, params![proposed.grams, proposed.kcal, proposed.protein_g, proposed.carbs_g,
                proposed.fat_g, proposed.fibre_g, proposed.sodium_mg, id])?;
            tx.execute("INSERT INTO food_log_revisions (food_log_id, food_log_ingredient_id, food_id, reason,
                previous_json, new_json, created_at_ms) VALUES (?1, ?2, ?3, 'history_refresh', ?4, ?5, ?6)",
                params![change.entry_id, change.ingredient_id, change.food_id,
                    change.previous.as_ref().map(values_json).unwrap_or_default(), values_json(proposed), now])?;
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(json!({
        "applied": applied,
        "entriesTouched": entries_touched,
        "revisions": writes.len(),
        "skipped": changes.iter().filter(|c| c.status == ChangeStatus::Skipped).count(),
        "previewHash": hash
    }))
}

#[cfg(test)]
fn json_map(
    entries: impl IntoIterator<Item = (String, serde_json::Value)>,
) -> serde_json::Map<String, serde_json::Value> {
    entries.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::Service;
    use hv_storage::StoreHandle;

    fn service() -> Service {
        let service = Service::new(StoreHandle::in_memory().unwrap());
        service
            .food_add(&json_map([
                ("name".into(), json!("Egg")),
                ("kcal".into(), json!(100.0)),
            ]))
            .unwrap();
        let foods = service
            .food_search(&json_map([("query".into(), json!("Egg"))]))
            .unwrap();
        let id = foods[0]["id"].as_i64().unwrap();
        service
            .meal_log(&json_map([
                ("day".into(), json!("2026-11-17")),
                ("meal".into(), json!("breakfast")),
                ("entries".into(), json!([{ "foodId": id, "grams": 100 }])),
            ]))
            .unwrap();
        service
    }

    #[test]
    fn preview_hash_is_required_for_apply() {
        let service = service();
        assert!(service.history_refresh(&Map::new()).is_err());
    }

    #[test]
    fn stale_preview_hash_is_rejected() {
        let service = service();
        let preview = service
            .history_preview(&json_map([("foodIds".into(), json!([1]))]))
            .unwrap();
        let mut input = json_map([
            ("foodIds".into(), json!([1])),
            ("previewHash".into(), json!("deadbeef")),
        ]);
        input.insert("previewHash".into(), json!("0".repeat(64)));
        assert!(matches!(
            service.history_refresh(&input),
            Err(ApiError::Conflict(_))
        ));
        assert_ne!(preview["previewHash"].as_str().unwrap(), "");
    }
}
