## Summary

<!-- What does this PR change, and why? -->

## Changelog

This is a monorepo — update the changelog for the component you changed, or mark N/A:

- [ ] **us-congress** — added a line under `[Unreleased]` in [`us-congress/CHANGELOG.md`](../us-congress/CHANGELOG.md)
- [ ] **mcp-server** — added a line under `[Unreleased]` in [`mcp-server/CHANGELOG.md`](../mcp-server/CHANGELOG.md)
- [ ] **N/A** — not consumer-facing (internal tooling / CI / infra / docs)

<!--
Each changelog records only what its consumers can see, using the Keep a Changelog
headings (Added / Changed / Deprecated / Removed / Fixed / Security):

- us-congress — for GraphQL API consumers: new/changed types, fields, enums, filters,
  connections; deprecations/removals; query behavior (rate/depth/complexity limits,
  pagination, errors); data coverage.
- mcp-server — for the published PyPI package: the MCP tool surface (tools/arguments
  added, changed, or removed), tool behavior, and packaging (e.g. supported Python
  versions).

Both components follow SemVer; mcp-server is pre-1.0, so breaking changes bump the
minor. Entries accrue under `[Unreleased]` and are stamped with a version at release
time. See the top of each CHANGELOG.md for scope.
-->

## Checks

- [ ] CI is green — lint + tests for the affected component
