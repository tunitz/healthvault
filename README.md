# HealthVault

Single-user web app: upload an Apple Health `Export.zip`, it is parsed into SQLite, and the data is
browsed in a Next.js dashboard (shadcn components + recharts).

Stack: **bun**, **Next.js 16** (App Router, TS), **SQLite** (`better-sqlite3`) via **drizzle-orm**,
**shadcn** (radix + nova preset). Single-user login (password + session cookie), credential-less
agent API on the trusted LAN, no cloud, one local database file.

## What it tracks

| Area | Route | Storage |
|---|---|---|
| Apple Health import (records, workouts, activity days) | `/`, `/training`, `/workouts`, `/explorer`, `/uploads` | `records`, `workouts`, `activity_summaries`, `uploads` |
| Personal profile (name, birth date, sex, height, timezone, units, work schedule, goals, notes) | `/profile` | `profile` (singleton) |
| Weight / body-fat / waist | `/profile` | `measurements` (manual) merged with Apple `BodyMass` |
| Food, calories and macros | `/nutrition` | `foods`, `food_log`, `nutrition_targets` |
| Supplements | `/supplements` | `supplements`, `supplement_logs` |

Apple's `<Me>` element (birth date, biological sex) is captured during import and prefills only
empty profile fields; it never overwrites an edited value. Height is prefilled from the newest
`HKQuantityTypeIdentifierHeight` record. Body weight is **not** silently written: manual entries
and Apple `BodyMass` are merged for display, each point labelled with its source.

Every "today"/"last N days" boundary uses the profile's IANA timezone (`Asia/Shanghai` by default),
not SQLite's UTC `date('now')` — the two disagree by 8 hours here, which used to hide the current
day's rows from rolling windows. Timestamps in the UI are local wall-clock, not UTC.

## Authentication

Single-user login for the web UI, no user table. There is **no auth-off mode**: the server refuses
to boot without valid credentials.

| Credential | Used by | Stored in |
|---|---|---|
| Password → `hv_session` cookie (HMAC-SHA256, 30 days, HttpOnly, SameSite=Lax) | the web UI / PWA | `HEALTHVAULT_PASSWORD_HASH` + `HEALTHVAULT_SESSION_SECRET` in the credentials env file (0600) |

The credentials env file is the project-root `.env` (git-ignored, mode 0600, loaded automatically
by Next.js) — `bun run password:set` creates and maintains it for you.

Everything except `/api/health` and `/api/agent/*` requires the session cookie: unauthenticated
pages redirect to `/login`, unauthenticated API calls get 401. Login is throttled (5 failures /
15 min → 429). `GET /api/health` is public and returns `{"ok":true}` only.

`/api/agent/*` is deliberately **credential-less**: local agents and MCP clients call it with no
token and no cookie. It is reachable by any device that can open `0.0.0.0:3040`, so it is a
trusted-LAN surface by construction — never port-forward or expose it to the internet. If remote
agent access is needed, put an authenticating TLS proxy in front of the app.

The token is gone, but old operator scripts keep working: `password:set` still accepts
`--token-file <path>` and ignores it (no token file is read or written), and
`HEALTHVAULT_API_TOKEN` / `HEALTHVAULT_API_TOKEN_FILE` are ignored if still present.

Environment variables: `DATABASE_PATH`, `HEALTHVAULT_PASSWORD_HASH`, `HEALTHVAULT_SESSION_SECRET`,
`HEALTHVAULT_COOKIE_SECURE` (set `1` behind TLS), `HEALTHVAULT_SESSION_DAYS`.

**Set or change the password:**

```bash
bun run password:set       # hidden prompt; never takes the password as an argument
bun run password:verify    # check a password against the stored hash
```

`password:set` writes the scrypt hash to the credentials env file and, on a fresh setup, also
generates the `HEALTHVAULT_SESSION_SECRET`. By default it targets
`~/.config/healthvault/auth.env` when that file already exists (hosts that inject credentials from
an external file), otherwise the project `.env`; pass `--file <path>` to choose explicitly — the
chosen target is always printed. Restart the app after changing credentials. Existing sessions stay
valid until they expire; regenerate `HEALTHVAULT_SESSION_SECRET` to invalidate them all.

## Agent API and MCP

`POST /api/agent/<tool>` takes a JSON object and returns `{ ok: true, tool, result }`, or
`{ ok: false, tool, error }` with 400/404/409/500. `GET /api/agent` lists the tools. There is no
token or cookie on this surface; keep the service on a trusted LAN and do not expose port 3040 to
the internet.

A trusted LAN is a network assumption, **not a browser security boundary**. With no Host/Origin
allowlist, a malicious page can use DNS rebinding to make its own hostname resolve to this LAN
address and drive the credential-less API from the browser. Keeping the service on the LAN does not
stop that; an allowlist in a fronting proxy (or loopback-only binding) is required and is not
implemented here.

### Upgrading from a token build

Install the new server build first: rebuild and restart the app, **then** update and restart the MCP
client. The old app build still requires a bearer token and the new client sends none, so tool calls
return 401 until the server side is the new build. If you run MCP clients continuously, keep the old
token file in place until the server restart. The versions are not compatible in either direction,
so on rollback restart the old server before reverting the client.

The canonical agent transport is the **MCP server** in `plugins/healthvault/` — one stdio server
every harness can run (OpenCode, Claude Code, Claude Desktop, Cursor, …). Install and configure it
once:

```bash
bun install -g ./plugins/healthvault    # from the project directory
```

See `plugins/healthvault/README.md` for per-harness config snippets. Clients with no MCP support can
call `POST /api/agent/<tool>` directly, e.g. `curl http://127.0.0.1:3040/api/agent/healthvault_context
-H 'content-type: application/json' -d '{}'`.

**Reads** — `healthvault_context`, `profile_get`, `measurement_history`, `food_search`,
`nutrition_day`, `nutrition_summary`, `supplement_list`, `supplement_history`, `metrics_series`,
`workouts_recent`, `record_types`, `records_recent`, `uploads_recent`, `recipe_get`,
`food_template_list`, `meal_get`, `food_history_preview`.

**Writes** — `profile_update`, `measurement_add`, `food_add`, `meal_log`, `meal_update`,
`nutrition_target_set`, `supplement_create`, `supplement_update`, `supplement_log`, `copy_day`,
`recipe_create`, `recipe_log`, `recipe_update`, `food_template_apply`,
`food_history_refresh`.

**Deletes** — `measurement_delete`, `food_delete`, `meal_delete`, `supplement_delete`,
`recipe_delete`.

The surface covers every write the UI exposes, including the delete paths, plus the read-only
aggregation behind `/api/type-stats` (`record_types`). `/api/upload` is deliberately **not**
exposed to agents: importing an `Export.zip` stays a manual step in the UI, and `uploads_recent`
only reports import history.

`records_recent` serves raw rows for one type (default 50, max 500) and does **not** de-duplicate
phone/watch overlaps — use `metrics_series` for any daily total or trend, since it picks one source
per local day. `copy_day` copies `fromDay` into `toDay`, skips rows already present, and returns
`copied` (`0` means already present, not a failure). `measurement_delete` removes manual
measurements only; Apple `BodyMass` is immutable. `food_delete` returns 409 while a logged meal uses
the food, and `supplement_delete` archives a supplement that has history and hard-deletes one that
does not.

Profile reads (`profile_get` and `context.profile`) parse the stored schedule into a `workSchedule`
object — `{ days: [{ weekday, start, end }], note? }` — alongside the legacy `workScheduleJson`.
Agent-facing numbers are rounded consistently: whole kcal and grams; one decimal for kg, km, hours
and percent; never more than two decimals.

`healthvault_context` is the entry point for an agent: profile + age, today's nutrition and targets,
the 7-day weight trend, recent workouts, 30-day sleep/steps, the supplement checklist and data
freshness (last import, last record day).

### Food defaults (opt-in templates)

Household-measure grams and raw/dry yield factors recorded from the real log live in a fixed
template catalogue — honey, NESCAFÉ Gold, jumbo egg, KFC fry strip, whey, and the
chicken/beef/rice/pulse/pasta/oats yields. Nothing is inferred from a food's name, and **no saved
food is changed until you apply a template explicitly**. Templates never carry nutrition values
themselves.

```bash
# 1. List the catalogue and its exact slugs.
curl -sS http://127.0.0.1:3040/api/agent/food_template_list \
  -H 'content-type: application/json' -d '{}'

# 2. Apply one template to one saved food id. Macros are untouched.
curl -sS http://127.0.0.1:3040/api/agent/food_template_apply \
  -H 'content-type: application/json' \
  -d '{"id": 12, "template": "honey"}'
```

Existing per-unit overrides and a custom state/yield factor are kept; pass `{"overwrite": true}`
to replace them. A template that changes the per-100 g basis (for example `white-rice-dry`
switching a food from `raw` to `dry`) refuses without `overwrite: true`, so stored nutrition is
never silently relabelled. Applied values stay editable through `food_add`.

The `0003` migration also fills these values into legacy rows whose **name and brand match
exactly** — Honey (no brand); NESCAFÉ Gold, instant coffee (dry) (Nescafé); Egg, whole, raw
(jumbo 60g) (no brand); KFC Crispy Fries (KFC Philippines); Whey Protein, ACTIVE, Chocolate
(ACTIVE); Chicken breast, skinless, raw (no brand) — but only while the added columns still hold
their defaults. It never creates a food, never edits logged meals, and never overwrites a measure
or yield factor that was already edited.

Recipe ingredients may omit `foodId`: the ingredient keeps its grams/measure but contributes no
invented nutrition, `recipe_get` reports it as unresolved and the recipe as incomplete, and any
serving logged from an incomplete recipe is stored with `macroSource: "estimated"`. A recipe with
no food-resolved ingredients at all is refused by `recipe_log` instead of logging a zero meal.

### Full ingredient snapshots, per-meal overrides and recipe archival (`0004`)

`0004_ingredient_snapshots_history` adds `food_log_ingredients`, `food_log_revisions`,
`food_revisions`, `foods.source_url` / `source_date`, `food_log.basis_state` /
`basis_yield_factor`, and `recipes.archived_at_ms` / `archived_reason`. It is additive: no existing
row is rewritten and no historical ingredient is invented.

- **Every logged recipe serving now writes one child row per ingredient** — food id, name, grams in
  the portion, per-serving grams, household measure, weighed state, the food's basis state and yield
  factor, per-100 g values, portion macros, resolved flag, provenance and source URL/date. The exact
  `0004` SQL and the cross-stack contract are in `docs/ingredient-snapshots-handoff.md`.
- **Per-meal overrides** (`recipe_log.ingredientOverrides`) change quantities for one meal without
  editing the recipe. `amountBasis` is required with overrides: `"batch"` means the override grams
  are for the whole recipe (divided by servings), `"serving"` means they are already one serving.
  The snapshot stores the same basis, so a measure is never re-interpreted later. Identify an
  ingredient by `ingredientId` (from `recipe_get`) or by `foodId` when it appears once. The
  ingredient library is the existing `foods` table: `food_search` finds a saved food and its id,
  and `recipe_create`/`recipe_update` accept that `foodId` directly.
- **Editing a recipe no longer rewrites history.** Historical child rows keep their own copy and
  their original `recipe_ingredient_id` (a plain historical integer, not a live FK). `meal_update`
  rescales from the stored per-serving snapshot and rescales each child in the same transaction.
- **`copy_day` copies the whole snapshot**, including child rows, `serving_fraction` and
  `recipe_serving_json`. The copy has no live `recipe_id`/`serving_no` (so it cannot corrupt the
  remaining-servings count) but remains readable and rescalable.
- **`meal_delete` deletes its child ingredient and revision rows** in the same transaction, and
  `food_delete` returns 409 when a logged recipe ingredient still references the food.
- **Recipe deletion is non-destructive.** A recipe with logged history is archived (`deleted:
  false, archived: true`, with a reason and `loggedEntries` count): it leaves the active surface,
  cannot be logged or edited again, but its detail and old logs stay readable and rescalable. It is
  also archived when only copied child snapshots still name it after their parent `recipe_id` was
  cleared. A recipe with no logged or historical reference deletes together with its own ingredient
  rows, so a populated recipe is never undeletable.
- **A recipe entry's macros are derived from its children.** `meal_update` rejects an explicit
  macro edit with 409 while child snapshots exist, and rejects `servingFraction`/`servingNo`
  together with macros, so the parent and children cannot desync. Use `servingFraction`, `grams`,
  or the explicit history-refresh path instead.
- **Past meals are never silently corrected.** After a food's nutrition changes, existing snapshots
  keep their values. `food_history_preview` (read-only) lists the exact before/after rows and a
  `previewHash`; `food_history_refresh` applies only those rows, requires the hash, and writes a
  `food_log_revisions` row with the previous and new JSON. Scope it with `foodIds` and/or `entryIds`
  (optionally `fromDay`/`toDay`); a global rewrite is rejected, and a scope over 500 snapshots fails
  before writing anything instead of partially correcting. Rows are skipped with a reason when the
  food is missing, the stored basis is unknown, the food's basis state changed, or its yield factor
  changed while a weighed-state conversion was in play (`yield_changed`). An `estimated` or
  manual snapshot is never relabelled `label` and its estimated flag is never forced off. A legacy
  aggregate-only recipe row in an explicitly scoped `entryIds` list is surfaced as skipped
  (`aggregate_snapshot_without_ingredients`), not silently omitted. Such a row has no recorded
  per-serving arithmetic, so `meal_update` refuses a `servingFraction`/`grams` rescale with 409;
  explicit grams/macros edits still work.
- `meal_get` verifies the recorded child count: a non-empty but truncated ingredient list is
  reported as `ingredientSnapshotComplete: false`.
- `food_add` accepts `sourceUrl` and `sourceDate` (YYYY-MM-DD) alongside `source`; values are
  manual, never fetched. Every food-definition change writes a `food_revisions` row.

### Recipe deletion and legacy rows

`recipe_delete` archives a recipe that has logged history instead of deleting it (see above).
Because the write surface requires a non-empty ingredient list, a recipe with no ingredient rows
(legacy/manual data only) deletes normally. The older "409 for every reference" rule is gone; the
old aggregate-only `food_log` rows themselves are untouched.

## Upgrading from an earlier import

Workout parsing was corrected: distance/energy/heart-rate now come from the `<WorkoutStatistics>`
children (they were being read from attributes that real exports do not have), and `durationUnit`
is honoured (`"min"` was being stored as seconds, making every workout 60x too short). Steps and
heart rate are no longer summed across devices — each day is read from the source with the most
samples, because the phone and the watch both record them and adding them together double counts.

Rows already in the database keep their old values, and the unique key of a workout does not change,
so a re-upload cannot repair them. Delete the database and import once more:

```bash
rm -rf data/        # or: rm data/health.db*
bun run dev         # then upload Export.zip again
```

## Real exports (measured)

Apple's own "Export All Health Data" does **not** put `export.xml` at the zip root — it ships
`apple_health_export/export.xml` (with `export_cda.xml` and `workout-routes/*.gpx` beside it). The ingest
matches on the basename, so either layout works; a zip without it fails with the entry names listed.

A real 4-year iPhone/Watch export (17.5 MB zip → **410 MB** `export.xml`, 16 entries):

| | |
|---|---|
| rows ingested | **911,472** (910,620 records, 133 workouts, 719 activity days) |
| record types auto-discovered | 40 |
| date range | 2022-09-21 → 2026-09-13 |
| wall clock | **35 s** |
| peak RSS | **~830 MB** |
| sqlite file | 269 MB |

34 rows inside that export were byte-identical duplicates of earlier rows and were skipped by the unique
indexes — Apple does emit some. Re-importing the same file inserts 0 and reports every row as a duplicate.

**Nothing is written to disk except `data/health.db`.** The upload is read into memory, the XML is inflated
and parsed as a stream, and rows go straight into SQLite — no temp file, no extracted `export.xml`, and no
copy of the zip anywhere.

Where the time goes (instrumented, 410 MB XML): **XML+inflate 29 s**, SQLite ~5 s. That is why the DB side
uses raw prepared statements rather than the query builder — see the note at the top of `src/lib/ingest.ts`.
Three optimizations were measured and **rejected** for giving nothing: forcing `Bun.gc(true)` per 200k rows
(peak 1.9 GB, worse), `PRAGMA synchronous = NORMAL` (no measurable gain, added a durability trade), and a
hand-rolled date fast-path (29.3 s → 28.8 s). Do not re-add them without a measurement.

Tuning knobs (defaults are fine): `INGEST_CHUNK` (rows per INSERT, 1000), `INGEST_SLICE` (zip bytes pushed
into the inflater per step, 1 MiB), `INGEST_MAX_XML` (uncompressed `export.xml` cap, 1536 MiB — a
real 4-year export inflates to ~410 MB; the cap stops a crafted zip from decompressing without bound).

## Auth / transport

Pushes and API calls use the classic `GITHUB_TOKEN` (scopes `repo`, `workflow`) from the Hermes
secrets env, wired into git through `~/.hermes/scripts/git-credential-github.sh`
(`credential.https://github.com.helper`). Production has **no SSH key on GitHub** — remotes must be
`https://github.com/...`, not `git@github.com:...`.

## Run

Prerequisite: **bun >= 1.4**. bun 1.3.x crashes loading better-sqlite3 v13 with a NAPI fatal error,
which surfaces as `Failed to load external module better-sqlite3-<hash>` — if `bun --version` is older,
run `bun upgrade` first.

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun is not on PATH in non-interactive shells here
bun install
bun run db:generate                  # only after editing src/db/schema.ts
bun run dev                          # http://localhost:3000
```

`bun run build && bun run start` for production. Dev and start both fail fast without credentials:
run `bun run password:set` once (see Authentication) — it creates everything needed. `next build`
itself needs no credentials. The database file defaults to `./data/health.db`
(git-ignored); set `DATABASE_PATH=/path/to/health.db` to point elsewhere. Migrations run on every
boot inside `src/db/index.ts` (`migrate()` from the drizzle better-sqlite3 migrator) — a fresh file
is brought up to schema automatically.

The database file is created **mode 600** and its directory **mode 700** (health data is private).

## Back up / restore

`bun run db:backup` uses SQLite's online backup API, so it is WAL-safe while the app is running:

```bash
bun run db:backup                                  # data/backups/health-<timestamp>.db
bun run db:backup /path/to/health-2026-11-10.db    # explicit destination
```

It runs `PRAGMA integrity_check` first, writes the copy mode 600, and prints the size. Schedule it
with whatever supervisor you run the app under (the maintainer's host uses a daily systemd timer
with 14-day retention — see `deploy/README.md`). Restore by
stopping the app, replacing `data/health.db` (and deleting any `-wal`/`-shm` sidecars), then
starting it again.

## Security posture

The service listens on `0.0.0.0:3040` so the phone/PWA can reach it. The UI is protected by the
session cookie; `/api/agent/*` is intentionally credential-less for local agents, so any device on
the LAN can read and write health data through it, and any browser on the LAN is a potential path to
it via DNS rebinding (see above). Over plain HTTP the login password crosses the LAN in clear text —
keep the service on a trusted network, or put an authenticating TLS proxy in front
(`deploy/Caddyfile.example`, then set `HEALTHVAULT_COOKIE_SECURE=1`). Do not port-forward it.
Responses carry `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, COOP/CORP `same-origin` and a report-only CSP; the service worker
never caches `/login`, `/api/auth/*` or any `/api/*`. Logout clears the cookie, site caches and
storage (`Clear-Site-Data`). Known tradeoff: pages cached by the PWA while authenticated remain
readable offline on that device until logout clears them.

Tests live in `src/test/` (`bun test`) and run against throwaway databases under `/tmp/opencode`;
they cover the services and the auth surface. They are a development aid, not a deployment safety
net: verification is still `bun run typecheck && bun run lint && bun run build` plus the live checks
in `deploy/README.md`.

## Installation

Fresh machine, fresh clone — bun only:

```bash
# 1. get the app
git clone https://github.com/tunitz/healthvault && cd healthvault
bun install

# 2. credentials (once): prompts for the login password with hidden input,
#    writes .env (0600) with the scrypt hash + a generated session secret.
bun run password:set

# 3. build + run (PORT/HOSTNAME are Next's own env vars; default port 3000)
bun run build
PORT=3040 HOSTNAME=0.0.0.0 bun run start

# 4. MCP server for agents (once, per host)
bun install -g ./plugins/healthvault
#    then add your harness config; see plugins/healthvault/README.md

# 5. verify
curl -s http://127.0.0.1:3040/api/health          # {"ok":true} without auth
bun run password:verify                            # checks your password
#    open http://<host>:3040 -> redirects to /login
```

Run the app under whatever supervisor you prefer (tmux, runit, systemd, …); example systemd user
units plus a daily backup timer for a long-running host live in `deploy/` (see `deploy/README.md`).

**Upgrade:** `bun run db:backup`, stop the app, `git pull && bun install && bun run build`, start
it, then smoke-test (`/api/health`, login, one MCP read). **Rollback:** `git checkout <sha>`,
rebuild, restart — auth adds no migration, so the database is unaffected.

## Ingest design (why it streams)

`Export.zip` contains one `export.xml`, and a real export is huge (5 years of Apple Watch data is
hundreds of MB of XML, millions of rows). So `src/lib/ingest.ts`:

1. reads the uploaded zip into memory (the 200 MB cap in `POST /api/upload` is on the *zip*),
2. inflates `export.xml` **in 1 MiB slices** with fflate's streaming `Unzip` and yields raw chunks,
3. feeds those chunks to an incremental sax parser (`createHealthParser()` in `src/lib/xml.ts`),
   decoding with `TextDecoder({ stream: true })` so UTF-8 sequences split across chunks survive,
4. drains parsed rows and inserts them in 1000-row `onConflictDoNothing` batches, so memory stays
   bounded by the batch instead of the document.

Measured on this box (4 GB RAM, 4 cores), 573k-row export / 139 MB XML / 7 MB zip:
**38 s wall clock, ~625 MB peak RSS** (the pre-streaming version that inflated the whole document
first peaked at ~1.8 GB, i.e. 13× the zip size — a 500 MB export would have OOM-killed the server).

Dedupe is a unique index per table (`uq_records_key`, `uq_workouts_key`,
`activity_summaries.date_components`), so re-uploading the same export inserts nothing and reports
the skipped rows as duplicates. Ingests are tracked in `uploads` (running → done/failed + counters).

Parsing rules worth knowing:
- Correlation children are skipped — Apple also writes those records at the top level, so parsing
  them twice would double count.
- Sleep is stored as category rows with stage codes: 1 InBed, 2 Asleep, 3 Awake, 4 Core, 5 Deep,
  6 REM. A night is attributed to the evening it started (`< 12:00` segments belong to the previous
  day), and InBed is excluded from every sleep *total* because it wraps the asleep rows.
- Unknown record types are stored as-is (Explorer lists every type found, quantity or category).

## Layout

```
src/db/schema.ts     drizzle tables: uploads, records, workouts, activity_summaries,
                     profile, measurements, nutrition_targets, foods, food_log,
                     supplements, supplement_logs
src/db/index.ts      sqlite connection + migrate-on-boot + private file modes
src/db/queries.ts    aggregate SQL (single-source-per-day, local-day windows)
src/lib/auth.ts      scrypt verify, session cookie sign/verify, throttle
src/lib/auth-config.ts  credential loading + fail-fast validation
src/lib/day.ts       timezone helpers: local day, windows, formatting
src/lib/xml.ts       incremental Apple Health XML parser (+ <Me>)
src/lib/ingest.ts    streaming ingest + profile prefill
src/lib/services/    profile, measurements, nutrition, supplements, context
src/proxy.ts         Next 16 Proxy: session gate, public allowlist, no-store caching
src/instrumentation.ts  boot-time credential validation
src/app/             dashboard (/), login, training, workouts, explorer, uploads,
                     profile, nutrition, supplements + api/auth, api/health,
                     api/upload, api/type-stats, api/agent
src/components/      charts, explorer client, upload form, login form, app nav, ui/* (shadcn)
scripts/backup-db.ts WAL-safe online backup
scripts/password.ts  password:set / password:verify credential tool
plugins/healthvault/ MCP stdio server exposing the agent API to any harness
deploy/              systemd units + backup timer (maintainer's host), Caddyfile.example, deploy README
```

## Troubleshooting

**`Failed to load external module better-sqlite3-<hash>: Cannot find module ...`** — Turbopack's way
of saying the native sqlite module could not be loaded. It is never a code bug. Causes, in order:

1. **bun is older than 1.4** — 1.3.x panics on better-sqlite3 v13 (`NAPI FATAL ERROR`). Fix: `bun upgrade`.
2. **The install is broken or mixed** — reinstall cleanly **with bun**:
   `rm -rf node_modules .next && bun install && bun run dev`. Mixing npm/pnpm/yarn lockfiles leaves a
   layout Turbopack cannot resolve native modules from.

**Server exits at boot with a credential error** — fail-fast auth validation. Check
`~/.config/healthvault/auth.env` (`HEALTHVAULT_PASSWORD_HASH` in `scrypt:N:r:p:salt:hash` form,
`HEALTHVAULT_SESSION_SECRET` ≥ 32 chars); for Docker, `.env`.

**MCP tools return 401** — something in front of the app is demanding credentials (the app's agent
surface needs none): check for a reverse proxy or another build on that port. **Connection
refused** — start the app (`PORT=3040 bun run start`, or via your supervisor).

## Verify

```bash
bun run typecheck && bun run lint && bun run build
```

There are no committed test suites (removed by design — see Security posture). After any deploy,
run the live checks in `deploy/README.md` ("Verification after deploy").

## Generate a big synthetic export (load testing)

`/tmp/gen_demo_export.py` is a throwaway generator used for the numbers above (kept outside the
repo): `python3 gen_demo_export.py <days> <hr_interval_min> <out.zip>`. Its 5-year output was
uploaded twice — 572,946 rows inserted, then 0 inserted / 572,946 duplicates.

## Docker

The image runs `next start` on node 22 as the non-root `node` user (uid 1000) on port 3040. The
database lives on the host at `./data/health.db` and is bind-mounted to `/data` in the container.
Auth is mandatory for the UI: copy `.env.example` to `.env` (git-ignored) and set
`HEALTHVAULT_PASSWORD_HASH` and `HEALTHVAULT_SESSION_SECRET`, or the container exits at boot.
Agent clients need no token.

```bash
cp .env.example .env && $EDITOR .env
docker compose build                 # build healthvault:latest from the Dockerfile
docker compose up -d                 # start (restart: always); http://localhost:3040
docker compose logs -f healthvault   # follow logs
docker compose ps                    # health status (healthcheck hits /api/health)
docker compose down                  # stop and remove the container (data/ is kept)
```

The container user is `1000:1000` in `docker-compose.yml`; it must match the owner of `./data`
(check with `id -u` / `id -g`). If you change uid, `chown -R <uid>:<gid> data`.

Backup (stop-free, SQLite WAL-safe copy via the sqlite CLI, or stop the container first):

```bash
docker compose stop healthvault && tar czf healthvault-data-$(date +%F).tgz data/ && docker compose start healthvault
# or, while running (needs sqlite3 on the host):
sqlite3 data/health.db ".backup 'healthvault-$(date +%F).db'"
```

Restore: `docker compose stop healthvault`, replace `data/` with the backup, `docker compose start healthvault`.
