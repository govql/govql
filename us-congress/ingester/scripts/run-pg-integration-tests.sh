#!/bin/sh
# Runs the *.pg-integration.test.js suite against a throwaway dockerized
# Postgres migrated with the real Flyway migrations, then tears it down.
# Under plain `npm test` these tests skip themselves (INTEGRATION_DATABASE_URL
# unset); this script is the only thing that sets it.
set -eu

PORT=55441
NAME=govql-pg-integration
PG_IMAGE=postgres:16-alpine
FLYWAY_IMAGE=flyway/flyway:12.9.0-alpine
DIR=$(cd "$(dirname "$0")/.." && pwd)
MIGRATIONS="$DIR/../db/migrations"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run --rm -d --name "$NAME" -e POSTGRES_PASSWORD=integration -p "$PORT":5432 "$PG_IMAGE" >/dev/null

echo "waiting for postgres..."
# Probe over TCP (-h): the image's init phase runs a temporary socket-only
# server that a bare pg_isready would answer for, racing the real server's
# start — only the final, TCP-listening server passes this check.
i=0
until docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 30 ] && { echo "postgres did not come up"; exit 1; }
  sleep 1
done

# Roles the migrations' GRANT statements expect (created by the real stack's
# init scripts, absent on a bare postgres image). Connect over TCP like the
# readiness probe — the socket may still belong to the init-phase server.
docker exec "$NAME" psql -h 127.0.0.1 -U postgres -q -c "CREATE ROLE grafana_reader LOGIN PASSWORD 'x';" >/dev/null

docker run --rm --network host -v "$MIGRATIONS":/flyway/sql "$FLYWAY_IMAGE" \
  -url="jdbc:postgresql://localhost:$PORT/postgres" -user=postgres -password=integration \
  migrate >/dev/null

echo "running pg integration tests..."
INTEGRATION_DATABASE_URL="postgres://postgres:integration@localhost:$PORT/postgres" \
  node --test "$DIR"/src/connectors/*.pg-integration.test.js
