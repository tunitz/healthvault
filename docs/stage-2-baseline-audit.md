# Stage 2 — signed-in baseline audit (2026-11-17)

Isolated preview: worktree `hv-ui-refresh-mcp`, bound `0.0.0.0:3042`, reachable on loopback and
`http://192.168.31.10:3042`. Scratch DB seeded with `scripts/seed-synthetic.ts` (540 records,
6 workouts, 8 weights, 4 foods, 2 supplements, 10 supplement logs, profile + targets).
Synthetic login: `dev-only-password`. Production service on port 3040 untouched.

Browser: playwright-cli chromium, isolated in-memory profile, logged-in session.

## Overflow matrix (scrollWidth > clientWidth)

Routes checked at 320 / 390 / 768 / 1440 px: `/`, `/nutrition`, `/nutrition/foods`,
`/nutrition/recipes`, `/nutrition/corrections`, `/training`, `/workouts`, `/supplements`,
`/profile`, `/uploads`, `/explorer`.

Overflow found only at 320px:

| Route | scrollWidth | clientWidth | Cause |
|---|---:|---:|---|
| `/` (dashboard) | 336 | 320 | `.recharts-wrapper` width 320, right edge 336 |
| `/nutrition` | 336 | 320 | `.recharts-wrapper` width 320, right edge 336 |

All other route/width combinations: no horizontal overflow.

## Console

0 application errors. One browser-level warning on the LAN origin: `Cross-Origin-Opener-Policy
header ignored because origin is untrustworthy` — expected for plain HTTP on a non-loopback
origin; not an application defect. Document in handoff; do not "fix" by weakening headers.

## Baseline screenshots

- `/tmp/opencode/shots/hv-baseline-dashboard-320.png`
- `/tmp/opencode/shots/hv-baseline-dashboard-1440.png`

## Findings carried into implementation

1. Fix chart container sizing so recharts never exceeds its parent at 320px (Stage 4/6).
2. Verify the fix across both themes after the shell/dashboard work lands.
3. Re-run this exact matrix in Stage 9 as the regression check.
