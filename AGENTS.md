<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project

HealthVault is a Next.js 16 + SQLite (`better-sqlite3` + Drizzle ORM) personal health analytics dashboard.

## Local development and verification

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test --isolate
bun run build
```

Never touch live `data/health.db*` files or commit `.env`, `data/`, or `.next/`.

## Docker, CI & Releases

- **`Dockerfile`** builds a minimal `node:22-alpine` runtime image using Next.js `output: "standalone"` (compiling `better-sqlite3` for musl in the builder stage and copying `.next/standalone`, `.next/static`, `public/`, and `drizzle/`).
- **`compose.yaml`** pulls `ghcr.io/tunitz/healthvault:${IMAGE_TAG:-latest}` and bind-mounts `./data:/data` as `1000:1000`.
- **`compose.build.yaml`** overrides the image to build locally: `docker compose -f compose.yaml -f compose.build.yaml up -d --build`.
- **`.github/workflows/ci.yml`** runs typecheck, lint, tests, Next.js build, and a non-pushing Docker build check on PRs to `main`.
- **`.github/workflows/release.yml`** runs Release Please on `main` pushes, publishes `ghcr.io/tunitz/healthvault` (`linux/amd64`) to GHCR, and attaches `healthvault-<tag>-linux-x64.tar.gz` + `SHA256SUMS.txt` on release creation.

## Git & Branching Rules (Mandatory)

1. **Never commit or push directly to `main`.** All changes must go through a feature branch and Pull Request.
2. **Pull `main` first** before starting any work:
   ```bash
   git checkout main && git pull --ff-only origin main
   ```
3. **Create a `feature/<name>` branch** for all changes (e.g., `feature/sleep-trends`), and push only `feature/<name>`.
4. **Use Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `feat!:`) so Release Please auto-versions releases accurately.
