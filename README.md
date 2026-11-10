# HealthVault

Single-user web app: upload an Apple Health `Export.zip`, it is parsed into SQLite, and the data is
browsed in a Next.js dashboard (shadcn components + recharts).

Stack: **bun**, **Next.js 16** (App Router, TS), **SQLite** (`better-sqlite3`) via **drizzle-orm**,
**shadcn** (radix + nova preset). No auth, no cloud, one local database file.

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

## Agent API

`POST /api/agent/<tool>` takes a JSON object and returns `{ ok: true, tool, result }`, or
`{ ok: false, tool, error }` with 400/404/409/500. `GET /api/agent` lists the tools. It is bound to
the same LAN-facing server as the UI and deliberately has **no authentication** (single-user,
local-only posture); do not expose port 3040 to the internet.

**Reads** — `healthvault_context`, `profile_get`, `measurement_history`, `food_search`,
`nutrition_day`, `nutrition_summary`, `supplement_list`, `supplement_history`, `metrics_series`,
`workouts_recent`, `record_types`, `records_recent`, `uploads_recent`.

**Writes** — `profile_update`, `measurement_add`, `food_add`, `meal_log`, `meal_update`,
`nutrition_target_set`, `supplement_create`, `supplement_update`, `supplement_log`, `copy_day`.

**Deletes** — `measurement_delete`, `food_delete`, `meal_delete`, `supplement_delete`.

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
freshness (last import, last record day). The OpenCode plugin lives in `plugins/opencodev2/`; register
it once in the global `~/.config/opencode/opencode.jsonc` so every project gets the tools:

```jsonc
{
  "plugins": [
    {
      "package": "/home/tunitz/projects/healthvault/plugins/opencodev2",
      "options": { "baseUrl": "http://127.0.0.1:3040" }
    }
  ]
}
```

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
copy of the zip anywhere. `src/test/ingest.test.ts` asserts exactly that, so it cannot regress silently.

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

`bun run build && bun run start` for production. The database file defaults to `./data/health.db`
(git-ignored); set `DATABASE_PATH=/path/to/health.db` to point elsewhere. Migrations run on every
boot inside `src/db/index.ts` (`migrate()` from the drizzle better-sqlite3 migrator) — a fresh file
is brought up to schema automatically, which is also how the tests get their tables.

The database file is created **mode 600** and its directory **mode 700** (health data is private).

## Back up / restore

`bun run db:backup` uses SQLite's online backup API, so it is WAL-safe while the app is running:

```bash
bun run db:backup                                  # data/backups/health-<timestamp>.db
bun run db:backup /path/to/health-2026-11-10.db    # explicit destination
```

It runs `PRAGMA integrity_check` first, writes the copy mode 600, and prints the size. Restore by
stopping the service, replacing `data/health.db` (and deleting any `-wal`/`-shm` sidecars), then
starting it again.

## Security posture

The service listens on `0.0.0.0:3040` so the phone/PWA can reach it, and has no login by design.
That means any device on the LAN can read and write health data. Keep it on a trusted network; do
not port-forward it. Responses carry `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and a `Referrer-Policy: no-referrer`; the service worker never
caches `/api/*`.

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
src/lib/day.ts       timezone helpers: local day, windows, formatting
src/lib/xml.ts       incremental Apple Health XML parser (+ <Me>)
src/lib/ingest.ts    streaming ingest + profile prefill
src/lib/services/    profile, measurements, nutrition, supplements, context
src/app/             dashboard (/), training, workouts, explorer, uploads,
                     profile, nutrition, supplements + api/upload, api/type-stats, api/agent
src/components/      charts, explorer client, upload form, app nav, ui/* (shadcn)
src/test/            fixture XML + parser/ingest/route/service tests (bun test)
scripts/seed-fixture.ts   load the test fixture into the database
scripts/backup-db.ts      WAL-safe online backup
plugins/opencodev2/       OpenCode plugin exposing the agent API as tools
```

## Troubleshooting

**`Failed to load external module better-sqlite3-<hash>: Cannot find module ...`** — Turbopack's way
of saying the native sqlite module could not be loaded. It is never a code bug. Causes, in order:

1. **bun is older than 1.4** — 1.3.x panics on better-sqlite3 v13 (`NAPI FATAL ERROR`). Fix: `bun upgrade`.
2. **The install is broken or mixed** — check with `bun scripts/check-native.ts` (also runs as `predev`,
   printing platform, `prebuilds/` and which lockfiles are present), then reinstall cleanly **with bun**:
   `rm -rf node_modules .next && bun install && bun run dev`. Mixing npm/pnpm/yarn lockfiles leaves a
   layout Turbopack cannot resolve native modules from.
3. **If the module loads fine and dev still fails**, it is Turbopack's externals handling, not your
   install: use the webpack dev server instead — `bun run dev:webpack`.

## Verify

```bash
bun run typecheck && bun test src/ && bun run build
```

## Generate a big synthetic export (load testing)

`/tmp/gen_demo_export.py` is a throwaway generator used for the numbers above (kept outside the
repo): `python3 gen_demo_export.py <days> <hr_interval_min> <out.zip>`. Its 5-year output was
uploaded twice — 572,946 rows inserted, then 0 inserted / 572,946 duplicates.

## Docker

The image runs `next start` on node 22 as the non-root `node` user (uid 1000) on port 3040. The
database lives on the host at `./data/health.db` and is bind-mounted to `/data` in the container.

```bash
docker compose build                 # build healthvault:latest from the Dockerfile
docker compose up -d                 # start (restart: always); http://localhost:3040
docker compose logs -f healthvault   # follow logs
docker compose ps                    # health status (healthcheck hits /)
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
