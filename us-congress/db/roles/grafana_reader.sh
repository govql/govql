#!/bin/bash
set -euo pipefail

# Creates the grafana_reader service-account ROLE (login + password).
#
# This runs via docker-entrypoint-initdb.d, i.e. ONLY when the postgres data
# volume is first initialised (a fresh/empty database). It does NOT run on
# subsequent `docker compose up`s. Editing this file therefore only affects FRESH
# databases — to change the role on a live database (rotate the password, add a
# new service account), apply the change manually (ALTER ROLE / a one-off psql).
#
# This directory (db/roles/) is the tracked source of truth for the EXISTENCE of
# service-account roles. Their PERMISSIONS (grants) are NOT here — they live in a
# Flyway migration (db/migrations/V002__grafana_reader_grants.sql) because grants
# track the schema, whereas the role is secret-bearing, cluster-global infra.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    CREATE ROLE grafana_reader WITH LOGIN PASSWORD '$GRAFANA_READER_PASSWORD';
  END IF;
END
\$\$;
SQL
