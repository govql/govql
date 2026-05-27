#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE grafana_reader WITH LOGIN PASSWORD '$GRAFANA_READER_PASSWORD';
  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO grafana_reader;
  GRANT USAGE ON SCHEMA public TO grafana_reader;
  GRANT SELECT ON TABLE
    legislators,
    legislator_terms,
    committees,
    bills,
    votes,
    vote_positions,
    bill_cosponsors,
    bill_committees,
    committee_memberships,
    ingestion_runs
  TO grafana_reader;
SQL
