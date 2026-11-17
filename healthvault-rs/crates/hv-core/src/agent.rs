//! The frozen 38-tool agent contract, shared by discovery, dispatch, MCP and tests.
//! Ported verbatim from `src/lib/agent-tools.ts`.

pub const AGENT_TOOLS: [&str; 38] = [
    "healthvault_context",
    "profile_get",
    "profile_update",
    "measurement_add",
    "measurement_history",
    "food_search",
    "food_add",
    "meal_log",
    "meal_update",
    "meal_delete",
    "nutrition_day",
    "nutrition_summary",
    "nutrition_target_set",
    "supplement_list",
    "supplement_create",
    "supplement_update",
    "supplement_log",
    "metrics_series",
    "workouts_recent",
    "measurement_delete",
    "food_delete",
    "copy_day",
    "record_types",
    "records_recent",
    "uploads_recent",
    "supplement_history",
    "supplement_delete",
    "recipe_create",
    "recipe_get",
    "recipe_log",
    "recipe_update",
    "recipe_delete",
    "food_template_list",
    "food_template_apply",
    "meal_get",
    "food_history_preview",
    "food_history_refresh",
    "recipe_list",
];

/// `upload` is deliberately NOT an agent tool: ingest remains an explicit local action.
pub fn is_agent_tool(name: &str) -> bool {
    AGENT_TOOLS.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_has_exactly_38_unique_tools() {
        assert_eq!(AGENT_TOOLS.len(), 38);
        let mut sorted = AGENT_TOOLS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 38);
    }

    #[test]
    fn upload_is_not_exposed_to_agents() {
        assert!(!is_agent_tool("upload"));
        assert!(is_agent_tool("healthvault_context"));
    }
}
