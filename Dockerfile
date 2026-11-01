# syntax=docker/dockerfile:1.7
# ---------- dependencies / build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Non-secret placeholders so `next build` never bakes real credentials into an image.
ENV NODE_ENV=production \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public \
    APP_URL=https://build.invalid \
    APP_SECRET=build-only-placeholder-secret-0123456789 \
    MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    MASTER_KEY_ID=build \
    COOKIE_SECURE=true \
    EMAIL_TRANSPORT=console
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    UPLOAD_DIR=/app/uploads \
    BACKUP_DIR=/app/backups

# pg_dump/pg_restore are needed for encrypted backups; tini reaps child processes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl postgresql-client tini curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/next.config.mjs /app/postcss.config.mjs /app/tailwind.config.ts /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/server.js /app/server-gzip.cjs ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p uploads backups \
  && chown -R node:node uploads backups

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
