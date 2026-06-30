#!/bin/sh
# Advance a source's `fetch` cursor to now() after a successful scrape.
#
# Usage: write-fetch-cursor.sh <source_name>
#
# This is the producer side of the fetch→load handshake: the load stage (the
# ingesters) runs only once this cursor has advanced past what it last consumed.
# Call it ONLY on a successful scrape, so a failed scrape leaves the cursor
# unadvanced and the load stage correctly waits. Exits non-zero on any failure
# (missing arg, unreachable DB) so callers can gate on it — e.g. skip the
# scrape healthcheck when the cursor write failed.
set -e

SOURCE_NAME="$1"
if [ -z "$SOURCE_NAME" ]; then
  echo "write-fetch-cursor.sh: missing source_name argument" >&2
  exit 2
fi

# Pass the source name as a psql variable and interpolate it with :'src', which
# quotes it as a SQL string literal (doubling any embedded quotes) — so a source
# name can never break out of the literal and inject SQL. Today's callers pass
# hardcoded literals, but the scraper holds full DB credentials, so this keeps the
# script safe if a future caller ever passes a dynamic/config-derived name.
#
# The SQL is fed on stdin (quoted heredoc), NOT via `psql -c`: psql only performs
# `:'var'` interpolation on stdin/file input, not on `-c` command strings.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v src="$SOURCE_NAME" <<'SQL'
INSERT INTO source_state (source_name, stage, cursor, updated_at)
VALUES (:'src', 'fetch', now(), now())
ON CONFLICT (source_name, stage)
  DO UPDATE SET cursor = now(), updated_at = now();
SQL

echo "$(date): advanced fetch cursor for ${SOURCE_NAME}"
