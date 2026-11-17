# ADR 0003: MCP transport — in-process first, HTTP compatibility retained

- Status: accepted (2026-11-17)
- Context: `plugins/healthvault` speaks HTTP to `127.0.0.1:3040` with a bearer token; the 38-tool
  contract is model-facing and must not drift. The Rust desktop app has direct local storage.
- Decision: implement one dispatcher (`hv-api::dispatch`) used by both (a) `hv-mcp`, a Rust stdio
  JSON-RPC server that runs tools in-process against the local database, and (b) `hv-server`, an
  Axum compatibility service preserving `/api/agent`, `/api/agent/{tool}`, `/api/health`,
  login/logout, and the host/origin/session/bearer gate. The dispatcher test enumerates all 38
  tools, so a tool present in discovery but missing from dispatch fails CI.
- Consequences: existing MCP clients can move to in-process transport without changing tool names;
  other clients keep the HTTP contract. `upload` remains excluded from the agent surface.
