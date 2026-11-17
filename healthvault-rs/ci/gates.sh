#!/usr/bin/env bash
# Deterministic gate order: toolchain -> format -> clippy -> tests -> WASM target check.
set -euo pipefail
cd "$(dirname "$0")/.."
bash ci/assert-toolchain.sh
# GPUI needs the xkbcommon-x11 link stub. Some hosts ship only the versioned runtime .so;
# use the checked-in symlink in that case. CI installs libxkbcommon-x11-dev instead.
if [ ! -e /usr/lib/x86_64-linux-gnu/libxkbcommon-x11.so ] && [ ! -e /usr/local/lib/libxkbcommon-x11.so ]; then
  if [ -f "$PWD/.linklibs/libxkbcommon-x11.so" ]; then
    export RUSTFLAGS="${RUSTFLAGS:-} -L native=$PWD/.linklibs"
  fi
fi
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked

cargo check -p hv-wasm --target wasm32-unknown-unknown --locked

# Coverage is ratcheted (never lower the floor without a documented reason).
# cargo llvm-cov --workspace --locked --fail-under-lines 70
