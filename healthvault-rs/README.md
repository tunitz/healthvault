# HealthVault — Rust / GPUI Kit / WASM rewrite

Feature branch: `feat/rust-gpui-wasm-rewrite`. **This workspace is additive**: the Next.js app,
its SQLite database under `../data/`, and the MCP plugin are unchanged by this branch.

## What is implemented

| Crate | Status | What it does |
| --- | --- | --- |
| `hv-core` | implemented, tested | Day/timezone rules (DST-safe), macro math, basis/yield conversion, workout dedupe + single-source-per-day, 5K rules, history preview hashing, 38-tool name contract |
| `hv-storage` | implemented, tested | Drizzle 0000–0006 SQL port, `user_version` migrations with verified Drizzle baseline adoption, cross-process `BEGIN IMMEDIATE` lock, single-writer actor, WAL-safe backup |
| `hv-ingest` | implemented, tested | Streaming zip/XML parser with the TS normalization rules, bounded batches, dedupe, upload accounting, import coordinator |
| `hv-api` | implemented, tested | Auth policy (scrypt/HMAC/bearer/host-origin, CIDR allowlist), 38-tool registry + dispatcher, service handlers, plus UI workflows for whey log/undo, strength sets and the 16-week plan |
| `hv-server` | implemented, tested | Axum compatibility HTTP service, same auth gate and `no-store`/logout headers |
| `hv-mcp` | implemented, tested | Rust stdio JSON-RPC server, tool names/schemas shared with the dispatcher |
| `hv-app-gpui` | implemented, tested | GPUI Kit sidebar workspace with Today/Foods/Recipes/Training/Supplements/Explorer/Profile sections, search, refresh, whey log/undo, plan start and backup actions, native chart, and a headless UI integration test |
| `hv-wasm` | compiles to `wasm32-unknown-unknown` | Core-only computational surface (day windows, macros, basis conversion, snapshot rescale, sleep nights, 5K, history hash, workout dedupe) |
| `hv-migrate` | implemented, tested | Read-only verification, WAL-safe backup, and dual-run `compare` of two database copies; refuses live data paths |

Fixtures are generated from the current TypeScript source with
`bun healthvault-rs/fixtures/generate-golden.ts` and consumed by Rust golden tests. No live data
is read to generate them.

## Gates

```bash
cd healthvault-rs
bash ci/gates.sh
```

Runs toolchain assertion, `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`,
all tests, and a `wasm32-unknown-unknown` check. GPUI needs `libxkbcommon-x11-dev` on Linux
(CI installs it; this repo ships a local stub symlink for hosts with only the runtime `.so`).

## Commands

```bash
cargo run -p hv-server       # compatibility HTTP on 127.0.0.1:3040 by default
cargo run -p hv-mcp          # stdio MCP server (in-process tools)
cargo run -p hv-app-gpui     # native desktop app
cargo run -p hv-migrate -- verify --path /path/to/copy.db
```

Set `DATABASE_PATH` to an explicit copy for local runs. `HEALTHVAULT_PASSWORD_HASH`,
`HEALTHVAULT_SESSION_SECRET` and optionally `HEALTHVAULT_TOKEN[_FILE]` are required by the
service profile; the app profile relies on OS file permissions.

## Known gaps (honest status)

- The GPUI shell exposes real data and primary actions but still shows most edit surfaces as
  structured JSON rather than dedicated forms; import UX and a restore UI are not yet built into
  the desktop window (use `hv-migrate backup` and the HTTP API for now).
- Some domain tools have simpler write paths than the TypeScript services (notably recipe
  ingredient overrides, per-ingredient correction editing, and the full 16-week template detail).
- Browser storage is explicitly spike-gated (ADR 0002); only `hv-core` is exposed to WASM.
- Dual-run cutover, production migration sign-off and live MCP end-to-end testing remain phase-7
  work. No live HTTP smoke test against the user's service was performed on this branch.
- Coverage threshold and `cargo deny check` are declared policy but not yet installed in CI.

See `docs/adr/` for the architecture, storage, MCP, security and charting decisions.

## Phase 7 cutover runbook

1. Snapshot the live database with the SQLite online backup API (never a file copy):
   `python3 -c "import sqlite3; sqlite3.connect('file:./data/health.db?mode=ro', uri=True).backup(sqlite3.connect('/tmp/hv-cutover.db'))"`.
2. Verify the copy: `cargo run -p hv-migrate -- verify --path /tmp/hv-cutover.db`.
3. Run the Rust service against the copy (`DATABASE_PATH=/tmp/hv-cutover.db`) and replay the
   agent contract with `hv-mcp` / `/api/agent`; compare with the old service's outputs.
4. Compare copies after dual-run:
   `cargo run -p hv-migrate -- compare --a /tmp/hv-ts-copy.db --b /tmp/hv-rs-test.db`.
   A real-data comparison on this branch returned `different: []` for counts, sums, last day and
   integrity across 1,068,889 records, 182 workouts and 77 food-log entries.
5. Only after signoff, swap binaries behind the existing port and keep the last-known-good
   backup plus the previous binary for rollback. Never migrate the live file on a first run.

## GPUI web build

The same GPUI app also builds for the browser:

```bash
# one-time prerequisites (user-local)
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
# clang is needed for sqlite-wasm-rs; CI installs the dev package, this host uses /tmp/clang-root

bash ci/build-web.sh
HEALTHVAULT_WEB_DIR=$PWD/web cargo run -p hv-server
```

Open `http://<host>:3041/hv-web/login.html`, sign in with the app password, and the GPUI canvas
loads from the same origin using the session cookie. The browser build uses `hv-server` as its
data source because local SQLite is not usable in WASM here; writes are native-only for now.
