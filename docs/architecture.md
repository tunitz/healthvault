# Architecture & Ingest Design

## System Overview

HealthVault is a single-user Next.js 16 (App Router, TypeScript) application backed by a single local SQLite database (`better-sqlite3` + Drizzle ORM) in WAL mode.

- **Web UI & PWA** (`src/app/`, `src/components/`): Server-rendered React pages and shadcn/Recharts dashboards using the profile's IANA timezone (`UTC` by default, configurable in `/profile` or via `HEALTHVAULT_DEFAULT_TIMEZONE`) for every local-day rolling window.
- **Database & Migrations** (`src/db/`): Drizzle schema in `src/db/schema.ts` with additive migrations under `drizzle/`. Migrations run automatically at boot via `src/db/index.ts`, creating `./data/health.db` (`0600`) inside `./data` (`0700`).
- **Service Layer** (`src/lib/services/`): Shared domain logic for profile, measurements, nutrition, recipes, food history, training plans, strength logs, supplements, settings, and context summaries so the UI and agent APIs execute identical calculations.
- **Authentication & Security Gate** (`src/proxy.ts`, `src/lib/auth.ts`, `src/lib/auth-config.ts`): Three-state single-user authentication (`unconfigured` → `/setup`, `legacy` `.env`, or `stored` SQLite `auth_credentials`), Host allowlist checks (`HEALTHVAULT_ALLOWED_HOSTS`), and same-origin verification.

## Streaming Apple Health Ingest

Apple's **Export All Health Data** zip typically places `apple_health_export/export.xml` (alongside `workout-routes/*.gpx` and ECG CSV exports) inside an archive whose uncompressed XML can reach hundreds of megabytes.

To keep peak memory bounded during import (`POST /api/upload`):

1. **In-memory Zip Streaming**: The uploaded archive is read up to the 200 MiB upload cap (`experimental.proxyClientMaxBodySize: "220mb"` in `next.config.ts`) without writing temporary zip or XML files to disk.
2. **Incremental Inflate & SAX Parsing** (`src/lib/ingest.ts`, `src/lib/xml.ts`): `export.xml` is inflated in 1 MiB slices (`INGEST_SLICE`) via `fflate`'s streaming `Unzip` and parsed incrementally with `TextDecoder({ stream: true })`. An uncompressed XML cap (`INGEST_MAX_XML`, default 1536 MiB) guards against zip bombs.
3. **Optional Native Rust Worker** (`rust/ingest-rs`, `rust/xml-rs`): When built, the Rust ingest worker accelerates XML parsing and batch insertion while maintaining parity with the TypeScript fallback.
4. **Batched Deduplicated Inserts**: Parsed rows are flushed in 1,000-row batches (`INGEST_CHUNK`) using `onConflictDoNothing` against unique indexes (`uq_records_key`, `uq_workouts_key`, `activity_summaries.date_components`), making re-imports idempotent.

### Parsing & Deduplication Rules

- **Profile prefill**: `<Me>` (`dateOfBirth`, `biologicalSex`) and the newest `HKQuantityTypeIdentifierHeight` record prefill empty profile fields only; edited values are never overwritten.
- **Workouts & GPX/ECG**: Workout distance, energy, and heart rate read `<WorkoutStatistics>` children with explicit unit conversion (`durationUnit` honored). Attached `workout-routes/*.gpx` polylines and km splits populate `workout_routes`; Apple Watch ECG CSVs populate `ecg_recordings`.
- **Single-source-per-day**: Daily step, heart-rate, and active-energy series (`metrics_series` and dashboard aggregates in `src/db/queries.ts`) select one device source per local day so iPhone and Apple Watch readings are never double-counted.
- **Sleep stages**: Category rows map to `1` InBed, `2` Asleep, `3` Awake, `4` Core, `5` Deep, `6` REM. Segments before `12:00` local time attribute to the previous evening, overlapping same-stage intervals merge, and `InBed` is excluded from sleep duration totals.
- **Correlation children**: Skipped during XML parsing because Apple emits those records at top level as well.

## Repository Layout

```text
src/
├── app/                 App Router pages (/, /setup, /login, /nutrition/*, /training/*, /workouts/*,
│                        /supplements/*, /measurements, /explorer, /uploads, /profile, /settings/*)
│                        and API routes (/api/{auth,health,upload,type-stats,reminders,agent,mcp,settings,export,backup})
├── components/          Dashboard cards, Recharts graphs, ECG viewer, nutrition/training/settings forms, ui/
├── db/                  schema.ts, index.ts (WAL + migrate-on-boot), queries.ts, guard.ts
├── lib/
│   ├── auth.ts          scrypt hashing, HMAC-SHA256 session cookies, rate limiting
│   ├── auth-config.ts   3-state credential loader (unconfigured / env / SQLite)
│   ├── day.ts           IANA timezone local-day helpers (default UTC)
│   ├── xml.ts / gpx.ts / ecg.ts / ingest.ts
│   └── services/        Shared domain services for UI and Agent/MCP endpoints
├── proxy.ts             Auth gate, MCP enable/LAN gate, Host/Origin checks, no-store headers
└── instrumentation.ts   Boot-time credential validation
drizzle/                 Additive SQLite migrations
plugins/healthvault/     Standalone @healthvault/mcp stdio server (53 tools, resources, prompts)
rust/                    Optional Rust XML/ingest crates (ingest-rs, xml-rs)
scripts/                 password.ts, backup-db.ts, migrate-db.ts, seed-synthetic.ts
deploy/                  Systemd user unit examples, Caddyfile.example, deploy/README.md
```
