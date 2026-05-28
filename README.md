<img
  src="./govql-social-card.svg" 
  alt="GovQL Logo"
  width="640" />

# USA - Federal Government Data

## Making Government Data Available in GraphQL

Lots of government data is available, but that doesn't mean it's easy to access
and extract insights from it. This project is an attempt to rectify that.

- **API**: [api.govql.us/graphql](https://api.govql.us/graphql) — GraphQL API with Ruru explorer
- **Site**: [govql.us](https://govql.us) — documentation and usage guide

## Repo structure

This repo is a monorepo containing two sub-projects:

- [`us-congress/`](us-congress/) — the GovQL GraphQL API (JavaScript / PostGraphile), plus the Docusaurus docs site.
- [`mcp-server/`](mcp-server/) — the GovQL MCP Server (Python / FastMCP). Lets AI clients like Claude Desktop, Claude Code, and Cursor query the API directly.

They are deployed independently and depend on each other only at runtime via HTTP.

See [us-congress/README.md](us-congress/README.md) for local development and deployment of the API, and [mcp-server/README.md](mcp-server/README.md) / [mcp-server/CONTRIBUTING.md](mcp-server/CONTRIBUTING.md) for the MCP server.
