#!/bin/bash
set -e

DATABASE_URL="postgres://databank:databank@localhost:5432/databank?sslmode=disable"
export DATABASE_URL

# 1. Start PostgreSQL via the official entrypoint.
#    It handles initdb, POSTGRES_DB creation, init scripts, then execs postgres.
#    We background it so we can layer dbmate + bun on top.
docker-entrypoint.sh postgres &
PG_PID=$!

# 2. Wait for PG to be fully ready.
#    The official entrypoint has a 2-phase lifecycle on first run:
#      Phase 1: temp PG → create DB, run init scripts → stop
#      Phase 2: start real PG
#    pg_isready can return true during Phase 1, so we also verify
#    the actual database is connectable.
for i in $(seq 1 60); do
  if pg_isready -U databank -d databank -q 2>/dev/null && \
     psql -U databank -d databank -c '\q' 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Verify PG is actually up
if ! psql -U databank -d databank -c '\q' 2>/dev/null; then
  echo "ERROR: PostgreSQL did not become ready" >&2
  exit 1
fi

# 3. Run dbmate migrations
dbmate --no-dump-schema up

# 4. Seed starter data (requires the app + embedder to be running)
bun run src/index.ts &
APP_PID=$!

for i in $(seq 1 30); do
  if curl -sf http://localhost:4000/graphql -o /dev/null 2>/dev/null; then
    break
  fi
  sleep 0.5
done

DATABANK_URL="http://localhost:4000/graphql" bun run db/seeds/load.ts || true
kill $APP_PID 2>/dev/null || true
wait $APP_PID 2>/dev/null || true

# 5. Start the Databank app (replaces this shell, becomes PID 1 equivalent)
exec bun run src/index.ts
