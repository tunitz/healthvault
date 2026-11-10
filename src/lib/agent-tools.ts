/** The agent tool surface, shared by the dispatcher and the discovery endpoint. */
export const AGENT_TOOLS = [
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
] as const;

export type AgentTool = (typeof AGENT_TOOLS)[number];
