# syntax=docker/dockerfile:1
# Production image for HealthVault: Next.js `next start` on Node 22.
# Deps and the build run under bun (bun.lock); the runtime is plain node.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG BUN_VERSION=1.4.2

# ---- base: node + bun -------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG BUN_VERSION
RUN npm install -g bun@${BUN_VERSION} \
 && bun --version
WORKDIR /app

# ---- deps: install from the lockfile only (better-sqlite3 ships linux prebuilds)
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- build: next build (migrations run at prerender into the build-stage ./data, not shipped)
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN bun run build

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3040 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/health.db
WORKDIR /app

COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json /app/next.config.ts ./

# /data holds health.db (bind-mounted from the host in compose). Owned by the
# image's non-root `node` user (uid/gid 1000).
RUN mkdir -p /data && chown node:node /data /app
VOLUME /data

USER node
EXPOSE 3040

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3040/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3040"]
