# ADR 0001: Native-first with a framework-free core

- Status: accepted (2026-11-17)
- Context: the audit target is Rust + GPUI Kit + WebAssembly. GPUI Kit is a native desktop
  framework; the current product is serverful and persists health data in a local SQLite file.
- Decision: build a Cargo workspace with a pure `hv-core` (no IO, UI, async or HTTP framework),
  `hv-storage` (SQLite + migration compatibility), `hv-ingest` (streaming Apple export),
  `hv-api` (services, auth policy, tool registry), and thin shells: `hv-app-gpui` (primary UX),
  `hv-server` (MCP/HTTP compatibility), `hv-mcp` (stdio), `hv-migrate` (ops), `hv-wasm` (portable core
  surface). A UI framework major bump must only touch `hv-app-gpui`.
- Consequences: the desktop app is the primary experience; the web/WASM path is core-only until
  ADR 0002 is resolved. The existing Next.js app and `data/` are untouched by this branch.
