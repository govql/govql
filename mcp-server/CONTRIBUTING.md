# Contributing to govql-mcp-server

This is the Python sub-project of the [GovQL monorepo](https://github.com/govql/govql).
The rest of the repo (under `us-congress/`) is JavaScript; this package is
deliberately self-contained.

## Quick start

You'll need [uv](https://github.com/astral-sh/uv) (the Python package
manager). Install it with the one-liner from its README, then:

```bash
uv sync              # install deps into a local .venv
uv run pytest        # run the test suite
uv build             # build wheel + sdist for publishing
```

uv reads `.python-version` (currently `3.14`) to pick the interpreter; if
you don't have it installed it will fetch it automatically.

## Layout

- `src/govql_mcp_server/` — the package
  - `server.py` — FastMCP instance; importing the tools modules registers them
  - `graphql_client.py` — thin httpx wrapper around the GovQL endpoint
  - `tools/` — one file per tool
  - `logger.py` — stderr-only logging (stdout is the MCP transport — see
    "Hard rule" below)
- `tests/` — pytest suite using FastMCP's in-memory client
- `docs/design.md` — why the project exists, what's in / out of scope, roadmap

## Hard rule: never write to stdout

stdout is the MCP transport. Any stray `print()` corrupts the JSON-RPC
framing and silently breaks every client. Use the logger
(`from .logger import logger`). The test suite includes
`tests/test_no_stdout.py` which fails the build if anything in the package
writes to stdout.

## Adding a new tool

Each tool gets its own file in `src/govql_mcp_server/tools/` and its own
test file in `tests/`. Pattern:

1. Create `tools/your_tool.py`. Import `mcp` from `..server` and decorate
   an async function with `@mcp.tool`.
2. Add the module to the import line at the bottom of `server.py` so the
   decorator runs at startup.
3. Add `tests/test_your_tool.py` using the in-memory `client` fixture from
   `conftest.py`.
4. Update `README.md`'s tools table and `CHANGELOG.md`.
