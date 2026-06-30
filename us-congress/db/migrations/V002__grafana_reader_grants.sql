-- =============================================================================
-- V002 — grafana_reader read grants
--
-- The grafana_reader ROLE itself is created at initdb from
-- db/roles/grafana_reader.sh. Its read GRANTS live here, in a migration, because
-- they track the schema: a blanket SELECT on everything in `public` now, plus
-- ALTER DEFAULT PRIVILEGES so tables added by future migrations are covered
-- automatically — minus api_keys, which holds live secrets.
--
-- This runs as the migration user (POSTGRES_USER), which also owns the tables
-- created by migrations and the ingester, so the default-privileges grant applies
-- to the objects that role creates going forward.
--
-- CAVEAT: any FUTURE table holding sensitive data must be explicitly REVOKE'd
-- here (like api_keys), because ALTER DEFAULT PRIVILEGES auto-grants new tables.
-- =============================================================================

GRANT CONNECT ON DATABASE "${flyway:database}" TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;

-- All current tables and views in public (includes the aggregation views and the
-- precomputed aggregate tables — previously missing from the hand-maintained list):
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_reader;

-- …and everything created in public hereafter, so the grant never goes stale:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_reader;

-- api_keys holds live API keys — never expose it to the analytics reader.
REVOKE ALL ON api_keys FROM grafana_reader;
