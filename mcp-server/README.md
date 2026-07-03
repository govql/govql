# govql-mcp-server

An MCP (Model Context Protocol) server for [GovQL](https://govql.us) — gives
AI clients like Claude Desktop, Claude Code, and Cursor direct access to the
US Congressional GraphQL API at [api.govql.us/graphql](https://api.govql.us/graphql)
without bespoke HTTP wiring.

For the design rationale (why FastMCP-Python, the passthrough+curated philosophy,
roadmap through v0.4), see
[design.md](https://github.com/govql/govql/blob/main/mcp-server/docs/design.md).

## What you can do with it

Ask an agent questions like:

- *"How did Vermont's two senators vote on the most recent nomination?"*
- *"Which legislators in the 118th Congress switched parties during their service?"*
- *"Compare Senator Sanders' voting record to Senator Murkowski's on cloture votes
   in the most recent Congress."*
- *"Which Democrats most often voted with Republicans in the current Congress?"*

The agent picks the right tool, writes the GraphQL query against the live
schema, and parses the response — no manual API wrangling.

## Install

The server runs as a per-client subprocess over stdio. Pick your client:

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "govql": {
      "command": "uvx",
      "args": ["govql-mcp-server"]
    }
  }
}
```

Restart Claude Desktop. The `govql` tools appear in the tools panel.

### Claude Code

Add to `.mcp.json` in your project (or `~/.mcp.json` for global):

```json
{
  "mcpServers": {
    "govql": {
      "command": "uvx",
      "args": ["govql-mcp-server"]
    }
  }
}
```

### Cursor

Settings → MCP → Add Server. Use the same `command` / `args` as above.

### Other clients

Any MCP-compatible client that supports stdio servers will work. The command
is `uvx govql-mcp-server` with no required arguments.

## Tools

| Tool | Purpose |
|---|---|
| `execute_graphql` | Run any GraphQL query against the GovQL endpoint. Returns the result plus an `last_ingest` timestamp so the agent can reason about data freshness. |
| `list_types` | Returns the names and kinds of every type in the GovQL schema. Optional `kind` filter (`"OBJECT"`, `"INPUT_OBJECT"`, `"ENUM"`, etc.) to narrow further. Start here when you don't know what's queryable. |
| `describe_type` | Returns one type's full details — fields, arg signatures, input fields, enum values. Call after `list_types` to learn the shape of a specific type before writing a query. |

## Configuration

All env vars are optional — the package is zero-config for end users.

| Env var | Default | Purpose |
|---|---|---|
| `GOVQL_ENDPOINT` | `https://api.govql.us/graphql` | Endpoint to query. Override to point at a local dev stack. |
| `GOVQL_TIMEOUT_MS` | `30000` | Per-request HTTP timeout. |
| `LOG_LEVEL` | `INFO` | Logging level. Logs go to stderr only (stdout is reserved for the MCP transport). |

## Limits (enforced by the upstream API)

- Max query depth: 10
- Max query complexity: ~10 billion points (`first: N` multiplies child cost
  by N — keep page sizes reasonable on deeply nested queries)
- Rate limit: 100 requests / 60 s per source IP

A depth or complexity violation surfaces as a GraphQL `errors` entry in the
tool response so the agent can adjust and retry.

## Data freshness

Every `execute_graphql` response includes a `last_ingest` ISO timestamp.
Vote data refreshes hourly; legislator data refreshes daily.

## Status

As of 0.1.1, the server provides three foundational tools: a GraphQL passthrough
(`execute_graphql`) and two narrow schema-discovery tools (`list_types`,
`describe_type`). Curated higher-level tools (`find_legislator`,
`get_voting_record`, `compare_voters`, etc.) are planned for subsequent
releases — see
[design.md](https://github.com/govql/govql/blob/main/mcp-server/docs/design.md)
for the roadmap.

## Links

- [GovQL project site](https://govql.us)
- [GraphQL API](https://api.govql.us/graphql)
- [Source / issues](https://github.com/govql/govql)
