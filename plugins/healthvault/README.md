# @healthvault/mcp

An MCP stdio server for HealthVault. It exposes the same 27 tools the app's
`POST /api/agent/<tool>` endpoint serves — context, profile, measurements, foods,
meals, nutrition, supplements, and Apple Health reads — to any MCP harness
(OpenCode, Claude Code, Claude Desktop, Cursor, …). It replaces the OpenCode-only
plugin in `plugins/opencodev2`.

## Install

```bash
bun install -g /home/tunitz/projects/healthvault/plugins/healthvault
```

That links the `healthvault-mcp` command. Bun runs the TypeScript entry directly;
no build step is needed.

## Token

The app requires a bearer token on `/api/agent/*`. Put it in the default token
file:

```bash
mkdir -p ~/.config/healthvault
printf '%s' '<token>' > ~/.config/healthvault/token
chmod 600 ~/.config/healthvault/token
```

Overrides:

- `HEALTHVAULT_TOKEN` — use this token instead of the file.
- `HEALTHVAULT_TOKEN_FILE` — read the token from another path (`~` is expanded).
- `HEALTHVAULT_URL` — base URL of the app (default `http://127.0.0.1:3040`,
  e.g. `http://healthvault.lan:3040` for a remote instance).

A missing token does not stop the server: `tools/list` still works and each tool
call fails with a message saying where to put the token. Restart the MCP client
after changing `HEALTHVAULT_TOKEN`.

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

## Without MCP

Any client that can send HTTP can use the same surface:

```bash
curl -sS http://127.0.0.1:3040/api/agent/healthvault_context \
  -H "authorization: Bearer $(cat ~/.config/healthvault/token)" \
  -H 'content-type: application/json' \
  -d '{}'
```

Every tool is `POST /api/agent/<tool>` with a JSON object body; responses are
`{ "ok": true, "result": ... }` (or `{ "ok": false, "error": "..." }`).
`GET /api/agent` lists the tool names.
