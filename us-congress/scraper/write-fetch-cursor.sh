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

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO source_state (source_name, stage, cursor, updated_at)
   VALUES ('$SOURCE_NAME', 'fetch', now(), now())
   ON CONFLICT (source_name, stage)
     DO UPDATE SET cursor = now(), updated_at = now();"

echo "$(date): advanced fetch cursor for ${SOURCE_NAME}"
