# HealthVault production deployment

> Host-specific doc: this describes the maintainer's long-running systemd host. For the generic,
> host-agnostic production setup (fresh machine, bun only), see the Installation section in the
> main `README.md`.

Production uses the normal Next.js server output. `bun run build` (`next build`)
writes `.next/`; the service runs `next start` from this directory. There is no
standalone or single-binary build, and no Bun native compilation.

## Build

```bash
cd /home/tunitz/Projects/healthvault
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

- `WorkingDirectory=/home/tunitz/Projects/healthvault`
- `.next/`, `node_modules/`, `public/`, `drizzle/`, `next.config.ts`, `package.json`
  are all required at runtime.
- `DATABASE_PATH=/home/tunitz/Projects/healthvault/data/health.db` (git-ignored)
- `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `PORT=3040`, `HOSTNAME=0.0.0.0`
- On bare-metal systemd hosts, Bun runs the Next server (`bun --bun ... next start`);
  in Docker (`Dockerfile`), the build uses Bun while the runtime image executes `next start`
  on Node 22.
- Migrations run from `drizzle/` at boot.

## Service unit

The tracked definitions are `deploy/systemd/healthvault.service`,
`deploy/systemd/healthvault-backup.service` and `deploy/systemd/healthvault-backup.timer`. Install
them as user units and reload systemd:

```bash
ln -sfn /home/tunitz/Projects/healthvault/deploy/systemd/healthvault.service \
  ~/.config/systemd/user/healthvault.service
ln -sfn /home/tunitz/Projects/healthvault/deploy/systemd/healthvault-backup.service \
  ~/.config/systemd/user/healthvault-backup.service
ln -sfn /home/tunitz/Projects/healthvault/deploy/systemd/healthvault-backup.timer \
  ~/.config/systemd/user/healthvault-backup.timer
systemctl --user daemon-reload
systemctl --user restart healthvault
systemctl --user enable --now healthvault-backup.timer
```

The app unit reads optional environment configuration from
`EnvironmentFile=%h/.config/healthvault/auth.env` (0600: `HEALTHVAULT_PASSWORD_HASH`,
`HEALTHVAULT_SESSION_SECRET`, optional agent-token file path, `HEALTHVAULT_ALLOWED_HOSTS`,
`HEALTHVAULT_TRUST_PROXY`, `HEALTHVAULT_COOKIE_SECURE` / `HEALTHVAULT_SESSION_DAYS`).
Note: once credentials are created or rotated in the web UI (`/setup` or Settings → Account/MCP),
the SQLite `auth_credentials` row takes precedence over `.env` / `auth.env`.
`UMask=0077` keeps files created by the service owner-only. The backup timer runs
`bun run db:backup` daily at 03:30 (persistent catch-up) and prunes backups older than 14 days.

Credentials are managed either in the web UI (`/setup`, `/settings/account`, `/settings/mcp`) or
with the repo script — on this host it targets `~/.config/healthvault/auth.env` automatically
because that file exists (the target is always printed; `--file` overrides):

```bash
cd /home/tunitz/Projects/healthvault
bun run password:set && systemctl --user restart healthvault
```

`password:set` creates `~/.config/healthvault/agent.token` (0600) and stores its path in
`auth.env`; the MCP process can read the same file with `HEALTHVAULT_TOKEN_FILE`.
Set `HEALTHVAULT_ALLOWED_HOSTS` in `auth.env` to the exact hostname/IP used by the browser or
client (for example `127.0.0.1,::1,192.168.1.20,healthvault.example.com`). Restart HealthVault after
changing environment settings. Do not use `*`.

Do not commit `.next/`, `data/`, or `node_modules/`.

## Backup and restore

The app runs SQLite in WAL mode, so do not copy `data/health.db` alone while the service is up.
Use the online backup script (integrity-checked, WAL-safe, mode 600) or download a WAL-safe
backup directly from **Settings → Data tools** (`/settings/data-tools`, `GET /api/backup`):

```bash
cd /home/tunitz/Projects/healthvault
bun run db:backup                      # data/backups/health-<timestamp>.db
```

Restore: stop the service, replace `data/health.db`, remove stale `health.db-wal` /
`health.db-shm` files, then start the service. The data directory should stay mode 700 and the
database 600.

## TLS & Reverse Proxy

Plain HTTP exposes the login password in transit on the LAN. For anything beyond a
trusted network, terminate TLS in front of the service (see `deploy/Caddyfile.example`), set
`HEALTHVAULT_COOKIE_SECURE=1` so the session cookie is Secure-only, and set
`HEALTHVAULT_TRUST_PROXY=1` so MCP local-vs-LAN peer detection inspects the leftmost
`X-Forwarded-For` hop written by the reverse proxy.

## Agent API & Streamable HTTP MCP

`POST /api/agent/<tool>` and `POST /api/mcp` (Streamable HTTP JSON-RPC 2.0) serve the 53 tools,
MCP resources, and MCP prompts. Both require a valid bearer token or session cookie, enforce
`HEALTHVAULT_ALLOWED_HOSTS` and same-origin checks, and honor the **Settings → MCP** gate:

- **MCP enabled** (`mcp.enabled`, default on): disables both `/api/agent/*` and `/api/mcp` with 403 when turned off.
- **Allow LAN access** (`mcp.lanEnabled`, default off): blocks non-loopback peers with 403 unless explicitly enabled in **Settings → MCP**.

Keep the service on a trusted LAN, never port-forward it, and put TLS in front for remote access.
`GET /api/agent` lists the tools after authentication. If a tool reports a connection error, start
the service with `systemctl --user start healthvault`.

Use `bun run password:set` to create the private token file. Set
`HEALTHVAULT_TOKEN_FILE=~/.config/healthvault/agent.token` in the MCP process environment; clients
can also receive the token through `HEALTHVAULT_TOKEN`. The server reads `HEALTHVAULT_API_TOKEN_FILE`
or `HEALTHVAULT_API_TOKEN` from `auth.env` (the setup script writes the file path). Restart both
processes after rotating the token.

## Verification after deploy

```bash
# public health, no auth
curl -s http://127.0.0.1:3040/api/health                          # {"ok":true}
# anonymous page -> redirect to /login
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:3040/
# anonymous API -> 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3040/api/type-stats
# agent: no credentials -> 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3040/api/agent
# authenticated agent request -> 200; provide the token via a protected shell environment
curl -s -X POST http://127.0.0.1:3040/api/agent/healthvault_context \
  -H "Authorization: Bearer $HEALTHVAULT_API_TOKEN" \
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
