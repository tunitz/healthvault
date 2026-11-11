# @healthvault/mcp

An MCP stdio server for HealthVault. It exposes the same 37 tools the app's
`POST /api/agent/<tool>` endpoint serves — context, profile, measurements, foods,
meals, recipes, ingredient snapshots, scoped history refresh, nutrition,
supplements, and Apple Health reads — to any MCP harness
(OpenCode, Claude Code, Claude Desktop, Cursor, …). It replaces the OpenCode-only
plugin in `plugins/opencodev2`.

## Install

```bash
bun install -g /home/tunitz/projects/healthvault/plugins/healthvault
```

That links the `healthvault-mcp` command. Bun runs the TypeScript entry directly;
no build step is needed.

## Configuration

The agent API takes no token: point the client at the app and it works. Overrides:

- `HEALTHVAULT_URL` — base URL of the app (default `http://127.0.0.1:3040`,
  e.g. `http://healthvault.lan:3040` for a remote instance).
- `HEALTHVAULT_TIMEOUT_MS` — per-request timeout (default 15000).

`HEALTHVAULT_TOKEN` / `HEALTHVAULT_TOKEN_FILE` are ignored if still set: no
token is sent.

The endpoint is credential-less by design, so any host that can reach the app
can read and write the tool surface. Keep it on a trusted LAN; do not expose
port 3040 to the internet. A trusted LAN is not a browser boundary: with no
Host/Origin allowlist, DNS rebinding can make a malicious page same-origin with
the LAN address and call this API. That needs a fronting proxy with an allowlist
(not implemented here).

### Upgrading from a token build

Update the **server first**: rebuild/restart the app, then install and restart
this client. The old app build still requires a bearer token and this client
sends none, so calls return 401 until the server is the new build. Rollback is
the mirror image — restart the old server before reverting this client.

## Harness setup

OpenCode V2 (`mcp` block; set `codemode` to `false` where the harness supports it
so tool calls are not routed through the code-mode sandbox):

```json
{
  "mcp": {
    "healthvault": {
      "type": "local",
      "command": ["healthvault-mcp"],
      "enabled": true
    }
  }
}
```

Claude Code:

```bash
claude mcp add healthvault --scope user -- healthvault-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "healthvault": { "command": "healthvault-mcp" }
  }
}
```

Cursor (`~/.cursor/mcp.json`, same shape):

```json
{
  "mcpServers": {
    "healthvault": { "command": "healthvault-mcp" }
  }
}
```

## Ingredient snapshots and history refresh

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
  -H 'content-type: application/json' \
  -d '{}'
```

Every tool is `POST /api/agent/<tool>` with a JSON object body; responses are
`{ "ok": true, "result": ... }` (or `{ "ok": false, "error": "..." }`).
`GET /api/agent` lists the tool names.
