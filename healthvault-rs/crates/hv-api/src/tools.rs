//! Discoverable agent/MCP tool registry. Names come from `hv_core::agent` so the 38-tool wire
//! contract cannot drift between discovery, dispatch and the Rust stdio MCP server.

use serde_json::{Value, json};

use hv_core::agent::AGENT_TOOLS;

#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub read_only: bool,
    pub destructive: bool,
}

const DAY: &str = "Local calendar day (YYYY-MM-DD). Defaults to today in the profile timezone.";

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

fn day_prop() -> Value {
    json!({ "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": DAY })
}

fn tool(
    name: &'static str,
    description: &'static str,
    schema: Value,
    read_only: bool,
    destructive: bool,
) -> ToolDefinition {
    ToolDefinition {
        name,
        description,
        input_schema: schema,
        read_only,
        destructive,
    }
}

/// The full registry. Descriptions are intentionally close to the MCP plugin's model-facing text.
pub fn definitions() -> Vec<ToolDefinition> {
    let no_input = object(json!({}), &[]);
    let day = object(json!({ "day": day_prop() }), &[]);
    let day_kind = object(
        json!({
            "day": day_prop(),
            "kind": { "type": "string", "enum": ["weight", "bodyFat", "waist"] },
            "days": { "type": "integer", "minimum": 1, "maximum": 3650 }
        }),
        &[],
    );
    let id = object(
        json!({ "id": { "type": "integer", "minimum": 1 } }),
        &["id"],
    );
    let text = object(
        json!({
            "name": { "type": "string", "maxLength": 200 },
            "brand": { "type": "string" },
            "kcal": { "type": "number", "minimum": 0 },
            "per100g": { "type": "object", "properties": { "kcal": { "type": "number" } }, "required": ["kcal"] }
        }),
        &["name", "kcal"],
    );
    let meal_entries = object(
        json!({
            "day": day_prop(),
            "meal": { "type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"] },
            "eatenAt": { "type": ["string", "number"] },
            "entries": {
                "type": "array", "minItems": 1, "maxItems": 100,
                "items": object(json!({
                    "foodId": { "type": "integer", "minimum": 1 },
                    "name": { "type": "string" },
                    "grams": { "type": "number", "minimum": 0.1, "maximum": 20000 },
                    "kcal": { "type": "number", "minimum": 0 },
                    "per100g": { "type": "object" },
                    "note": { "type": "string", "maxLength": 1000 },
                    "gramsAs": { "type": "string", "enum": ["raw", "cooked"] },
                    "state": { "type": "string", "enum": ["raw", "cooked", "dry", "rehydrated", "none"] },
                    "weightSource": { "type": "string", "enum": ["weighed", "counted", "guessed"] },
                    "macroSource": { "type": "string", "enum": ["label", "usda", "recipe", "estimated"] }
                }), &[])
            }
        }),
        &["meal", "entries"],
    );
    let history_scope = object(
        json!({
            "foodIds": { "type": "array", "maxItems": 200, "items": { "type": "integer", "minimum": 1 } },
            "entryIds": { "type": "array", "maxItems": 500, "items": { "type": "integer", "minimum": 1 } },
            "fromDay": day_prop(), "toDay": day_prop(),
            "previewHash": { "type": "string", "maxLength": 128 }
        }),
        &[],
    );
    let recipe = object(
        json!({
            "name": { "type": "string", "maxLength": 200 },
            "servingsTotal": { "type": "integer", "minimum": 1, "maximum": 100 },
            "note": { "type": "string" },
            "ingredients": { "type": "array", "maxItems": 100, "items": { "type": "object" } }
        }),
        &["name"],
    );
    let supplement = object(
        json!({
            "id": { "type": "integer", "minimum": 1 },
            "name": { "type": "string" }, "dose": { "type": "number" }, "unit": { "type": "string" },
            "schedule": { "type": "object" }, "nutrients": { "type": "object" }, "active": { "type": "boolean" }
        }),
        &[],
    );
    let simple_day = |description: &'static str| tool("", description, day.clone(), true, false);
    let _ = simple_day;

    let mut out = vec![
        tool(
            "healthvault_context",
            "Everything HealthVault knows before answering: profile, timezone, today's nutrition, trends, supplements, strength, workouts and data freshness.",
            no_input.clone(),
            true,
            false,
        ),
        tool(
            "profile_get",
            "Read profile, age, work schedule, training goal, whey link and suggested nutrition targets.",
            no_input.clone(),
            true,
            false,
        ),
        tool(
            "profile_update",
            "Update profile fields. Omitted fields are unchanged.",
            object(
                json!({
                    "name": { "type": "string" }, "birthDate": day_prop(), "sex": { "type": "string" },
                    "heightCm": { "type": "number" }, "timezone": { "type": "string" }, "units": { "type": "string" },
                    "goalWeightKg": { "type": "number" }, "goalsNote": { "type": "string" },
                    "goal": { "type": "object" }, "wheyLink": { "type": "object" }
                }),
                &[],
            ),
            false,
            false,
        ),
        tool(
            "measurement_add",
            "Add a manual body measurement. Apple measurements are never copied into this table.",
            object(
                json!({
                    "kind": { "type": "string", "enum": ["weight", "bodyFat", "waist"] },
                    "value": { "type": "number", "minimum": 0 }, "unit": { "type": "string" },
                    "day": day_prop(), "takenAt": { "type": ["string", "number"] }, "note": { "type": "string" }
                }),
                &["kind", "value"],
            ),
            false,
            false,
        ),
        tool(
            "measurement_history",
            "Measurement history for a kind.",
            day_kind.clone(),
            true,
            false,
        ),
        tool(
            "food_search",
            "Search saved foods by name or brand.",
            object(
                json!({ "query": { "type": "string" }, "limit": { "type": "integer", "maximum": 100 } }),
                &[],
            ),
            true,
            false,
        ),
        tool(
            "food_add",
            "Add a reusable food with per-100 g macros and provenance.",
            text.clone(),
            false,
            false,
        ),
        tool(
            "meal_log",
            "Log one or more immutable food snapshots.",
            meal_entries.clone(),
            false,
            false,
        ),
        tool(
            "meal_update",
            "Update a logged entry from its stored snapshot.",
            object(
                json!({
                    "id": { "type": "integer", "minimum": 1 }, "grams": { "type": "number", "minimum": 0.1 },
                    "servingFraction": { "type": "number", "minimum": 0.01 }, "note": { "type": "string" },
                    "meal": { "type": "string" }, "day": day_prop()
                }),
                &["id"],
            ),
            false,
            false,
        ),
        tool(
            "meal_delete",
            "Delete a logged entry and its snapshot rows.",
            id.clone(),
            false,
            true,
        ),
        tool(
            "nutrition_day",
            "One day's nutrition totals with targets and remaining.",
            day.clone(),
            true,
            false,
        ),
        tool(
            "nutrition_summary",
            "Nutrition totals for a range of days.",
            object(
                json!({ "days": { "type": "integer", "minimum": 1, "maximum": 365 }, "endDay": day_prop() }),
                &[],
            ),
            true,
            false,
        ),
        tool(
            "nutrition_target_set",
            "Set effective-dated nutrition goals; partial updates preserve other fields.",
            object(
                json!({
                    "effectiveFrom": day_prop(), "kcal": { "type": "number" }, "proteinG": { "type": "number" },
                    "carbsG": { "type": "number" }, "fatG": { "type": "number" }, "fibreG": { "type": "number" }, "sodiumMg": { "type": "number" }
                }),
                &[],
            ),
            false,
            false,
        ),
        tool(
            "supplement_list",
            "List supplements with today's adherence.",
            no_input.clone(),
            true,
            false,
        ),
        tool(
            "supplement_create",
            "Create a supplement.",
            supplement.clone(),
            false,
            false,
        ),
        tool(
            "supplement_update",
            "Update a supplement.",
            supplement.clone(),
            false,
            false,
        ),
        tool(
            "supplement_log",
            "Log a supplement dose for a day.",
            object(
                json!({
                    "id": { "type": "integer", "minimum": 1 }, "day": day_prop(), "dose": { "type": "number" }, "note": { "type": "string" }
                }),
                &["id"],
            ),
            false,
            false,
        ),
        tool(
            "metrics_series",
            "Single-source-per-day Apple metric series.",
            object(
                json!({
                    "metric": { "type": "string" }, "days": { "type": "integer", "minimum": 1, "maximum": 3650 }
                }),
                &["metric"],
            ),
            true,
            false,
        ),
        tool(
            "workouts_recent",
            "Newest deduped workout sessions.",
            object(
                json!({ "limit": { "type": "integer", "maximum": 500 } }),
                &[],
            ),
            true,
            false,
        ),
        tool(
            "measurement_delete",
            "Delete a manual measurement.",
            id.clone(),
            false,
            true,
        ),
        tool(
            "food_delete",
            "Archive or delete an unused food.",
            id.clone(),
            false,
            true,
        ),
        tool(
            "copy_day",
            "Copy all meals from one day to another.",
            object(
                json!({ "fromDay": day_prop(), "toDay": day_prop() }),
                &["fromDay", "toDay"],
            ),
            false,
            false,
        ),
        tool(
            "record_types",
            "Apple record type statistics.",
            no_input.clone(),
            true,
            false,
        ),
        tool(
            "records_recent",
            "Recent raw Apple records of a type.",
            object(
                json!({ "type": { "type": "string" }, "limit": { "type": "integer", "maximum": 500 } }),
                &["type"],
            ),
            true,
            false,
        ),
        tool(
            "uploads_recent",
            "Recent import jobs.",
            object(
                json!({ "limit": { "type": "integer", "maximum": 100 } }),
                &[],
            ),
            true,
            false,
        ),
        tool(
            "supplement_history",
            "Supplement dose history.",
            day.clone(),
            true,
            false,
        ),
        tool(
            "supplement_delete",
            "Delete a supplement and its logs.",
            id.clone(),
            false,
            true,
        ),
        tool(
            "recipe_create",
            "Create a composite recipe from foods.",
            recipe.clone(),
            false,
            false,
        ),
        tool(
            "recipe_get",
            "Read a recipe with resolved ingredient nutrition.",
            id.clone(),
            true,
            false,
        ),
        tool(
            "recipe_log",
            "Log one serving of a recipe as immutable snapshots.",
            object(
                json!({
                    "recipeId": { "type": "integer", "minimum": 1 }, "day": day_prop(),
                    "meal": { "type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"] },
                    "servingFraction": { "type": "number", "minimum": 0.01, "maximum": 100 },
                    "amountBasis": { "type": "string", "enum": ["batch", "serving"] },
                    "ingredientOverrides": { "type": "array", "maxItems": 100, "items": { "type": "object" } }
                }),
                &["recipeId", "meal"],
            ),
            false,
            false,
        ),
        tool(
            "recipe_update",
            "Update a recipe definition; history stays untouched.",
            recipe.clone(),
            false,
            false,
        ),
        tool(
            "recipe_delete",
            "Delete or archive a recipe with logged history.",
            id.clone(),
            false,
            true,
        ),
        tool(
            "food_template_list",
            "List reusable food templates.",
            no_input.clone(),
            true,
            false,
        ),
        tool(
            "food_template_apply",
            "Apply a food template to entries.",
            object(
                json!({
                    "templateId": { "type": "string" }, "entries": { "type": "array", "items": { "type": "object" } }
                }),
                &["templateId"],
            ),
            false,
            false,
        ),
        tool(
            "meal_get",
            "Read one logged entry with its ingredient snapshots.",
            id.clone(),
            true,
            false,
        ),
        tool(
            "food_history_preview",
            "Preview a scoped past-meal correction. Read-only; returns previewHash.",
            history_scope.clone(),
            true,
            false,
        ),
        tool(
            "food_history_refresh",
            "Apply a previewed correction. Requires the exact previewHash.",
            history_scope.clone(),
            false,
            false,
        ),
        tool(
            "recipe_list",
            "List recipes, optionally including archived ones.",
            object(json!({ "includeArchived": { "type": "boolean" } }), &[]),
            true,
            false,
        ),
    ];
    debug_assert_eq!(out.len(), AGENT_TOOLS.len());
    // The registry follows the frozen contract order; sort to make discovery deterministic.
    out.sort_unstable_by_key(|definition| definition.name);
    out
}

pub fn find(name: &str) -> Option<ToolDefinition> {
    definitions()
        .into_iter()
        .find(|definition| definition.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_matches_the_frozen_contract_exactly() {
        let registered: Vec<&str> = definitions()
            .iter()
            .map(|definition: &ToolDefinition| definition.name)
            .collect();
        let mut expected = AGENT_TOOLS.to_vec();
        expected.sort_unstable();
        assert_eq!(registered, expected);
    }

    #[test]
    fn upload_is_not_discoverable() {
        assert!(find("upload").is_none());
    }
}
