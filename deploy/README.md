# HealthVault production deployment

> Host-specific doc: this describes the maintainer's long-running systemd host. For the generic,
> host-agnostic production setup (fresh machine, bun only), see the Installation section in the
> main `README.md`.

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

The tracked definitions are `deploy/systemd/healthvault.service`,
`deploy/systemd/healthvault-backup.service` and `deploy/systemd/healthvault-backup.timer`. Install
them as user units and reload systemd:

```bash
ln -sfn /home/tunitz/projects/healthvault/deploy/systemd/healthvault.service \
  ~/.config/systemd/user/healthvault.service
ln -sfn /home/tunitz/projects/healthvault/deploy/systemd/healthvault-backup.service \
  ~/.config/systemd/user/healthvault-backup.service
ln -sfn /home/tunitz/projects/healthvault/deploy/systemd/healthvault-backup.timer \
  ~/.config/systemd/user/healthvault-backup.timer
systemctl --user daemon-reload
systemctl --user restart healthvault
systemctl --user enable --now healthvault-backup.timer
```

The app unit requires the auth credentials and fails fast without them:
`EnvironmentFile=%h/.config/healthvault/auth.env` (0600: `HEALTHVAULT_PASSWORD_HASH`,
`HEALTHVAULT_SESSION_SECRET`, optional `HEALTHVAULT_COOKIE_SECURE` / `HEALTHVAULT_SESSION_DAYS`).
`UMask=0077` keeps files created by the service owner-only. The backup timer runs
`bun run db:backup` daily at 03:30 (persistent catch-up) and prunes backups older than 14 days.

Credentials are managed with the repo script — on this host it targets
`~/.config/healthvault/auth.env` automatically because that file exists (the target is always
printed; `--file` overrides):

```bash
cd /home/tunitz/projects/healthvault
bun run password:set && systemctl --user restart healthvault
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

## TLS

Plain HTTP exposes the login password in transit on the LAN. For anything beyond a
trusted network, terminate TLS in front of the service (see `deploy/Caddyfile.example`) and set
`HEALTHVAULT_COOKIE_SECURE=1` in `~/.config/healthvault/auth.env` so the session cookie is
Secure-only.

## Agent API

`POST /api/agent/<tool>` (JSON in/out) serves the profile, measurements, food log, nutrition,
supplements and read-only health metrics. It is **credential-less** by design: no token and no
cookie, so any host that can reach `127.0.0.1:3040` / the LAN address can use it. Keep the service
on a trusted LAN, never port-forward it, and put an authenticating proxy in front if it must be
reachable beyond that. `GET /api/agent` lists the tools. The MCP server in `plugins/healthvault/`
needs no token either; if a tool reports a connection error, start the service with
`systemctl --user start healthvault`.

`--token-file` is still accepted by `bun run password:set` and ignored (no token file is read or
written); old scripts and `HEALTHVAULT_API_TOKEN*` variables keep working but have no effect.

A trusted LAN is not a browser security boundary: with no Host/Origin allowlist, DNS rebinding lets
a malicious page point its own hostname at the LAN address and drive the credential-less API. Do not
treat network location as a browser control; front the service with a proxy that enforces a Host or
Origin allowlist if that matters.

### Upgrade order for the token removal

Rebuild and restart this server **before** updating the MCP client. The previous server build still
requires `Authorization: Bearer`, and the new client sends no token, so calls return 401 until the
server restart. Keep the old token file until then if clients run continuously. Rollback has the
mirror constraint: restart the old server before reverting the client, because the new client cannot
authenticate to an old server.

## Verification after deploy

```bash
# public health, no auth
curl -s http://127.0.0.1:3040/api/health                          # {"ok":true}
# anonymous page -> redirect to /login
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:3040/
# anonymous API -> 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3040/api/type-stats
# agent: no credentials required -> 200 (trusted-LAN surface)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3040/api/agent
curl -s -X POST http://127.0.0.1:3040/api/agent/healthvault_context \
  -H 'content-type: application/json' -d '{}' | head -c 200
# login round-trip
curl -s -c /tmp/hv.jar -X POST http://127.0.0.1:3040/api/auth/login \
  -H 'content-type: application/json' -d '{"password":"..."}'   # {"ok":true}
curl -s -b /tmp/hv.jar -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3040/   # 200
rm -f /tmp/hv.jar
# backup timer armed
systemctl --user list-timers healthvault-backup.timer
```

Migrations run on boot; adding the tracking tables is additive and leaves the imported Apple
tables untouched.
