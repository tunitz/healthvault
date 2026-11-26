# @healthvault/mcp

An MCP stdio server for HealthVault. It exposes the same 53 tools (plus MCP
resources and prompts) that the app's `POST /api/agent/<tool>` and direct
Streamable HTTP `POST /api/mcp` endpoints serve — context, profile,
measurements, foods, meals, recipes, ingredient snapshots, scoped history
refresh, nutrition, supplements, one-tap whey, 16-week training block, strength
logging, analytics (`weekly_summary`, `five_k_progress`, `sleep_stages`,
`supplement_adherence`, `recipe_preview`), and Apple Health reads — to any MCP
harness (OpenCode, Claude Code, Claude Desktop, Cursor, …).

## Install

From the HealthVault repository root:

```bash
bun install -g ./plugins/healthvault
```

That links the `healthvault-mcp` command. Bun runs the TypeScript entry directly;
no build step is needed.

## Direct Streamable HTTP transport (`POST /api/mcp`)

HealthVault also serves MCP natively over HTTP at `POST /api/mcp` (JSON-RPC 2.0,
supporting both single and batch requests, compact JSON responses with
`structuredContent`, plus `resources/list`, `resources/read`, `prompts/list`,
and `prompts/get`).

- Manage MCP enablement, LAN access, and token rotation directly in the web UI
  under **Settings → MCP** (`/settings/mcp`).
- Local loopback connections are allowed by default when MCP is enabled; for
  remote / LAN / Tailscale clients, enable **Allow LAN access** in Settings → MCP
  (and set `HEALTHVAULT_TRUST_PROXY=1` when behind a reverse proxy).
- Send `Authorization: Bearer <token>` and `Content-Type: application/json`.

## MCP Resources & Prompts

- **Resources:** `healthvault://context`, `healthvault://profile`,
  `healthvault://nutrition/today`, `healthvault://training/block`
- **Prompts:** `daily_checkin`, `weekly_training_review`, `meal_audit`

## Configuration

The agent API requires a bearer token (or a web session). Use the same private token file created by
`bun run password:set`, and make sure the MCP process can read it:

```bash
export HEALTHVAULT_TOKEN_FILE="$HOME/.config/healthvault/agent.token"
```

Alternatively, set `HEALTHVAULT_TOKEN` in the MCP process environment. Never put the token value in
source control. The app also checks `HEALTHVAULT_ALLOWED_HOSTS`; configure its exact hostname/IP in
the app credentials file (default is loopback only). Overrides:

- `HEALTHVAULT_URL` — base URL of the app (default `http://127.0.0.1:3040`,
  e.g. `http://healthvault.lan:3040` for a remote instance).
- `HEALTHVAULT_TIMEOUT_MS` — per-request timeout (default 15000).

The bearer token is sent in an Authorization header to the configured app URL. Keep the service on
a trusted LAN or use TLS for remote access. A supplied browser Origin must match the request origin,
and unlisted Host values are rejected by the app, including DNS-rebinding hostnames.

## Harness setup

OpenCode V2 (`mcp` block; set `codemode` to `false` where the harness supports it
so tool calls are not routed through the code-mode sandbox):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "healthvault": {
        "type": "local",
        "command": ["healthvault-mcp"],
        "environment": {
          "HEALTHVAULT_TOKEN_FILE": "~/.config/healthvault/agent.token"
        },
        "codemode": false
      }
    }
  }
}
```

Claude Code (export the token-file setting in the environment that launches Claude Code):

```bash
export HEALTHVAULT_TOKEN_FILE="$HOME/.config/healthvault/agent.token"
claude mcp add healthvault --scope user -- healthvault-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "healthvault": {
      "command": "healthvault-mcp",
      "env": { "HEALTHVAULT_TOKEN_FILE": "/home/you/.config/healthvault/agent.token" }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`, same shape):

```json
{
  "mcpServers": {
    "healthvault": {
      "command": "healthvault-mcp",
      "env": { "HEALTHVAULT_TOKEN_FILE": "/home/you/.config/healthvault/agent.token" }
    }
  }
}
```

## Ingredient snapshots and history refresh

`healthvault_recipe_list` searches the recipe library read-only (`query`, `limit` default 20 / max
100, `includeArchived` default false). It returns each recipe's id, name, servings, `archived` and
`complete`/`unresolvedCount`, which is enough to pick one and see whether its nutrition is known;
call `healthvault_recipe_get` for the computed total and per-serving macros. Archived recipes stay
out of the list unless asked for.

`healthvault_meal_get` returns one logged entry with its full per-ingredient snapshot.
`healthvault_recipe_log` accepts `ingredientOverrides` plus a required `amountBasis`
(`"batch"` for the whole recipe or `"serving"` for one serving); overrides change that meal only.
`healthvault_recipe_delete` archives a recipe that has logged history instead of destroying it.

When a saved food's nutrition changes, call `healthvault_food_history_preview` with
`foodIds` and/or `entryIds` (and optional `fromDay`/`toDay`). It is read-only and returns a
`previewHash`; `healthvault_food_history_refresh` requires that exact hash and applies only the
previewed rows, keeping a revision with the previous values. A stale preview is rejected with 409,
and a scope over 500 snapshots is rejected before any write. Rows whose food is missing, whose per-
100 g basis state changed, or whose yield factor changed while a weighed-state conversion was in
play are skipped (`yield_changed`), never guessed. Existing `estimated`/manual provenance is
preserved. Legacy aggregate-only recipe rows are surfaced as skipped when explicitly scoped and are
reported as incomplete by `meal_get`/`nutrition_day`; a truncated child snapshot is incomplete too.

Explicit macro edits on a recipe entry that has child snapshots are rejected with 409, and
`servingFraction`/`servingNo` combined with macros is rejected, so parent and children cannot
desync.

## Without MCP

Any client that can send HTTP can use the same surface:

```bash
curl -sS http://127.0.0.1:3040/api/agent/healthvault_context \
  -H "Authorization: Bearer $HEALTHVAULT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{}'
```

Every tool is `POST /api/agent/<tool>` with a JSON object body; responses are
`{ "ok": true, "tool": "<tool>", "result": ... }` (or
`{ "ok": false, "tool": "<tool>", "error": "..." }`).
`GET /api/agent` lists all 53 tool names.
