#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
expected="$(sed -n 's/^channel *= *"\([^"]*\)".*/\1/p' rust-toolchain.toml)"
actual="$(rustc --version | awk '{print $2}')"
if [ "$actual" != "$expected" ]; then
  echo "toolchain mismatch: rust-toolchain.toml pins ${expected}, running ${actual}" >&2
  exit 1
fi
echo "toolchain OK: ${actual}"
