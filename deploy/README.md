# HealthVault production deployment

Production uses the normal Next.js server output. `bun run build` (`next build`)
writes `.next/`; the service runs `next start` from this directory. There is no
standalone or single-binary build, and no Bun native compilation.

## Build

```bash
cd /home/tunitz/projects/healthvault
systemctl --user stop healthvault
bun run build
systemctl --user start healthvault
```

Stop the service before rebuilding: Next uses `cleanDistDir`, so the running
server's `.next/` chunks are replaced. The current `.next/` build is valid as long
as `src/`, `next.config.ts`, and `package.json` are older than `.next/BUILD_ID`.

The build must not modify production data. `src/db/index.ts` opens and migrates on
import; the app's pages are dynamic and are not prerendered, but if a build is
suspected of touching the database, isolate it with a scratch path:

```bash
DATABASE_PATH=/tmp/healthvault-build/health.db bun run build
```

## Runtime

- `WorkingDirectory=/home/tunitz/projects/healthvault`
- `.next/`, `node_modules/`, `public/`, `drizzle/`, `next.config.ts`, `package.json`
  are all required at runtime.
- `DATABASE_PATH=/home/tunitz/projects/healthvault/data/health.db` (git-ignored)
- `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `PORT=3040`, `HOSTNAME=0.0.0.0`
- Bun runs the Next server (`bun --bun ... next start`); keep this runtime.
- Migrations run from `drizzle/` at boot.

## Service unit

The tracked definition is `deploy/systemd/healthvault.service`. Install it as a
user unit and reload systemd:

```bash
ln -sfn /home/tunitz/projects/healthvault/deploy/systemd/healthvault.service \
  ~/.config/systemd/user/healthvault.service
systemctl --user daemon-reload
systemctl --user restart healthvault
```

Do not commit `.next/`, `data/`, or `node_modules/`.

## Backup and restore

The app runs SQLite in WAL mode, so do not copy `data/health.db` alone while the service is up.
Use the online backup script (integrity-checked, WAL-safe, mode 600):

```bash
cd /home/tunitz/projects/healthvault
bun run db:backup                      # data/backups/health-<timestamp>.db
```

Restore: stop the service, replace `data/health.db`, remove stale `health.db-wal` /
`health.db-shm` files, then start the service. The data directory should stay mode 700 and the
database 600.

## Agent API

`POST /api/agent/<tool>` (JSON in/out) serves the profile, measurements, food log, nutrition,
supplements and read-only health metrics. It is intentionally unauthenticated on the LAN-bound
service. `GET /api/agent` lists tools. The OpenCode plugin in `plugins/opencodev2/` talks to
`http://127.0.0.1:3040`; if it reports a connection error, start the service with
`systemctl --user start healthvault`.

## Verification after deploy

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3040/
curl -s http://127.0.0.1:3040/api/agent | head -c 400
curl -s -X POST http://127.0.0.1:3040/api/agent/healthvault_context \
  -H 'content-type: application/json' -d '{}' | head -c 400
```

Migrations run on boot; adding the tracking tables is additive and leaves the imported Apple
tables untouched.
