# ADR 0002: WASM storage is spike-gated, not assumed

- Status: decision deferred; evidence gathered and expanded 2026-11-17
- Context: browser storage cannot run the current SQLite schema directly. A SQLite-WASM build with
  durable storage, an IndexedDB adapter, and a server-backed thin client all have different
  transaction, migration and streaming semantics.
- Evidence from this branch: `hv-core`, `hv-wasm` (day rules, macro math, history hashing,
  workout dedupe) compile to `wasm32-unknown-unknown`. `hv-storage`, `hv-ingest` and `hv-api` do not.
- Decision: ship `hv-wasm` as a computational surface only for now. No claim of full WASM parity.
  Before adding a browser UI: (1) benchmark a 1M-row export through the chosen durable store,
  (2) prove multi-table transactional writes and crash recovery, (3) prove migration durability
  across browser versions, (4) re-run the golden fixtures in the browser. If those fail, the
  browser path is a thin client over `hv-server`.
- Consequences: WASM scope is explicit and testable; native SQLite remains authoritative.

## 2026-11-17 evidence update: GPUI itself has a web target

`gpui-kit 0.10.0` declares `cfg(target_family = "wasm")` dependencies on `gpui-pre-web` and
`gpui-fast-web`; GPUI is not inherently desktop-only. Attempting `cargo check -p hv-app-gpui
--target wasm32-unknown-unknown` produced this sequence:

1. `getrandom` needs the `wasm_js` feature — fixed with a target-specific dependency.
2. `wait-timeout` (pulled by test-support on normal deps) does not compile for wasm — fixed by
   moving `test-support` to dev-dependencies.
3. `wasm_thread 0.3.3` uses `#![feature(stdarch_wasm_atomic_wait)]`, so the stable 1.99.1 pin is
   not enough; `RUSTC_BOOTSTRAP=1` gets past it, which is not an acceptable CI policy.
4. The build then needs `clang` for C dependencies in the web stack, which is absent on this host.

Conclusion: "GPUI does not support WASM" is false. The honest statement is that the GPUI web
path is buildable in principle but requires a toolchain/system-dep decision (nightly or bootstrap
flag, clang/wasi tooling), a wasm-bindgen packaging step, and a durable storage answer. None of
those are established here, so the WASM deliverable stays core-only and the recommended web UI is
server-backed until that spike is funded.

## 2026-11-17 final build result

The GPUI web build now succeeds and renders in Chromium. The full chain required:

- target-specific `getrandom` with `wasm_js`;
- `test-support` kept in dev-dependencies (its `wait-timeout` dep breaks wasm);
- `RUSTC_BOOTSTRAP=1` locally because `wasm_thread` uses an unstable feature;
- locally extracted `clang` for `sqlite-wasm-rs` C sources;
- a bundled font (`assets/DejaVuSans.ttf`) registered via `cx.text_system().add_fonts` — the web
  text system has no OS font database and otherwise panics on `.SystemUIFont`;
- `wasm-bindgen --target web` and a host page (`web/index.html`).

`ci/build-web.sh` reproduces it. The browser app is served from `hv-server` at `/hv-web/`, signs
in through `/hv-web/login.html`, and reads live data through same-origin `/api/agent/{tool}` calls
with the session cookie. Local SQLite remains unavailable in the browser, so the web build is a
server-backed thin GPUI client; writes are native-only.
