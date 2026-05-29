# Releasing govql-mcp-server

The steps to ship a new version. Written for v0.1.0 but reusable for subsequent
releases — just substitute the version number throughout.

All commands assume you're in `mcp-server/` unless noted otherwise.

---

## 0. Prerequisites (one-time setup)

Skip this section if you've published before.

### PyPI account + token

1. Create an account at [pypi.org](https://pypi.org/account/register/) (and
   verify your email).
2. Enable 2FA — PyPI requires it for publishers.
3. Create a **scoped API token**:
   [pypi.org/manage/account/token/](https://pypi.org/manage/account/token/).
   First release: scope to "Entire account" (the package doesn't exist yet so
   you can't scope to it). After v0.1.0 is up, **revoke that token and create
   a new one scoped to the `govql-mcp-server` project only.**
4. Store the token somewhere you'll find it again. For local releases, the
   easiest path is to export it before publishing:
   ```bash
   export UV_PUBLISH_TOKEN="pypi-AgEI..."
   ```
   If you'd rather not type this every time, drop it in your shell's
   per-project environment (e.g. `.env` with dotenvx, or direnv).

### MCP registry (mcp.so) account

You'll need a free account at [mcp.so](https://mcp.so) to submit the listing
in step 4. Sign up now if you haven't.

---

## 1. Pre-flight checks

Run from `mcp-server/`. All of these should pass before you go further.

```bash
# Tests green
uv run pytest

# Build artifacts clean (no stale files from a previous build)
rm -rf dist/
uv build

# Wheel contents look right — should only contain govql_mcp_server/ and a dist-info
unzip -l dist/govql_mcp_server-0.1.0-py3-none-any.whl

# Sdist contents look right — full source tree including tests/, docs/, CHANGELOG
tar tzf dist/govql_mcp_server-0.1.0.tar.gz
```

Quick checklist of things to eyeball:

- `CHANGELOG.md` has an entry for the version you're about to release
- `pyproject.toml`'s `version` matches that CHANGELOG entry
- `README.md` describes the *current* tool set (no "coming soon" wording)
- No half-finished branches or commented-out code on the release commit

---

## 2. Real MCP client test (gate before publishing)

This is the only test that proves "an actual agent can use this." Don't
publish without it.

Pick a client. **Claude Desktop** is recommended for the first release because
it makes the tool calls visible in the UI.

### Wire up the *local* build (not the PyPI version)

```bash
# Confirm the local entry point works
GOVQL_ENDPOINT=https://api.govql.us/graphql uv run govql-mcp-server
# (Ctrl-C to stop — you're just confirming it starts cleanly. No prompt means it's
# waiting on stdin for MCP messages, which is correct.)
```

In Claude Desktop, edit `claude_desktop_config.json` (Settings → Developer →
Edit Config) and add an entry pointing at this checkout:

```json
{
  "mcpServers": {
    "govql-local": {
      "command": "uv",
      "args": [
        "--directory",
        "/home/astout5/govql/mcp-server",
        "run",
        "govql-mcp-server"
      ]
    }
  }
}
```

Restart Claude Desktop. Confirm `govql-local` shows up in the tools panel
with `execute_graphql`, `list_types`, and `describe_type` listed.

### The test prompt

Ask:

> *How did Vermont's two senators vote on the most recent nomination?*

Expected behavior:

1. The agent calls `list_types` / `describe_type` as needed (or already
   knows the schema from a prior session).
2. It writes a query against `allVotes` + `votePositions` filtering for
   Vermont senators and the latest nomination.
3. It returns a concise answer naming both senators and their positions.

If anything is off (the agent gets confused, the query fails, the answer is
wrong), fix it before publishing — the issue is almost certainly in the
`execute_graphql` docstring in
`src/govql_mcp_server/tools/passthrough.py`, which is the agent's primary
guide.

### Capture the transcript

Once it works, copy the transcript into `README.md` under a "Try it" or
"Example" section so PyPI visitors see a concrete demo on the project page.
Commit the README change before publishing.

### Remove the local config

After the test, remove the `govql-local` entry from
`claude_desktop_config.json` so you don't have two GovQL servers competing
once the real one is installed.

---

## 3. Publish to PyPI

```bash
# 1. Re-build with the final README/CHANGELOG/version in place.
rm -rf dist/
uv build

# 2. Publish. UV_PUBLISH_TOKEN must be set (see Prerequisites).
uv publish

# 3. Verify it's live by installing it in a throwaway location.
#    Should print version 0.1.0 and exit cleanly (subprocess waits on stdin
#    for MCP messages; just confirm it starts).
uvx --refresh govql-mcp-server --help 2>&1 | head -5
```

If the publish fails on `name already exists`: someone took the name. Pick
one of the fallbacks from the original plan (`govql`, `mcp-govql`,
`govql-mcp`), update `pyproject.toml` + every README install snippet to match,
re-run pre-flight, and try again.

---

## 4. Tag the release in git

From the **repo root** (not `mcp-server/`):

```bash
cd /home/astout5/govql

# Sanity: the working tree should be clean and on the merge commit that includes the release.
git status
git log -1 --oneline

# Tag and push.
git tag -a govql-mcp-server-v0.1.0 -m "govql-mcp-server v0.1.0"
git push origin govql-mcp-server-v0.1.0
```

The tag is namespaced with `govql-mcp-server-` so it doesn't collide with
future tags for other sub-projects (e.g. a hypothetical
`us-congress-api-v1.0.0`).

---

## 5. Submit to the MCP registry (mcp.so)

1. Log into [mcp.so](https://mcp.so).
2. Click "Submit MCP Server" (or whatever the current entry point is called).
3. Fill in:
   - **Name:** `govql`
   - **Description:** "MCP server for GovQL — query US Congressional voting
     data (legislators, roll-call votes, etc.) via GraphQL from any MCP
     client."
   - **GitHub URL:** `https://github.com/govql/govql/tree/main/mcp-server`
   - **Install / config snippet** (JSON):
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
4. Submit and wait for moderation (typically a few hours to a few days).
5. Once approved, copy the registry URL into the next CHANGELOG entry under
   the relevant version so future contributors can find it.

---

## 6. Post-release sanity checks

About 5 minutes after `uv publish`:

```bash
# Confirm the package is visible on PyPI.
curl -sS https://pypi.org/pypi/govql-mcp-server/json | jq '.info.version, .info.home_page'

# Confirm a fresh install from PyPI works (use --refresh to bypass uv's cache).
uvx --refresh --from govql-mcp-server==0.1.0 govql-mcp-server --help 2>&1 | head -5
```

Then in Claude Desktop, replace the local-build config with the PyPI version
(the snippet in `README.md`) and re-run the Vermont prompt to confirm the
published artifact behaves identically to the local build.

---

## 7. Graceful-exit check

Before stopping work, confirm every item below — this is the discipline that
makes a paused-mid-project portfolio piece still look intentional:

- [ ] Latest version is on PyPI
- [ ] Matching git tag is pushed
- [ ] `CHANGELOG.md` has the entry
- [ ] `README.md` accurately describes the *current* tool set
- [ ] No half-merged branches, no commented-out scaffolding, no TODO
      comments pointing at the next version
- [ ] MCP-server Docusaurus page reflects the current tool set
- [ ] MCP registry listing submitted (or approved)
