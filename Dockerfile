# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-alpine AS bun-bin

FROM node:${NODE_VERSION}-alpine AS deps
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
RUN --mount=type=cache,target=/etc/apk/cache,sharing=locked \
    apk add python3 make g++
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile && \
    npm rebuild better-sqlite3 && \
    node -e "const Database = require('better-sqlite3'); new Database(':memory:').close();"

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN bun run build

FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/tunitz/healthvault" \
      org.opencontainers.image.description="HealthVault personal health analytics dashboard"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3040 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/health.db
WORKDIR /app

COPY --from=build --link --chown=1000:1000 /app/.next/standalone ./
COPY --from=build --link --chown=1000:1000 /app/.next/static ./.next/static
COPY --from=build --link --chown=1000:1000 /app/public ./public
COPY --from=build --link --chown=1000:1000 /app/drizzle ./drizzle

# /data holds health.db (bind-mounted from the host in compose). Owned by the
# image's non-root `node` user (uid/gid 1000).
RUN mkdir -p /data && chown node:node /data /app
VOLUME /data

USER node
EXPOSE 3040

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3040/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
