# Contributing to HealthVault

Thank you for considering a contribution to HealthVault!

## Prerequisites

- [Bun](https://bun.sh/) **1.4.2+** (use Bun rather than `npm`/`pnpm`/`yarn`).
- [Rust](https://www.rust-lang.org/) toolchain (optional, only if modifying `rust/ingest-rs` or `rust/xml-rs`).

## Local Setup

```bash
git clone https://github.com/tunitz/healthvault.git
cd healthvault
bun install --frozen-lockfile
bun run password:set   # or use /setup in the browser on first run
bun run dev
```

## Verification Checklist

Run these checks before opening a pull request:

```bash
mkdir -p /tmp/opencode
bun run typecheck
bun run lint
bun test --isolate
bun run build
```

Never point tests or seed scripts at `./data/health.db` — the test preload and `src/db/guard.ts` enforce scratch databases under `/tmp/opencode`.

## Branching & Commit Conventions

1. Fork the repository or create a `feature/<name>` branch off `main` (never commit directly to `main`).
2. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`) so Release Please can generate accurate changelogs and versions.
3. Keep Drizzle migrations additive (`drizzle/`), include regression tests for service/API changes, and never commit `.env`, `data/`, `.next/`, or personal health exports.

Automated and AI contributors should also follow [AGENTS.md](AGENTS.md).
