#!/bin/sh
# Apply Prisma migrations, then start the application. Never creates an owner:
# run `docker compose exec app npm run bootstrap -- ...` explicitly after first boot.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  attempt=1
  until npx prisma migrate deploy; do
    if [ "$attempt" -ge 30 ]; then
      echo "database migrations failed after ${attempt} attempts" >&2
      exit 1
    fi
    echo "database not ready (attempt ${attempt}); retrying in 2s..." >&2
    attempt=$((attempt + 1))
    sleep 2
  done
fi

exec "$@"
