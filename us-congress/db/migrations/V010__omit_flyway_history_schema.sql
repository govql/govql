-- Issue #66: Remove `flyway_schema_history` from the public PostGraphile schema

COMMENT ON TABLE flyway_schema_history IS E'@omit';