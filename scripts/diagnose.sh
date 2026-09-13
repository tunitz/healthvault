#!/usr/bin/env bash
# Collects everything needed to diagnose a dev-server startup failure, and captures the
# first page render (where Turbopack reports "Failed to load external module ...").
# Run from the project root:  bash scripts/diagnose.sh
set -uo pipefail

echo "===== environment ====="
echo "bun      : $(bun --version 2>&1)"
echo "node     : $(node -v 2>&1)"
echo "platform : $(uname -srm) / libc: $(ldd --version 2>/dev/null | head -1)"
echo "pwd      : $(pwd)"
echo "git      : $(git log --oneline -1 2>&1) | dirty: $(git status --porcelain | wc -l) file(s)"
echo
echo "===== lockfiles / configs ====="
ls -1 bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock 2>/dev/null || echo "(none)"
for f in bunfig.toml "$HOME/.bunfig.toml" "$HOME/.config/.bunfig.toml"; do
  [ -f "$f" ] && { echo "--- $f"; cat "$f"; }
done
echo "packageManager: $(node -e "console.log(require('./package.json').packageManager)" 2>/dev/null)"
echo
echo "===== sqlite driver ====="
ls -d node_modules/better-sqlite3 2>&1
ls -1 node_modules/better-sqlite3/prebuilds 2>/dev/null | tr '\n' ' ' ; echo
bun scripts/check-native.ts 2>&1 | tail -5
echo
echo "===== dev server: startup + first render ====="
rm -f /tmp/diagnose-dev.log
( bun run dev > /tmp/diagnose-dev.log 2>&1 & )
for i in $(seq 1 20); do
  sleep 3
  code=$(curl -s -m 10 -o /tmp/diagnose-page.html -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
  [ "$code" = "200" ] || [ "$code" = "500" ] && break
done
echo "HTTP status      : ${code:-no response}"
echo "page contains    : $(grep -o 'Failed to load external module[^<"]*' /tmp/diagnose-page.html 2>/dev/null | head -1 || echo '(no hashed-module error)')"
echo "--- dev log (last 25 lines) ---"
tail -25 /tmp/diagnose-dev.log 2>/dev/null
pkill -f "nex[t] dev" 2>/dev/null
echo "(dev server stopped)"
echo
echo "===== webpack fallback (does it render?) ====="
rm -f /tmp/diagnose-wp.log
( bun run dev:webpack > /tmp/diagnose-wp.log 2>&1 & )
for i in $(seq 1 20); do
  sleep 3
  wp=$(curl -s -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
  [ "$wp" = "200" ] || [ "$wp" = "500" ] && break
done
echo "webpack dev HTTP : ${wp:-no response}"
tail -8 /tmp/diagnose-wp.log 2>/dev/null
pkill -f "nex[t] dev" 2>/dev/null
echo "(done — paste this whole output)"
