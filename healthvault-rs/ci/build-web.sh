#!/usr/bin/env bash
# Build the GPUI Kit web app and generate the browser bundle in web/.
# Prerequisites on this host (all installed locally, no system modification):
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.130 --locked
#   clang for sqlite-wasm-rs (extracted under /tmp/clang-root here)
# RUSTC_BOOTSTRAP is required only because wasm_thread 0.3.3 uses an unstable feature;
# it is a local build workaround, not a CI policy for native targets.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/tmp/clang-root/usr/bin:$PATH"
export LD_LIBRARY_PATH="/tmp/clang-root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
export RUSTC_BOOTSTRAP=1
export CC=clang
export CFLAGS='--target=wasm32'
cargo build -p hv-app-gpui --target wasm32-unknown-unknown --release --locked
wasm-bindgen --target web --out-dir web target/wasm32-unknown-unknown/release/hv-app-gpui.wasm
echo "web bundle ready in web/ — serve it with hv-server at /hv-web/"
