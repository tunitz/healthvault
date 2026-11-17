//! One dispatcher shared by compat HTTP and the Rust MCP stdio server.

use serde_json::{Map, Value, json};

use crate::error::ApiError;
use crate::service::Service;
use crate::tools;

pub fn dispatch(service: &Service, name: &str, input: Value) -> Result<Value, ApiError> {
    let tool = tools::find(name).ok_or_else(|| ApiError::ToolNotFound(name.to_owned()))?;
    let object = match input {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        _ => {
            return Err(ApiError::InvalidInput(
                "tool input must be an object".into(),
            ));
        }
    };
    let result = match tool.name {
        "healthvault_context" => service.health_context()?,
        "profile_get" => service.profile_get()?,
        "profile_update" => service.profile_update(&object)?,
        "measurement_add" => service.measurement_add(&object)?,
        "measurement_history" => service.measurement_history(&object)?,
        "measurement_delete" => service.measurement_delete(&object)?,
        "food_search" => service.food_search(&object)?,
        "food_add" => service.food_add(&object)?,
        "food_delete" => service.food_delete(&object)?,
        "food_template_list" => service.food_template_list()?,
        "food_template_apply" => service.food_template_apply(&object)?,
        "meal_log" => service.meal_log(&object)?,
        "meal_get" => service.meal_get(&object)?,
        "meal_update" => service.meal_update(&object)?,
        "meal_delete" => service.meal_delete(&object)?,
        "nutrition_day" => service.nutrition_day(&object)?,
        "nutrition_summary" => service.nutrition_summary(&object)?,
        "nutrition_target_set" => service.nutrition_target_set(&object)?,
        "copy_day" => service.copy_day(&object)?,
        "supplement_list" => service.supplement_list()?,
        "supplement_create" => service.supplement_create(&object)?,
        "supplement_update" => service.supplement_update(&object)?,
        "supplement_log" => service.supplement_log(&object)?,
        "supplement_history" => service.supplement_history(&object)?,
        "supplement_delete" => service.supplement_delete(&object)?,
        "metrics_series" => service.metrics_series(&object)?,
        "workouts_recent" => service.workouts_recent(&object)?,
        "record_types" => service.record_types()?,
        "records_recent" => service.records_recent(&object)?,
        "uploads_recent" => service.uploads_recent(&object)?,
        "recipe_create" => service.recipe_create(&object)?,
        "recipe_get" => service.recipe_get(&object)?,
        "recipe_log" => service.recipe_log(&object)?,
        "recipe_update" => service.recipe_update(&object)?,
        "recipe_delete" => service.recipe_delete(&object)?,
        "recipe_list" => service.recipe_list(&object)?,
        "food_history_preview" => service.history_preview(&object)?,
        "food_history_refresh" => service.history_refresh(&object)?,
        // A tool declared in the registry but missing here is a bug; the test below enumerates
        // all 38 names so this arm is never a silent path.
        _ => return Err(ApiError::ToolNotFound(name.to_owned())),
    };
    Ok(result)
}

pub fn discovery() -> Value {
    json!({ "tools": tools::definitions().into_iter().map(|tool| json!({
        "name": format!("healthvault_{}", tool.name),
        "description": tool.description,
        "inputSchema": tool.input_schema,
        "annotations": { "readOnlyHint": tool.read_only, "destructiveHint": tool.destructive },
    })).collect::<Vec<_>>() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hv_storage::StoreHandle;

    #[test]
    fn every_registered_tool_dispatches_or_returns_a_domain_error() {
        let service = Service::new(StoreHandle::in_memory().unwrap());
        for tool in tools::definitions() {
            let result = dispatch(&service, tool.name, json!({}));
            // Missing required input is fine; a missing dispatch arm would be ToolNotFound.
            assert!(
                !matches!(result, Err(ApiError::ToolNotFound(_))),
                "{} is not dispatched",
                tool.name
            );
        }
    }

    #[test]
    fn discovery_exposes_38_tools() {
        assert_eq!(discovery()["tools"].as_array().map_or(0, Vec::len), 38);
    }
}
