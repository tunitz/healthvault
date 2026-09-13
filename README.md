# HealthVault

Single-user web app: upload an Apple Health `Export.zip`, it is parsed into SQLite, and the data is
browsed in a Next.js dashboard (shadcn components + recharts).

Stack: **bun**, **Next.js 16** (App Router, TS), **SQLite** (`better-sqlite3`) via **drizzle-orm**,
**shadcn** (radix + nova preset). No auth, no cloud, one local database file.

## Auth / transport

Pushes and API calls use the classic `GITHUB_TOKEN` (scopes `repo`, `workflow`) from the Hermes
secrets env, wired into git through `~/.hermes/scripts/git-credential-github.sh`
(`credential.https://github.com.helper`). Production has **no SSH key on GitHub** — remotes must be
`https://github.com/...`, not `git@github.com:...`.

## Run

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
src/db/schema.ts     drizzle tables: uploads, records, workouts, activity_summaries
src/db/index.ts      sqlite connection + migrate-on-boot      src/db/queries.ts  aggregate SQL
src/lib/xml.ts       incremental Apple Health XML parser      src/lib/ingest.ts  streaming ingest
src/app/             dashboard (/), explorer, workouts, uploads + api/upload, api/type-stats
src/components/      steps/sleep/activity charts, explorer client, upload form, ui/* (shadcn)
src/test/            fixture XML + parser/ingest/route tests (bun test)
scripts/seed-fixture.ts   load the test fixture into the database
```

## Troubleshooting

**`Failed to load external module better-sqlite3-<hash>: Cannot find module ...`** — the dev server
can't load the native sqlite module; that message is only ever a symptom of a broken install, not of
code. `bun run dev` now checks this up front (`scripts/check-native.ts`) and prints the platform,
prebuilds and lockfiles it found. Fix by reinstalling cleanly **with bun** — mixing npm/pnpm/yarn
lockfiles leaves a `node_modules` layout Turbopack cannot resolve native modules from:

```bash
rm -rf node_modules .next && bun install && bun run dev
```

## Verify

```bash
bun run typecheck && bun test src/ && bun run build
```

## Generate a big synthetic export (load testing)

`/tmp/gen_demo_export.py` is a throwaway generator used for the numbers above (kept outside the
repo): `python3 gen_demo_export.py <days> <hr_interval_min> <out.zip>`. Its 5-year output was
uploaded twice — 572,946 rows inserted, then 0 inserted / 572,946 duplicates.
