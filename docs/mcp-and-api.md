# Agent API & MCP Reference

HealthVault exposes **53 tools**, **4 MCP resources**, and **3 MCP prompts** through three equivalent transports:

1. **Stdio MCP Server** (`plugins/healthvault/`): `healthvault-mcp` for OpenCode, Claude Code, Claude Desktop, Cursor, and any MCP client. See [plugins/healthvault/README.md](../plugins/healthvault/README.md) for per-client configuration.
2. **Direct Streamable HTTP MCP** (`POST /api/mcp`): JSON-RPC 2.0 (single and batch requests) returning compact JSON with `structuredContent`.
3. **REST Tool Endpoint** (`GET /api/agent`, `POST /api/agent/<tool>`): Returns `{ ok: true, tool, result }` or `{ ok: false, tool, error }`.

## Authentication & Network Gating

- **No unauthenticated access**: Machine clients pass `Authorization: Bearer <token>`; same-origin browser sessions are also accepted.
- **Host & Origin validation**: Requests must match `HEALTHVAULT_ALLOWED_HOSTS` (exact comma-separated hostnames/IPs, default loopback only). Any supplied `Origin` must match the request scheme and host.
- **Settings → MCP gates** (`/settings/mcp`):
  - **MCP enabled** (`mcp.enabled`, default on): disables `/api/agent/*` and `/api/mcp` with `403` when turned off.
  - **Allow LAN access** (`mcp.lanEnabled`, default off): rejects non-loopback peers with `403` unless explicitly enabled. Set `HEALTHVAULT_TRUST_PROXY=1` behind a trusted reverse proxy so `X-Forwarded-For` leftmost-hop detection works accurately.
- **Manual import boundary**: `/api/upload` is deliberately **not** exposed to agents; importing an `Export.zip` remains a manual UI action, while `uploads_recent` reports import history.

## Tool Inventory (53 Tools)

- **Reads (26)**
  - `healthvault_context` (accepts `sections`: `today`, `profile`, `nutrition`, `weight`, `supplements`, `training`, `data`)
  - `profile_get`, `measurement_history`
  - `food_search` (paginated with `offset`), `food_template_list`, `food_history_preview`
  - `nutrition_day`, `nutrition_summary`, `meal_get`
  - `recipe_list` (with `offset` & completeness flags), `recipe_get`, `recipe_preview`
  - `supplement_list`, `supplement_history`, `supplement_adherence`
  - `metrics_series`, `workouts_recent`, `record_types`, `records_recent`, `uploads_recent`
  - `training_block_get`, `strength_history`, `strength_progression`, `weekly_summary`, `five_k_progress`, `sleep_stages`
- **Writes (21)**
  - `profile_update`, `measurement_add`
  - `food_add`, `food_update`, `food_template_apply`, `food_history_refresh`
  - `meal_log`, `meal_update`, `nutrition_target_set`, `copy_day`
  - `recipe_create`, `recipe_update`, `recipe_log`
  - `supplement_create`, `supplement_update`, `supplement_log` (single item or atomic `entries` batch)
  - `whey_log`, `whey_undo`
  - `training_block_start`, `training_session_status`, `strength_log`
- **Deletes (6)**
  - `measurement_delete` (manual rows only; Apple `BodyMass` is immutable)
  - `food_delete` (returns `409` if referenced by a logged meal or recipe)
  - `meal_delete` (deletes child ingredient and revision rows atomically)
  - `supplement_delete` (archives when history exists; hard-deletes otherwise)
  - `recipe_delete` (archives when logged history exists; deletes otherwise)
  - `strength_delete`

## MCP Resources & Prompts

- **Resources**: `healthvault://context`, `healthvault://profile`, `healthvault://nutrition/today`, `healthvault://training/block`
- **Prompts**: `daily_checkin`, `weekly_training_review`, `meal_audit`

## Data Integrity Contracts

- **Single-source-per-day (`metrics_series` vs `records_recent`)**: `records_recent` returns raw rows (default 50, max 500) without phone/watch deduplication. Always use `metrics_series` for daily totals or trends.
- **Opt-in food templates**: `food_template_list` and `food_template_apply` manage household-measure weights and raw/cooked/dry yield factors without inventing nutrition values. Existing overrides and custom yield bases are preserved unless `{"overwrite": true}` is passed.
- **Immutable ingredient snapshots & overrides**: Every `recipe_log` writes per-ingredient snapshot rows in `food_log_ingredients` (cross-stack contract in [ingredient-snapshots-handoff.md](ingredient-snapshots-handoff.md)). `ingredientOverrides` require `amountBasis` (`"batch"` or `"serving"`). Editing or archiving a recipe never rewrites historical logs.
- **Scoped history refresh**: When a saved food's macros change, `food_history_preview` computes affected snapshots and a `previewHash`; `food_history_refresh` requires that exact hash and a bounded scope (`foodIds` / `entryIds`, max 500 snapshots), writing audit rows to `food_log_revisions`.
- **Training & one-tap whey**: `planned_sessions` and `strength_sets` never inflate Apple Health workout totals or calorie budgets. `whey_log` / `whey_undo` update `food_log` and `supplement_logs` in one atomic transaction.
