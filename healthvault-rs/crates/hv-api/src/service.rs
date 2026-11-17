//! Command/query handlers over the shared store. Domain rules come from `hv_core`; this
//! module validates boundary inputs, executes SQL and maps rows to the wire shape.

use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use hv_core::day::{Day, last_days};
use hv_core::macros::Macros;
use hv_core::nutrition::{FoodState, MacroSource, Meal, basis_grams, resolve_measure_grams};
use hv_core::workouts::{
    SeriesAggregation, WorkoutRow, daily_series_single_source, reconcile_workouts,
};
use hv_storage::{StoreHandle, query_rows, scalar_i64};

use crate::error::ApiError;

#[derive(Clone)]
pub struct Service {
    pub store: StoreHandle,
}

impl std::fmt::Debug for Service {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Service")
    }
}

impl Service {
    pub fn new(store: StoreHandle) -> Self {
        Self { store }
    }

    pub fn timezone(&self) -> Result<hv_core::TimezoneName, ApiError> {
        let raw: Option<String> = self.store.call(|conn| {
            Ok(conn
                .query_row("SELECT timezone FROM profile WHERE id = 1", [], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?)
        })?;
        hv_core::TimezoneName::parse(raw.as_deref().unwrap_or(hv_core::DEFAULT_TIMEZONE))
            .map_err(ApiError::from)
    }

    pub fn today(&self) -> Result<Day, ApiError> {
        Ok(hv_core::day::local_day(
            Utc::now().timestamp_millis(),
            &self.timezone()?,
        ))
    }

    /// Execute with owned bind values so the closure satisfies `Send + 'static`.
    pub(crate) fn exec(
        &self,
        sql: impl Into<String>,
        values: Vec<rusqlite::types::Value>,
    ) -> Result<usize, ApiError> {
        let sql = sql.into();
        Ok(self
            .store
            .call(move |conn| Ok(conn.execute(&sql, rusqlite::params_from_iter(values))?))?)
    }

    // ---------------------------------------------------------------- profile / measurements

    pub fn profile_get(&self) -> Result<Value, ApiError> {
        let row: Option<Value> = self.store.call(|conn| {
            let mut stmt = conn.prepare("SELECT * FROM profile WHERE id = 1")?;
            let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
            let mut rows = stmt.query([])?;
            match rows.next()? {
                Some(row) => {
                    let mut map = Map::new();
                    for (ix, name) in names.iter().enumerate() {
                        map.insert(camel(name), cell_value(row.get_ref(ix)?));
                    }
                    Ok(Some(Value::Object(map)))
                }
                None => Ok(None),
            }
        })?;
        Ok(row
            .unwrap_or_else(|| json!({ "timezone": hv_core::DEFAULT_TIMEZONE, "units": "metric" })))
    }

    pub fn profile_update(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let mut fields = vec![
            ("name", "name"),
            ("birthDate", "birth_date"),
            ("sex", "sex"),
            ("heightCm", "height_cm"),
            ("timezone", "timezone"),
            ("units", "units"),
            ("workSchedule", "work_schedule_json"),
            ("goalWeightKg", "goal_weight_kg"),
            ("goalsNote", "goals_note"),
            ("dietNote", "diet_note"),
            ("activityNote", "activity_note"),
            ("goal", "goal_json"),
            ("wheyLink", "whey_link_json"),
        ];
        fields.retain(|(wire, _)| input.contains_key(*wire));
        if let Some(value) = input.get("timezone").and_then(Value::as_str) {
            hv_core::TimezoneName::parse(value).map_err(ApiError::from)?;
        }
        if let Some(value) = input.get("birthDate").and_then(Value::as_str) {
            Day::parse(value).map_err(ApiError::from)?;
        }
        let now = Utc::now().timestamp_millis();
        let owned: Vec<(String, String)> = fields
            .into_iter()
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
            .collect();
        let wire_map = input.clone();
        self.store.call(move |conn| {
            conn.execute("INSERT OR IGNORE INTO profile (id, timezone, units, created_at_ms, updated_at_ms) VALUES (1, ?1, 'metric', ?2, ?2)",
                params![hv_core::DEFAULT_TIMEZONE, now])?;
            if !owned.is_empty() {
                let assignments: Vec<String> = owned.iter().map(|(_, column)| format!("{column} = ?")).collect();
                let sql = format!("UPDATE profile SET {}, updated_at_ms = ? WHERE id = 1", assignments.join(", "));
                let mut values: Vec<rusqlite::types::Value> = owned.iter()
                    .map(|(wire, _)| to_sql(wire_map.get(wire))).collect();
                values.push(rusqlite::types::Value::Integer(now));
                conn.execute(&sql, rusqlite::params_from_iter(values))?;
            }
            Ok(())
        })?;
        self.profile_get()
    }

    pub fn measurement_add(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let kind = require_str(input, "kind")?.to_owned();
        if !["weight", "bodyFat", "waist"].contains(&kind.as_str()) {
            return Err(ApiError::InvalidInput("unknown measurement kind".into()));
        }
        let value = require_f64(input, "value")?;
        let unit = str_or(
            input,
            "unit",
            if kind == "weight" {
                "kg"
            } else if kind == "bodyFat" {
                "%"
            } else {
                "cm"
            },
        )
        .to_owned();
        let tz = self.timezone()?;
        let day = match input.get("day").and_then(Value::as_str) {
            Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
            None => self.today()?,
        };
        let taken_ms = match input.get("takenAt") {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(Utc::now().timestamp_millis()),
            Some(Value::String(s)) => parse_eaten_at(s, &day, &tz)?,
            _ => {
                let clock = input.get("time").and_then(Value::as_str).unwrap_or("12:00");
                day.time_ms(clock, &tz).map_err(ApiError::from)?
            }
        };
        let actual_day = hv_core::day::local_day(taken_ms, &tz);
        let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
        let response_kind = kind.clone();
        let response_unit = unit.clone();
        let id: i64 = self.store.call(move |conn| {
            Ok(conn.query_row(
                "INSERT INTO measurements (day, taken_at_ms, kind, value, unit, note, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
                params![actual_day.to_string(), taken_ms, kind, value, unit, note, Utc::now().timestamp_millis()],
                |row| row.get(0),
            )?)
        })?;
        Ok(
            json!({ "id": id, "day": actual_day.to_string(), "kind": response_kind, "value": value, "unit": response_unit }),
        )
    }

    pub fn measurement_history(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let kind = str_or(input, "kind", "weight").to_owned();
        let days = clamp_i64(input.get("days"), 365, 1, 3650);
        let from = self.today()?.add(-days).to_string();
        let rows: Vec<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT day, taken_at_ms AS takenAtMs, value, unit, note FROM measurements
                              WHERE kind = ?1 AND day >= ?2 ORDER BY taken_at_ms",
                params![kind, from],
                &["day", "takenAtMs", "value", "unit", "note"],
            )
        })?;
        Ok(json!(rows))
    }

    pub fn measurement_delete(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let changed = self.exec(
            "DELETE FROM measurements WHERE id = ?1",
            vec![rusqlite::types::Value::Integer(id)],
        )?;
        Ok(json!({ "deleted": changed > 0 }))
    }

    // ---------------------------------------------------------------- foods / templates

    pub fn food_search(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let pattern = format!("%{}%", str_or(input, "query", "").to_ascii_lowercase());
        let limit = clamp_i64(input.get("limit"), 20, 1, 100);
        let rows: Vec<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT id, name, brand, serving_grams AS servingGrams,
                    kcal_per_100g AS kcalPer100g, protein_per_100g AS proteinPer100g,
                    carbs_per_100g AS carbsPer100g, fat_per_100g AS fatPer100g,
                    fibre_per_100g AS fibrePer100g, sodium_per_100g AS sodiumMg,
                    state, yield_factor AS yieldFactor, measures_json AS measuresJson,
                    source, source_url AS sourceUrl, source_date AS sourceDate
                  FROM foods WHERE lower(name) LIKE ?1 OR lower(COALESCE(brand, '')) LIKE ?1
                  ORDER BY name LIMIT ?2",
                params![pattern, limit],
                &[
                    "id",
                    "name",
                    "brand",
                    "servingGrams",
                    "kcalPer100g",
                    "proteinPer100g",
                    "carbsPer100g",
                    "fatPer100g",
                    "fibrePer100g",
                    "sodiumMg",
                    "state",
                    "yieldFactor",
                    "measuresJson",
                    "source",
                    "sourceUrl",
                    "sourceDate",
                ],
            )
        })?;
        Ok(json!(rows))
    }

    pub fn food_add(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let name = require_str(input, "name")?.to_owned();
        let per100 = input.get("per100g").and_then(Value::as_object);
        let macros_value = per100.unwrap_or(input);
        let kcal = require_f64(macros_value, "kcal")?;
        let field =
            |key: &str| -> f64 { macros_value.get(key).and_then(Value::as_f64).unwrap_or(0.0) };
        let brand = input
            .get("brand")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let source = str_or(input, "source", "manual").to_owned();
        let state = str_or(input, "state", "raw").to_owned();
        FoodState::parse(&state).map_err(ApiError::from)?;
        let measures = input
            .get("measures")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let source_url = input
            .get("sourceUrl")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let source_date = input
            .get("sourceDate")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let yield_factor = input
            .get("yieldFactor")
            .and_then(Value::as_f64)
            .unwrap_or(1.0);
        let protein = field("proteinG");
        let carbs = field("carbsG");
        let fat = field("fatG");
        let fibre = field("fibreG");
        let sodium = field("sodiumMg");
        let now = Utc::now().timestamp_millis();
        let id: i64 = self.store.call(move |conn| {
            Ok(conn.query_row(
                "INSERT INTO foods (name, brand, serving_grams, kcal_per_100g, protein_per_100g,
                    carbs_per_100g, fat_per_100g, fibre_per_100g, sodium_per_100g, state,
                    yield_factor, measures_json, source, source_url, source_date, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 100, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15) RETURNING id",
                params![name, brand, kcal, protein, carbs, fat, fibre, sodium, state,
                    yield_factor, measures, source, source_url, source_date, now], |row| row.get(0),
            )?)
        })?;
        Ok(json!({ "id": id }))
    }

    pub fn food_delete(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let referenced: i64 = self.store.call(move |conn| {
            scalar_i64(
                conn,
                "SELECT (SELECT COUNT(*) FROM food_log WHERE food_id = ?1) +
                (SELECT COUNT(*) FROM recipe_ingredients WHERE food_id = ?1)",
                params![id],
            )
        })?;
        if referenced > 0 {
            return Err(ApiError::Conflict(
                "food is referenced by history; keep it for provenance".into(),
            ));
        }
        let changed = self.exec(
            "DELETE FROM foods WHERE id = ?1",
            vec![rusqlite::types::Value::Integer(id)],
        )?;
        Ok(json!({ "deleted": changed > 0 }))
    }

    pub fn food_template_list(&self) -> Result<Value, ApiError> {
        Ok(json!([
            { "id": "egg-jumbo", "name": "Egg, jumbo", "grams": 60, "per100g": { "kcal": 143, "proteinG": 12.6, "fatG": 9.5 } },
            { "id": "whey-scoop", "name": "Whey scoop", "grams": 32.4, "per100g": { "kcal": 400, "proteinG": 80 } },
            { "id": "rice-cup", "name": "Cooked rice, 1 cup", "grams": 185, "per100g": { "kcal": 130, "carbsG": 28 } }
        ]))
    }

    pub fn food_template_apply(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let template = require_str(input, "templateId")?;
        let templates = self.food_template_list()?;
        templates
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row["id"].as_str() == Some(template))
                    .cloned()
            })
            .ok_or_else(|| ApiError::NotFound("unknown food template".into()))
    }

    // ---------------------------------------------------------------- meal logging

    pub(crate) fn compute_entry(
        &self,
        input: &Map<String, Value>,
    ) -> Result<ComputedEntry, ApiError> {
        let food_id = input.get("foodId").and_then(Value::as_i64);
        let food = match food_id {
            Some(id) => Some(
                self.food_by_id(id)?
                    .ok_or_else(|| ApiError::NotFound(format!("food {id}")))?,
            ),
            None => None,
        };
        let grams = if let Some(grams) = input.get("grams").and_then(Value::as_f64) {
            grams
        } else {
            let measure = input
                .get("measure")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    ApiError::InvalidInput("each entry needs grams or measure".into())
                })?;
            let name = require_str(measure, "name")?;
            let count = measure.get("count").and_then(Value::as_f64).unwrap_or(1.0);
            let overrides = parse_measures(food.as_ref().and_then(|f| f.measures_json.as_deref()));
            resolve_measure_grams(name, count, &overrides, "measure").map_err(ApiError::from)?
        };
        if !(0.1..=20_000.0).contains(&grams) {
            return Err(ApiError::InvalidInput(
                "grams must be between 0.1 and 20000".into(),
            ));
        }
        let basis_state = match input
            .get("state")
            .and_then(Value::as_str)
            .or(food.as_ref().map(|f| f.state.as_str()))
        {
            Some(state) => FoodState::parse(state).map_err(ApiError::from)?,
            None => FoodState::Raw,
        };
        let weighed_as = match input.get("gramsAs").and_then(Value::as_str) {
            Some(state) => FoodState::parse(state).map_err(ApiError::from)?,
            None => basis_state,
        };
        let yield_factor = food.as_ref().map_or(1.0, |f| f.yield_factor);
        let basis = basis_grams(grams, weighed_as, basis_state, yield_factor, "entry")
            .map_err(ApiError::from)?;
        let macros = if let Some(food) = &food {
            Macros {
                kcal: food.kcal_per_100g * basis / 100.0,
                protein_g: food.protein_per_100g * basis / 100.0,
                carbs_g: food.carbs_per_100g * basis / 100.0,
                fat_g: food.fat_per_100g * basis / 100.0,
                fibre_g: food.fibre_per_100g * basis / 100.0,
                sodium_mg: food.sodium_per_100g * basis / 100.0,
            }
        } else if let Some(per100) = input.get("per100g").and_then(Value::as_object) {
            let value = |key: &str| per100.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            Macros {
                kcal: value("kcal") * basis / 100.0,
                protein_g: value("proteinG") * basis / 100.0,
                carbs_g: value("carbsG") * basis / 100.0,
                fat_g: value("fatG") * basis / 100.0,
                fibre_g: value("fibreG") * basis / 100.0,
                sodium_mg: value("sodiumMg") * basis / 100.0,
            }
        } else {
            let value = |key: &str| input.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            // Absolute macros are the portion as eaten: never rescaled by state.
            Macros {
                kcal: value("kcal"),
                protein_g: value("proteinG"),
                carbs_g: value("carbsG"),
                fat_g: value("fatG"),
                fibre_g: value("fibreG"),
                sodium_mg: value("sodiumMg"),
            }
        };
        let macro_source = MacroSource::effective(
            input.get("macroSource").and_then(Value::as_str),
            input
                .get("estimated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
        let name = food.map_or_else(
            || str_or(input, "name", "Unnamed food").to_owned(),
            |food| food.name,
        );
        Ok(ComputedEntry {
            name,
            food_id,
            grams,
            macros,
            basis,
            basis_state,
            yield_factor,
            weighed_as,
            macro_source,
            weight_source: str_or(
                input,
                "weightSource",
                if input.contains_key("measure") {
                    "counted"
                } else {
                    "weighed"
                },
            )
            .to_owned(),
            note: input.get("note").and_then(Value::as_str).map(str::to_owned),
        })
    }

    pub fn meal_log(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let meal = Meal::parse(require_str(input, "meal")?).map_err(ApiError::from)?;
        let tz = self.timezone()?;
        let entries = input
            .get("entries")
            .and_then(Value::as_array)
            .filter(|rows| !rows.is_empty() && rows.len() <= 100)
            .ok_or_else(|| {
                ApiError::InvalidInput(
                    "entries must be a non-empty array of at most 100 rows".into(),
                )
            })?;
        let day = match input.get("day").and_then(Value::as_str) {
            Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
            None => self.today()?,
        };
        let today = self.today()?;
        let base_ms = match input.get("eatenAt") {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(Utc::now().timestamp_millis()),
            Some(Value::String(s)) => parse_eaten_at(s, &day, &tz)?,
            _ if day == today => Utc::now().timestamp_millis(),
            _ => day.time_ms("12:00", &tz).map_err(ApiError::from)?,
        };
        let mut computed = Vec::new();
        for row in entries {
            let object = row
                .as_object()
                .ok_or_else(|| ApiError::InvalidInput("entry must be an object".into()))?;
            computed.push(self.compute_entry(object)?);
        }
        let now = Utc::now().timestamp_millis();
        let ids: Vec<i64> = self.store.call(move |conn| {
            let tx = conn.transaction()?;
            let mut ids = Vec::new();
            for (index, entry) in computed.iter().enumerate() {
                for attempt in 0..6 {
                    let result = tx.query_row(
                        "INSERT INTO food_log (day, meal, eaten_at_ms, food_id, name, grams, kcal,
                            protein_g, carbs_g, fat_g, fibre_g, sodium_mg, estimated, weight_source,
                            macro_source, grams_as, raw_equivalent_grams, basis_state, basis_yield_factor,
                            note, created_at_ms, updated_at_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                                 ?16, ?17, ?18, ?19, ?20, ?21, ?21) RETURNING id",
                        params![day.to_string(), meal.as_str(), base_ms + index as i64 + attempt * 1000,
                            entry.food_id, entry.name, entry.grams, entry.macros.kcal, entry.macros.protein_g,
                            entry.macros.carbs_g, entry.macros.fat_g, entry.macros.fibre_g, entry.macros.sodium_mg,
                            i64::from(entry.macro_source == MacroSource::Estimated), entry.weight_source,
                            entry.macro_source.as_str(), entry.weighed_as.as_str(), entry.basis,
                            entry.basis_state.as_str(), entry.yield_factor, entry.note, now],
                        |row| row.get::<_, i64>(0),
                    );
                    match result {
                        Ok(id) => { ids.push(id); break; }
                        Err(rusqlite::Error::SqliteFailure(err, _))
                            if err.code == rusqlite::ErrorCode::ConstraintViolation && attempt < 5 => continue,
                        Err(err) => return Err(err.into()),
                    }
                }
            }
            tx.commit()?;
            Ok(ids)
        })?;
        Ok(json!({ "day": day.to_string(), "meal": meal.as_str(), "entries": ids }))
    }

    pub fn meal_get(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        self.store
            .call(move |conn| Ok(query_one_entry(conn, id)?))?
            .ok_or_else(|| ApiError::NotFound(format!("entry {id}")))
    }

    pub fn meal_update(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let previous = self.meal_get(input)?;
        let fraction = input
            .get("servingFraction")
            .and_then(Value::as_f64)
            .unwrap_or(1.0);
        if !(0.01..=100.0).contains(&fraction) {
            return Err(ApiError::InvalidInput(
                "servingFraction must be between 0.01 and 100".into(),
            ));
        }
        let grams = input.get("grams").and_then(Value::as_f64);
        let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
        let meal = input.get("meal").and_then(Value::as_str).map(str::to_owned);
        let now = Utc::now().timestamp_millis();
        self.store.call(move |conn| {
            let tx = conn.transaction()?;
            if let Some(raw) = previous["recipeServingJson"].as_str().and_then(|raw| serde_json::from_str::<Value>(raw).ok()) {
                // Rescale from the immutable per-serving snapshot, never from the live food.
                let scale = |key: &str| -> f64 { raw[key].as_f64().unwrap_or(0.0) * fraction };
                tx.execute("UPDATE food_log SET grams = ?1, kcal = ?2, protein_g = ?3, carbs_g = ?4,
                    fat_g = ?5, fibre_g = ?6, sodium_mg = ?7, updated_at_ms = ?8 WHERE id = ?9",
                    params![scale("grams"), scale("kcal"), scale("proteinG"), scale("carbsG"),
                        scale("fatG"), scale("fibreG"), scale("sodiumMg"), now, id])?;
            } else if let Some(grams) = grams {
                let per_gram = |key: &str| previous[key].as_f64().unwrap_or(0.0) / previous["grams"].as_f64().unwrap_or(1.0);
                tx.execute("UPDATE food_log SET grams = ?1, kcal = ?2, protein_g = ?3, carbs_g = ?4,
                    fat_g = ?5, fibre_g = ?6, sodium_mg = ?7, updated_at_ms = ?8 WHERE id = ?9",
                    params![grams, per_gram("kcal") * grams, per_gram("proteinG") * grams,
                        per_gram("carbsG") * grams, per_gram("fatG") * grams, per_gram("fibreG") * grams,
                        per_gram("sodiumMg") * grams, now, id])?;
            }
            if let Some(note) = note {
                tx.execute("UPDATE food_log SET note = ?1, updated_at_ms = ?2 WHERE id = ?3", params![note, now, id])?;
            }
            if let Some(meal) = meal {
                tx.execute("UPDATE food_log SET meal = ?1, updated_at_ms = ?2 WHERE id = ?3", params![meal, now, id])?;
            }
            let previous_json = serde_json::to_string(&previous).unwrap_or_default();
            tx.execute("INSERT INTO food_log_revisions (food_log_id, reason, previous_json, new_json, created_at_ms)
                VALUES (?1, 'meal_update', ?2, ?3, ?4)", params![id, previous_json, previous_json, now])?;
            tx.commit()?;
            Ok(())
        })?;
        self.meal_get(input)
    }

    pub fn meal_delete(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let changed = self.exec(
            "DELETE FROM food_log WHERE id = ?1",
            vec![rusqlite::types::Value::Integer(id)],
        )?;
        Ok(json!({ "deleted": changed > 0 }))
    }

    // ---------------------------------------------------------------- nutrition reads

    pub fn nutrition_day(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let day = match input.get("day").and_then(Value::as_str) {
            Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
            None => self.today()?,
        };
        let day_string = day.to_string();
        let values: Vec<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT meal, kcal, protein_g AS proteinG, carbs_g AS carbsG, fat_g AS fatG,
                fibre_g AS fibreG, sodium_mg AS sodiumMg FROM food_log WHERE day = ?1",
                params![day_string],
                &[
                    "meal", "kcal", "proteinG", "carbsG", "fatG", "fibreG", "sodiumMg",
                ],
            )
        })?;
        let totals = values.iter().fold(Macros::ZERO, |acc, row| Macros {
            kcal: acc.kcal + num(row, "kcal"),
            protein_g: acc.protein_g + num(row, "proteinG"),
            carbs_g: acc.carbs_g + num(row, "carbsG"),
            fat_g: acc.fat_g + num(row, "fatG"),
            fibre_g: acc.fibre_g + num(row, "fibreG"),
            sodium_mg: acc.sodium_mg + num(row, "sodiumMg"),
        });
        let targets = self.targets_for(&day)?;
        Ok(json!({
            "day": day.to_string(), "totals": macro_json(totals), "targets": macro_json(targets),
            "remaining": macro_json(Macros {
                kcal: targets.kcal - totals.kcal, protein_g: targets.protein_g - totals.protein_g,
                carbs_g: targets.carbs_g - totals.carbs_g, fat_g: targets.fat_g - totals.fat_g,
                fibre_g: targets.fibre_g - totals.fibre_g, sodium_mg: targets.sodium_mg - totals.sodium_mg,
            }),
            "entries": values.len()
        }))
    }

    pub fn nutrition_summary(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let days = clamp_i64(input.get("days"), 7, 1, 365) as usize;
        let end = match input.get("endDay").and_then(Value::as_str) {
            Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
            None => self.today()?,
        };
        let mut result = Vec::new();
        for day in last_days(days, end) {
            let mut query = Map::new();
            query.insert("day".into(), json!(day.to_string()));
            let value = self.nutrition_day(&query)?;
            result.push(json!({ "day": day.to_string(), "totals": value["totals"].clone() }));
        }
        Ok(json!(result))
    }

    fn targets_for(&self, day: &Day) -> Result<Macros, ApiError> {
        let day = day.to_string();
        let row: Option<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT kcal, protein_g AS proteinG, carbs_g AS carbsG,
                fat_g AS fatG, fibre_g AS fibreG, sodium_mg AS sodiumMg FROM nutrition_targets
                WHERE effective_from <= ?1 ORDER BY effective_from DESC LIMIT 1",
                params![day],
                &["kcal", "proteinG", "carbsG", "fatG", "fibreG", "sodiumMg"],
            )
            .map(|rows| rows.into_iter().next())
        })?;
        Ok(match row {
            Some(row) => Macros {
                kcal: num(&row, "kcal"),
                protein_g: num(&row, "proteinG"),
                carbs_g: num(&row, "carbsG"),
                fat_g: num(&row, "fatG"),
                fibre_g: num(&row, "fibreG"),
                sodium_mg: num(&row, "sodiumMg"),
            },
            // Suggested defaults for a 75 kg adult until an explicit plan exists.
            None => Macros {
                kcal: 2400.0,
                protein_g: 120.0,
                carbs_g: 280.0,
                fat_g: 80.0,
                fibre_g: 30.0,
                sodium_mg: 2300.0,
            },
        })
    }

    pub fn nutrition_target_set(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let day = match input.get("effectiveFrom").and_then(Value::as_str) {
            Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
            None => self.today()?,
        };
        let current = self.targets_for(&day)?;
        let pick = |key: &str, current: f64| -> f64 {
            input.get(key).and_then(Value::as_f64).unwrap_or(current)
        };
        let next = Macros {
            kcal: pick("kcal", current.kcal),
            protein_g: pick("proteinG", current.protein_g),
            carbs_g: pick("carbsG", current.carbs_g),
            fat_g: pick("fatG", current.fat_g),
            fibre_g: pick("fibreG", current.fibre_g),
            sodium_mg: pick("sodiumMg", current.sodium_mg),
        };
        let now = Utc::now().timestamp_millis();
        let day_string = day.to_string();
        self.store.call(move |conn| {
            conn.execute("INSERT INTO nutrition_targets (effective_from, kcal, protein_g, carbs_g, fat_g, fibre_g, sodium_mg, created_at_ms, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                ON CONFLICT(effective_from) DO UPDATE SET kcal = excluded.kcal, protein_g = excluded.protein_g,
                  carbs_g = excluded.carbs_g, fat_g = excluded.fat_g, fibre_g = excluded.fibre_g,
                  sodium_mg = excluded.sodium_mg, updated_at_ms = excluded.updated_at_ms",
                params![day_string, next.kcal, next.protein_g, next.carbs_g, next.fat_g, next.fibre_g, next.sodium_mg, now])?;
            Ok(())
        })?;
        Ok(json!({ "effectiveFrom": day.to_string(), "targets": macro_json(next) }))
    }

    pub fn copy_day(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let from = Day::parse(require_str(input, "fromDay")?).map_err(ApiError::from)?;
        let to = Day::parse(require_str(input, "toDay")?).map_err(ApiError::from)?;
        let now = Utc::now().timestamp_millis();
        let tz = self.timezone()?;
        let target_midday = to.time_ms("12:00", &tz).map_err(ApiError::from)?;
        let copied = self.store.call(move |conn| {
            let tx = conn.transaction()?;
            let rows: Vec<(i64, Option<String>)> = {
                let mut stmt = tx.prepare("SELECT id, note FROM food_log WHERE day = ?1")?;
                let mut rows = stmt.query(params![from.to_string()])?;
                let mut out = Vec::new();
                while let Some(row) = rows.next()? { out.push((row.get(0)?, row.get(1)?)); }
                out
            };
            let mut count = 0;
            for (id, note) in rows {
                let new_id: i64 = tx.query_row(
                    "INSERT INTO food_log (day, meal, eaten_at_ms, food_id, name, grams, kcal, protein_g,
                        carbs_g, fat_g, fibre_g, sodium_mg, estimated, weight_source, macro_source, grams_as,
                        raw_equivalent_grams, basis_state, basis_yield_factor, recipe_id, serving_no,
                        serving_fraction, recipe_serving_json, note, created_at_ms, updated_at_ms)
                     SELECT ?1, meal, ?2, food_id, name, grams, kcal, protein_g, carbs_g, fat_g, fibre_g,
                        sodium_mg, estimated, weight_source, macro_source, grams_as, raw_equivalent_grams,
                        basis_state, basis_yield_factor, recipe_id, serving_no, serving_fraction,
                        recipe_serving_json, ?3, ?4, ?4 FROM food_log WHERE id = ?5 RETURNING id",
                    params![to.to_string(), target_midday, note, now, id], |row| row.get(0))?;
                tx.execute("INSERT INTO food_log_ingredients (food_log_id, recipe_id, recipe_ingredient_id,
                    food_id, name, position, amount_basis, grams, per_serving_grams, measure_json, grams_as,
                    food_state, yield_factor, raw_equivalent_grams, kcal_per_100g, protein_per_100g,
                    carbs_per_100g, fat_per_100g, fibre_per_100g, sodium_per_100g, kcal, protein_g,
                    carbs_g, fat_g, fibre_g, sodium_mg, resolved, macro_source, weight_source, source,
                    source_url, source_date, created_at_ms)
                    SELECT ?1, recipe_id, recipe_ingredient_id, food_id, name, position, amount_basis,
                    grams, per_serving_grams, measure_json, grams_as, food_state, yield_factor,
                    raw_equivalent_grams, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
                    fibre_per_100g, sodium_per_100g, kcal, protein_g, carbs_g, fat_g, fibre_g, sodium_mg,
                    resolved, macro_source, weight_source, source, source_url, source_date, ?2
                    FROM food_log_ingredients WHERE food_log_id = ?3", params![new_id, now, id])?;
                count += 1;
            }
            tx.commit()?;
            Ok(count)
        })?;
        Ok(json!({ "copied": copied, "toDay": to.to_string() }))
    }

    // ---------------------------------------------------------------- Apple read model

    pub fn metrics_series(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let metric = require_str(input, "metric")?.to_owned();
        let days = clamp_i64(input.get("days"), 30, 1, 3650);
        let from = self.today()?.add(-days);
        let metric_clone = metric.clone();
        let from_string = from.to_string();
        let rows: Vec<hv_core::workouts::QuantityRecord> = self.store.call(move |conn| {
            let mut stmt = conn.prepare("SELECT id, type_identifier, unit, value, start_date, start_ms,
                day, end_date, end_ms, source_name FROM records WHERE type_identifier = ?1 AND day >= ?2")?;
            let mut rows = stmt.query(params![metric_clone, from_string])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let day: String = row.get("day")?;
                out.push(hv_core::workouts::QuantityRecord {
                    id: row.get("id")?, type_identifier: row.get("type_identifier")?, unit: row.get("unit")?,
                    value: row.get("value")?, start_date: row.get("start_date")?, start_ms: row.get("start_ms")?,
                    day: Day::parse(&day).unwrap_or_else(|_| Day::epoch()),
                    end_date: row.get("end_date")?, end_ms: row.get("end_ms")?, source_name: row.get("source_name")?,
                });
            }
            Ok(out)
        })?;
        let aggregation = if metric.contains("HeartRate") || metric.contains("VO2Max") {
            SeriesAggregation::Avg
        } else {
            SeriesAggregation::Sum
        };
        Ok(json!(daily_series_single_source(
            &rows,
            &metric,
            &from,
            aggregation
        )))
    }

    pub fn workouts_recent(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let limit = clamp_i64(input.get("limit"), 50, 1, 500);
        let rows: Vec<WorkoutRow> = self.store.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, workout_activity_type, start_date, start_ms, day,
                end_date, end_ms, duration_seconds, total_distance, total_distance_unit,
                total_energy_burned, avg_hr, min_hr, max_hr, source_name FROM workouts",
            )?;
            let mut rows = stmt.query([])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let day: String = row.get("day")?;
                out.push(WorkoutRow {
                    id: row.get("id")?,
                    activity_type: row.get("workout_activity_type")?,
                    start_date: row.get("start_date")?,
                    start_ms: row.get("start_ms")?,
                    day: Day::parse(&day).unwrap_or_else(|_| Day::epoch()),
                    end_date: row.get("end_date")?,
                    end_ms: row.get("end_ms")?,
                    duration_seconds: row.get("duration_seconds")?,
                    total_distance: row.get("total_distance")?,
                    total_distance_unit: row.get("total_distance_unit")?,
                    total_energy_burned: row.get("total_energy_burned")?,
                    avg_hr: row.get("avg_hr")?,
                    min_hr: row.get("min_hr")?,
                    max_hr: row.get("max_hr")?,
                    source_name: row.get("source_name")?,
                });
            }
            Ok(out)
        })?;
        let result: Vec<Value> = reconcile_workouts(rows)
            .into_iter()
            .take(limit as usize)
            .map(|row| {
                json!({
                    "id": row.id, "type": row.activity_type, "day": row.day.to_string(),
                    "startDate": row.start_date, "endDate": row.end_date,
                    "minutes": row.duration_seconds.map(|v| v / 60.0), "km": row.distance_km(),
                    "kcal": row.total_energy_burned, "paceMinPerKm": row.pace_min_per_km(),
                    "avgHr": row.avg_hr, "maxHr": row.max_hr, "sourceName": row.source_name,
                })
            })
            .collect();
        Ok(json!(result))
    }

    pub fn record_types(&self) -> Result<Value, ApiError> {
        let rows: Vec<Value> = self.store.call(|conn| {
            query_rows(
                conn,
                "SELECT type_identifier AS typeIdentifier, unit, COUNT(*) AS count,
                MIN(day) AS firstDay, MAX(day) AS lastDay, SUM(value) AS sum, AVG(value) AS avg,
                MAX(value) AS max FROM records GROUP BY type_identifier ORDER BY count DESC",
                [],
                &[
                    "typeIdentifier",
                    "unit",
                    "count",
                    "firstDay",
                    "lastDay",
                    "sum",
                    "avg",
                    "max",
                ],
            )
        })?;
        Ok(json!(rows))
    }

    pub fn records_recent(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let metric = require_str(input, "type")?.to_owned();
        let limit = clamp_i64(input.get("limit"), 200, 1, 500);
        let rows: Vec<Value> = self.store.call(move |conn| {
            query_rows(conn, "SELECT day, start_date AS startDate, end_date AS endDate, value, unit,
                source_name AS sourceName FROM records WHERE type_identifier = ?1 ORDER BY start_ms DESC LIMIT ?2",
                params![metric, limit], &["day", "startDate", "endDate", "value", "unit", "sourceName"])
        })?;
        Ok(json!(rows))
    }

    pub fn uploads_recent(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let limit = clamp_i64(input.get("limit"), 50, 1, 100);
        let rows: Vec<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT filename, bytes, status, records_inserted AS recordsInserted,
                records_duplicates AS recordsDuplicates, message, created_at_ms AS createdAtMs,
                finished_at_ms AS finishedAtMs FROM uploads ORDER BY created_at_ms DESC LIMIT ?1",
                params![limit],
                &[
                    "filename",
                    "bytes",
                    "status",
                    "recordsInserted",
                    "recordsDuplicates",
                    "message",
                    "createdAtMs",
                    "finishedAtMs",
                ],
            )
        })?;
        Ok(json!(rows))
    }

    // ---------------------------------------------------------------- supplements

    pub fn supplement_list(&self) -> Result<Value, ApiError> {
        let rows: Vec<Value> = self.store.call(|conn| {
            query_rows(conn, "SELECT id, name, dose, unit, schedule_json AS scheduleJson,
                nutrients_json AS nutrientsJson, notes, active FROM supplements WHERE active = 1 ORDER BY name",
                [], &["id", "name", "dose", "unit", "scheduleJson", "nutrientsJson", "notes", "active"])
        })?;
        Ok(json!(rows))
    }

    pub fn supplement_create(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let name = require_str(input, "name")?.to_owned();
        let dose = input.get("dose").and_then(Value::as_f64).unwrap_or(1.0);
        let unit = str_or(input, "unit", "capsule").to_owned();
        let now = Utc::now().timestamp_millis();
        let schedule = json_string(input.get("schedule"));
        let nutrients = json_string(input.get("nutrients"));
        let notes = input
            .get("notes")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let id: i64 = self.store.call(move |conn| {
            Ok(conn.query_row("INSERT INTO supplements (name, dose, unit, schedule_json, nutrients_json, notes, active, created_at_ms, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7) RETURNING id",
                params![name, dose, unit, schedule, nutrients, notes, now], |row| row.get(0))?)
        })?;
        Ok(json!({ "id": id }))
    }

    pub fn supplement_update(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let now = Utc::now().timestamp_millis();
        let name = input.get("name").and_then(Value::as_str).map(str::to_owned);
        let dose = input.get("dose").and_then(Value::as_f64);
        let unit = input.get("unit").and_then(Value::as_str).map(str::to_owned);
        let active = input.get("active").and_then(Value::as_bool).map(i64::from);
        self.store.call(move |conn| {
            conn.execute("UPDATE supplements SET name = COALESCE(?1, name), dose = COALESCE(?2, dose),
                unit = COALESCE(?3, unit), active = COALESCE(?4, active), updated_at_ms = ?5 WHERE id = ?6",
                params![name, dose, unit, active, now, id])?;
            Ok(())
        })?;
        Ok(json!({ "id": id, "updated": true }))
    }

    pub fn supplement_log(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let day = match input.get("day").and_then(Value::as_str) {
            Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
            None => self.today()?,
        };
        let dose = input.get("dose").and_then(Value::as_f64).unwrap_or(1.0);
        let unit = str_or(input, "unit", "capsule").to_owned();
        let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
        let now = Utc::now().timestamp_millis();
        self.store.call(move |conn| {
            conn.execute("INSERT INTO supplement_logs (supplement_id, day, taken_at_ms, dose, unit, note, created_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(supplement_id, day) DO UPDATE SET taken_at_ms = excluded.taken_at_ms,
                  dose = excluded.dose, unit = excluded.unit, note = excluded.note, whey_action_id = NULL",
                params![id, day.to_string(), now, dose, unit, note, now])?;
            Ok(())
        })?;
        Ok(json!({ "id": id, "day": day.to_string(), "dose": dose }))
    }

    pub fn supplement_history(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let days = clamp_i64(input.get("days"), 30, 1, 3650);
        let from = self.today()?.add(-days).to_string();
        let rows: Vec<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT supplement_id AS supplementId, day, taken_at_ms AS takenAtMs, dose, unit
                FROM supplement_logs WHERE day >= ?1 ORDER BY day",
                params![from],
                &["supplementId", "day", "takenAtMs", "dose", "unit"],
            )
        })?;
        Ok(json!(rows))
    }

    pub fn supplement_delete(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        self.exec(
            "DELETE FROM supplement_logs WHERE supplement_id = ?1",
            vec![rusqlite::types::Value::Integer(id)],
        )?;
        let changed = self.exec(
            "DELETE FROM supplements WHERE id = ?1",
            vec![rusqlite::types::Value::Integer(id)],
        )?;
        Ok(json!({ "deleted": changed > 0 }))
    }

    // ---------------------------------------------------------------- recipes

    pub fn recipe_list(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let include_archived = input
            .get("includeArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let sql = if include_archived {
            "SELECT id, name, servings_total AS servingsTotal, note, archived_at_ms AS archivedAtMs FROM recipes ORDER BY name"
        } else {
            "SELECT id, name, servings_total AS servingsTotal, note, archived_at_ms AS archivedAtMs FROM recipes WHERE archived_at_ms IS NULL ORDER BY name"
        };
        let rows: Vec<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                sql,
                [],
                &["id", "name", "servingsTotal", "note", "archivedAtMs"],
            )
        })?;
        Ok(json!(rows))
    }

    fn food_by_id(&self, id: i64) -> Result<Option<StoredFood>, ApiError> {
        Ok(self.store.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, kcal_per_100g, protein_per_100g, carbs_per_100g,
                fat_per_100g, fibre_per_100g, sodium_per_100g, state, yield_factor, measures_json
                FROM foods WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => Ok(Some(StoredFood {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kcal_per_100g: row.get("kcal_per_100g")?,
                    protein_per_100g: row.get("protein_per_100g")?,
                    carbs_per_100g: row.get("carbs_per_100g")?,
                    fat_per_100g: row.get("fat_per_100g")?,
                    fibre_per_100g: row.get("fibre_per_100g")?,
                    sodium_per_100g: row.get("sodium_per_100g")?,
                    state: row.get("state")?,
                    yield_factor: row.get("yield_factor")?,
                    measures_json: row.get("measures_json")?,
                })),
                None => Ok(None),
            }
        })?)
    }

    pub fn recipe_get(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let recipe: Option<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT id, name, servings_total AS servingsTotal, note,
                archived_at_ms AS archivedAtMs FROM recipes WHERE id = ?1",
                params![id],
                &["id", "name", "servingsTotal", "note", "archivedAtMs"],
            )
            .map(|rows| rows.into_iter().next())
        })?;
        let recipe = recipe.ok_or_else(|| ApiError::NotFound(format!("recipe {id}")))?;
        let ingredients: Vec<Value> = self.store.call(move |conn| {
            query_rows(
                conn,
                "SELECT ri.id, ri.food_id AS foodId, ri.name, ri.grams,
                ri.measure_json AS measureJson, f.state, f.yield_factor AS yieldFactor,
                f.kcal_per_100g AS kcalPer100g, f.protein_per_100g AS proteinPer100g,
                f.carbs_per_100g AS carbsPer100g, f.fat_per_100g AS fatPer100g,
                f.fibre_per_100g AS fibrePer100g, f.sodium_per_100g AS sodiumPer100g,
                f.source, f.source_url AS sourceUrl, f.source_date AS sourceDate
                FROM recipe_ingredients ri LEFT JOIN foods f ON f.id = ri.food_id
                WHERE ri.recipe_id = ?1 ORDER BY ri.position, ri.id",
                params![id],
                &[
                    "id",
                    "foodId",
                    "name",
                    "grams",
                    "measureJson",
                    "state",
                    "yieldFactor",
                    "kcalPer100g",
                    "proteinPer100g",
                    "carbsPer100g",
                    "fatPer100g",
                    "fibrePer100g",
                    "sodiumPer100g",
                    "source",
                    "sourceUrl",
                    "sourceDate",
                ],
            )
        })?;
        let mut macros = Macros::ZERO;
        let mut unresolved = Vec::new();
        for ingredient in &ingredients {
            if ingredient["kcalPer100g"].is_null() {
                unresolved.push(ingredient["name"].as_str().unwrap_or("unknown").to_owned());
                continue;
            }
            let state = ingredient["state"].as_str().unwrap_or("raw");
            let state = FoodState::parse(state).unwrap_or(FoodState::Raw);
            let basis = basis_grams(num(ingredient, "grams"), state, state, 1.0, "ingredient")
                .unwrap_or(0.0);
            macros.kcal += num(ingredient, "kcalPer100g") * basis / 100.0;
            macros.protein_g += num(ingredient, "proteinPer100g") * basis / 100.0;
            macros.carbs_g += num(ingredient, "carbsPer100g") * basis / 100.0;
            macros.fat_g += num(ingredient, "fatPer100g") * basis / 100.0;
            macros.fibre_g += num(ingredient, "fibrePer100g") * basis / 100.0;
            macros.sodium_mg += num(ingredient, "sodiumPer100g") * basis / 100.0;
        }
        let servings = recipe["servingsTotal"].as_i64().unwrap_or(2).max(1) as f64;
        Ok(json!({
            "recipe": recipe, "ingredients": ingredients, "unresolved": unresolved,
            "totals": macro_json(macros), "perServing": macro_json(macros.scaled(1.0 / servings))
        }))
    }

    pub fn recipe_create(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let name = require_str(input, "name")?.to_owned();
        let servings = clamp_i64(input.get("servingsTotal"), 2, 1, 100);
        let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
        let ingredients = input
            .get("ingredients")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let now = Utc::now().timestamp_millis();
        let id: i64 = self.store.call(move |conn| {
            let tx = conn.transaction()?;
            let id: i64 = tx.query_row("INSERT INTO recipes (name, servings_total, note, created_at_ms, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?4) RETURNING id", params![name, servings, note, now], |row| row.get(0))?;
            for (position, value) in ingredients.iter().enumerate() {
                let Some(ingredient) = value.as_object() else { continue };
                let grams = ingredient.get("grams").and_then(Value::as_f64).unwrap_or(0.0);
                tx.execute("INSERT INTO recipe_ingredients (recipe_id, food_id, name, grams, measure_json, position)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, ingredient.get("foodId").and_then(Value::as_i64),
                        ingredient.get("name").and_then(Value::as_str), grams,
                        json_string(ingredient.get("measure")), position as i64])?;
            }
            tx.commit()?;
            Ok(id)
        })?;
        Ok(json!({ "id": id }))
    }

    pub fn recipe_update(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let name = input.get("name").and_then(Value::as_str).map(str::to_owned);
        let servings = input.get("servingsTotal").and_then(Value::as_i64);
        let note = input.get("note").and_then(Value::as_str).map(str::to_owned);
        let now = Utc::now().timestamp_millis();
        self.store.call(move |conn| {
            conn.execute("UPDATE recipes SET name = COALESCE(?1, name), servings_total = COALESCE(?2, servings_total),
                note = COALESCE(?3, note), updated_at_ms = ?4 WHERE id = ?5",
                params![name, servings, note, now, id])?;
            Ok(())
        })?;
        Ok(json!({ "id": id, "updated": true }))
    }

    pub fn recipe_delete(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let id = require_i64(input, "id")?;
        let logged: i64 = self.store.call(move |conn| {
            scalar_i64(
                conn,
                "SELECT COUNT(*) FROM food_log WHERE recipe_id = ?1",
                params![id],
            )
        })?;
        if logged > 0 {
            let now = Utc::now().timestamp_millis();
            self.exec(
                "UPDATE recipes SET archived_at_ms = ?1, archived_reason = 'history' WHERE id = ?2",
                vec![
                    rusqlite::types::Value::Integer(now),
                    rusqlite::types::Value::Integer(id),
                ],
            )?;
            return Ok(json!({ "archived": true }));
        }
        self.exec(
            "DELETE FROM recipe_ingredients WHERE recipe_id = ?1",
            vec![rusqlite::types::Value::Integer(id)],
        )?;
        self.exec(
            "DELETE FROM recipes WHERE id = ?1",
            vec![rusqlite::types::Value::Integer(id)],
        )?;
        Ok(json!({ "deleted": true }))
    }

    pub fn recipe_log(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        let recipe_id = require_i64(input, "recipeId")?;
        let mut query = Map::new();
        query.insert("id".into(), json!(recipe_id));
        let detail = self.recipe_get(&query)?;
        if !detail["recipe"]["archivedAtMs"].is_null() {
            return Err(ApiError::Conflict(
                "archived recipes cannot be logged".into(),
            ));
        }
        let servings = detail["recipe"]["servingsTotal"]
            .as_i64()
            .unwrap_or(2)
            .max(1) as f64;
        let fraction = input
            .get("servingFraction")
            .and_then(Value::as_f64)
            .unwrap_or(1.0);
        if !(0.01..=100.0).contains(&fraction) {
            return Err(ApiError::InvalidInput(
                "servingFraction must be between 0.01 and 100".into(),
            ));
        }
        let meal = Meal::parse(require_str(input, "meal")?).map_err(ApiError::from)?;
        let day = match input.get("day").and_then(Value::as_str) {
            Some(raw) => Day::parse(raw).map_err(ApiError::from)?,
            None => self.today()?,
        };
        let tz = self.timezone()?;
        let base_ms = match input.get("eatenAt") {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(Utc::now().timestamp_millis()),
            Some(Value::String(s)) => parse_eaten_at(s, &day, &tz)?,
            _ => day.time_ms("12:00", &tz).map_err(ApiError::from)?,
        };
        let total = macros_from_value(&detail["totals"]);
        let per_serving = total.scaled(1.0 / servings);
        let portion = per_serving.scaled(fraction);
        let ingredients = detail["ingredients"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let snapshot = json!({
            "grams": 0.0, "kcal": per_serving.kcal, "proteinG": per_serving.protein_g,
            "carbsG": per_serving.carbs_g, "fatG": per_serving.fat_g, "fibreG": per_serving.fibre_g,
            "sodiumMg": per_serving.sodium_mg, "estimated": false, "snapshotVersion": 2,
            "ingredientCount": ingredients.len()
        });
        let unresolved: Vec<String> = detail["unresolved"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let now = Utc::now().timestamp_millis();
        let snapshot_json = serde_json::to_string(&snapshot).unwrap_or_default();
        let recipe_name = detail["recipe"]["name"]
            .as_str()
            .unwrap_or("Recipe")
            .to_owned();
        let id: i64 = self.store.call(move |conn| {
            let tx = conn.transaction()?;
            let id: i64 = tx.query_row("INSERT INTO food_log (day, meal, eaten_at_ms, food_id, name, grams,
                kcal, protein_g, carbs_g, fat_g, fibre_g, sodium_mg, macro_source, recipe_id, serving_no,
                serving_fraction, recipe_serving_json, created_at_ms, updated_at_ms)
                VALUES (?1, ?2, ?3, NULL, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?10, 'recipe', ?11, 1, ?12, ?13, ?14, ?14)
                RETURNING id",
                params![day.to_string(), meal.as_str(), base_ms, recipe_name, portion.kcal, portion.protein_g,
                    portion.carbs_g, portion.fat_g, portion.fibre_g, portion.sodium_mg, recipe_id,
                    fraction, snapshot_json, now], |row| row.get(0))?;
            for (position, ingredient) in ingredients.iter().enumerate() {
                let resolved = !ingredient["kcalPer100g"].is_null();
                let grams = num(ingredient, "grams") / servings * fraction;
                let factor = grams / 100.0;
                tx.execute("INSERT INTO food_log_ingredients (food_log_id, recipe_id, food_id, name, position,
                    amount_basis, grams, per_serving_grams, grams_as, food_state, yield_factor,
                    kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fibre_per_100g,
                    sodium_per_100g, kcal, protein_g, carbs_g, fat_g, fibre_g, sodium_mg, resolved,
                    macro_source, weight_source, source, source_url, source_date, created_at_ms)
                    VALUES (?1, ?2, ?3, ?4, ?5, 'batch', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                      ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)",
                    params![id, recipe_id, ingredient["foodId"].as_i64(),
                        ingredient["name"].as_str().unwrap_or("ingredient"), position as i64, grams,
                        num(ingredient, "grams") / servings, "raw", ingredient["state"].as_str(),
                        ingredient["yieldFactor"].as_f64().unwrap_or(1.0),
                        ingredient["kcalPer100g"].as_f64(), ingredient["proteinPer100g"].as_f64(),
                        ingredient["carbsPer100g"].as_f64(), ingredient["fatPer100g"].as_f64(),
                        ingredient["fibrePer100g"].as_f64(), ingredient["sodiumPer100g"].as_f64(),
                        num(ingredient, "kcalPer100g") * factor, num(ingredient, "proteinPer100g") * factor,
                        num(ingredient, "carbsPer100g") * factor, num(ingredient, "fatPer100g") * factor,
                        num(ingredient, "fibrePer100g") * factor, num(ingredient, "sodiumPer100g") * factor,
                        i64::from(resolved), if resolved { "label" } else { "estimated" }, "weighed",
                        ingredient["source"].as_str(), ingredient["sourceUrl"].as_str(),
                        ingredient["sourceDate"].as_str(), now])?;
            }
            tx.commit()?;
            Ok(id)
        })?;
        Ok(
            json!({ "id": id, "entryId": id, "incomplete": !unresolved.is_empty(), "unresolvedIngredients": unresolved }),
        )
    }

    // ---------------------------------------------------------------- health context

    pub fn health_context(&self) -> Result<Value, ApiError> {
        let profile = self.profile_get()?;
        let today = self.today()?;
        let nutrition = self.nutrition_day(&Map::new())?;
        let workouts = self.workouts_recent(&Map::new())?;
        let supplements = self.supplement_list()?;
        let freshness: Value = self.store.call(|conn| {
            let last_record: Option<String> = conn.query_row("SELECT MAX(day) FROM records", [], |row| row.get(0)).optional()?.flatten();
            let last_workout: Option<String> = conn.query_row("SELECT MAX(day) FROM workouts", [], |row| row.get(0)).optional()?.flatten();
            let last_upload: Option<i64> = conn.query_row("SELECT MAX(created_at_ms) FROM uploads", [], |row| row.get(0)).optional()?.flatten();
            Ok(json!({ "lastRecordDay": last_record, "lastWorkoutDay": last_workout, "lastUploadAtMs": last_upload }))
        })?;
        Ok(json!({
            "profile": profile, "timezone": profile["timezone"].clone(), "today": today.to_string(),
            "nutrition": nutrition, "workouts": workouts, "supplements": supplements, "freshness": freshness
        }))
    }

    pub fn history_preview(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        crate::history::preview(self, input)
    }

    pub fn history_refresh(&self, input: &Map<String, Value>) -> Result<Value, ApiError> {
        crate::history::apply(self, input)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct StoredFood {
    pub id: i64,
    pub name: String,
    pub kcal_per_100g: f64,
    pub protein_per_100g: f64,
    pub carbs_per_100g: f64,
    pub fat_per_100g: f64,
    pub fibre_per_100g: f64,
    pub sodium_per_100g: f64,
    pub state: String,
    pub yield_factor: f64,
    pub measures_json: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ComputedEntry {
    pub name: String,
    pub food_id: Option<i64>,
    pub grams: f64,
    pub macros: Macros,
    pub basis: f64,
    pub basis_state: FoodState,
    pub yield_factor: f64,
    pub weighed_as: FoodState,
    pub macro_source: MacroSource,
    pub weight_source: String,
    pub note: Option<String>,
}

fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for ch in name.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn cell_value(value: rusqlite::types::ValueRef<'_>) -> Value {
    match value {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(v) => json!(v),
        rusqlite::types::ValueRef::Real(v) => json!(v),
        rusqlite::types::ValueRef::Text(v) => {
            Value::String(String::from_utf8_lossy(v).into_owned())
        }
        rusqlite::types::ValueRef::Blob(_) => Value::Null,
    }
}

fn to_sql(value: Option<&Value>) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        None | Some(Value::Null) => Sql::Null,
        Some(Value::String(s)) => Sql::Text(s.clone()),
        Some(Value::Bool(v)) => Sql::Integer(i64::from(*v)),
        Some(Value::Number(n)) => n
            .as_i64()
            .map_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0)), Sql::Integer),
        Some(Value::Object(_) | Value::Array(_)) => {
            Sql::Text(json_string(value).unwrap_or_default())
        }
    }
}

fn json_string(value: Option<&Value>) -> Option<String> {
    value
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::to_string(v).ok())
}

fn parse_measures(json: Option<&str>) -> HashMap<String, f64> {
    json.and_then(|raw| serde_json::from_str::<Map<String, Value>>(raw).ok())
        .map(|map| {
            map.into_iter()
                .filter_map(|(k, v)| v.as_f64().map(|value| (k, value)))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_eaten_at(raw: &str, day: &Day, tz: &hv_core::TimezoneName) -> Result<i64, ApiError> {
    if let Ok(ms) = raw.parse::<i64>() {
        return Ok(ms);
    }
    let time = raw.get(11..19).unwrap_or(raw);
    day.time_ms(time, tz).map_err(ApiError::from)
}

fn require_str<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, ApiError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidInput(format!("{key} is required")))
}

fn require_i64(input: &Map<String, Value>, key: &str) -> Result<i64, ApiError> {
    input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::InvalidInput(format!("{key} must be an integer")))
}

fn require_f64(input: &Map<String, Value>, key: &str) -> Result<f64, ApiError> {
    input
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| ApiError::InvalidInput(format!("{key} must be a number")))
}

fn str_or<'a>(input: &'a Map<String, Value>, key: &str, default: &'a str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or(default)
}

fn clamp_i64(value: Option<&Value>, default: i64, min: i64, max: i64) -> i64 {
    value
        .and_then(Value::as_i64)
        .unwrap_or(default)
        .clamp(min, max)
}

fn num(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

pub(crate) fn macro_json(macros: Macros) -> Value {
    json!({
        "kcal": macros.kcal, "proteinG": macros.protein_g, "carbsG": macros.carbs_g,
        "fatG": macros.fat_g, "fibreG": macros.fibre_g, "sodiumMg": macros.sodium_mg,
    })
}

pub(crate) fn macros_from_value(value: &Value) -> Macros {
    Macros {
        kcal: num(value, "kcal"),
        protein_g: num(value, "proteinG"),
        carbs_g: num(value, "carbsG"),
        fat_g: num(value, "fatG"),
        fibre_g: num(value, "fibreG"),
        sodium_mg: num(value, "sodiumMg"),
    }
}

pub(crate) fn query_one_entry(
    conn: &rusqlite::Connection,
    id: i64,
) -> Result<Option<Value>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT * FROM food_log WHERE id = ?1")?;
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => {
            let mut map = Map::new();
            for (ix, name) in names.iter().enumerate() {
                map.insert(camel(name), cell_value(row.get_ref(ix)?));
            }
            Ok(Some(Value::Object(map)))
        }
        None => Ok(None),
    }
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

    fn service() -> Service {
        Service::new(StoreHandle::in_memory().expect("in-memory store"))
    }

    #[test]
    fn meal_log_then_nutrition_day_totals_macros() {
        let service = service();
        service
            .food_add(&json_map([
                ("name".into(), json!("Chicken breast")),
                ("kcal".into(), json!(165.0)),
                ("proteinG".into(), json!(31.0)),
            ]))
            .unwrap();
        let foods = service
            .food_search(&json_map([("query".into(), json!("Chicken"))]))
            .unwrap();
        let id = foods[0]["id"].as_i64().unwrap();
        service
            .meal_log(&json_map([
                ("day".into(), json!("2026-11-17")),
                ("meal".into(), json!("lunch")),
                ("entries".into(), json!([{ "foodId": id, "grams": 100 }])),
            ]))
            .unwrap();
        let day = service
            .nutrition_day(&json_map([("day".into(), json!("2026-11-17"))]))
            .unwrap();
        assert_eq!(day["totals"]["kcal"], 165.0);
        assert_eq!(day["totals"]["proteinG"], 31.0);
    }

    #[test]
    fn cooked_grams_use_the_foods_yield_factor() {
        let service = service();
        service
            .food_add(&json_map([
                ("name".into(), json!("Chicken")),
                ("kcal".into(), json!(100.0)),
                ("state".into(), json!("raw")),
                ("yieldFactor".into(), json!(0.8)),
            ]))
            .unwrap();
        let foods = service
            .food_search(&json_map([("query".into(), json!("Chicken"))]))
            .unwrap();
        let id = foods[0]["id"].as_i64().unwrap();
        service
            .meal_log(&json_map([
                ("day".into(), json!("2026-11-17")),
                ("meal".into(), json!("dinner")),
                (
                    "entries".into(),
                    json!([{ "foodId": id, "grams": 80, "gramsAs": "cooked" }]),
                ),
            ]))
            .unwrap();
        let day = service
            .nutrition_day(&json_map([("day".into(), json!("2026-11-17"))]))
            .unwrap();
        assert_eq!(day["totals"]["kcal"], 100.0);
    }

    #[test]
    fn archived_recipes_cannot_be_logged() {
        let service = service();
        let recipe = service
            .recipe_create(&json_map([("name".into(), json!("Soup"))]))
            .unwrap();
        let id = recipe["id"].as_i64().unwrap();
        service
            .recipe_delete(&json_map([("id".into(), json!(id))]))
            .unwrap();
        let result = service.recipe_log(&json_map([
            ("recipeId".into(), json!(id)),
            ("meal".into(), json!("dinner")),
        ]));
        assert!(
            matches!(result, Err(ApiError::NotFound(_)))
                | matches!(result, Err(ApiError::Conflict(_)))
        );
    }
}
