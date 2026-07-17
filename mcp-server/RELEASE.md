# Releasing govql-mcp-server

Releases are automated: push a `govql-mcp-server-vX.Y.Z` tag, and the
[`mcp-server-release` workflow](../.github/workflows/mcp-server-release.yml)
builds the package, verifies the tag/version/CHANGELOG agree, pauses for a
one-click approval, then publishes to PyPI via Trusted Publishing and creates
the matching GitHub Release. What's left for a human: prepare the release
commit, push the tag, approve at the gate, and submit the mcp.so listing.

All commands assume you're in `mcp-server/` unless noted otherwise.

---

## 0. One-time setup (recorded for disaster recovery)

The workflow depends on configuration that lives outside the repo. It's
already in place; if any of it is ever lost, re-create it as follows.

### PyPI Trusted Publisher

On [pypi.org](https://pypi.org) → `govql-mcp-server` → Manage → Publishing,
register a **Trusted Publisher** (requires being a project owner):

- **Owner:** `govql` / **Repository:** `govql`
- **Workflow name:** `mcp-server-release.yml` (the bare filename, not a path)
- **Environment name:** `pypi`

This is why CI needs no stored API token: the workflow presents a
short-lived OIDC identity token, PyPI checks it against this registration
(repo, workflow, and environment all have to match), and exchanges it for a
scoped upload token.

### TestPyPI pending publisher

TestPyPI is a separate instance of PyPI with its own accounts and its own
namespace. If `govql-mcp-server` doesn't exist there (rehearsal uploads are
what create it), a publisher can't attach to the project's settings, so
registration happens at the account level instead. On
[test.pypi.org/manage/account/publishing](https://test.pypi.org/manage/account/publishing/),
add a **pending publisher**:

- **PyPI Project Name:** `govql-mcp-server`
- **Owner:** `govql` / **Repository:** `govql`
- **Workflow name:** `mcp-server-release.yml`
- **Environment name:** `testpypi` (rehearsals run under their own
  environment, distinct from the real release's `pypi`; see below)

The first successful publish creates the project and promotes the pending
publisher to a normal one, so a rehearsal never needs an API token either. A
pending publisher doesn't reserve the name; the project exists only once a
rehearsal actually uploads (§6).

### GitHub Environments: `pypi` and `testpypi`

In the repo settings (requires admin): Settings → Environments → New
environment, once as `pypi` (real releases) and once as `testpypi`
(rehearsals), each with a **required reviewer** added. The reviewer
requirement is the approval gate; remove it to graduate to fully unattended
releases. The workflow picks the environment from the tag: an `rc` version
runs under `testpypi`, a final version under `pypi`. Each environment name
is bound into the matching index's publisher registration above, so the two
identities can't cross even if a run were somehow mis-routed.

### MCP registry (mcp.so) account

A free account at [mcp.so](https://mcp.so) for the listing update in §5.

---

## 1. Prepare the release (on the release PR)

The version bump ships as a normal PR through the lint + test gate:

- Bump `version` in `pyproject.toml`.
- Move/write the `CHANGELOG.md` entry for that exact version (the workflow
  greps for `## [X.Y.Z]` and refuses to publish without it).
- `README.md` describes the *current* tool set (no "coming soon" wording).

Then the usual local pre-flight from `mcp-server/`:

```bash
uv run ruff check . && uv run ruff format --check . && uv run pytest

# Build artifacts clean and well-formed (CI rebuilds these; local is a preview)
rm -rf dist/ && uv build
unzip -l dist/govql_mcp_server-*.whl   # only govql_mcp_server/ + dist-info
tar tzf dist/govql_mcp_server-*.tar.gz # full source tree incl. tests/, docs/
```

---

## 2. Real MCP client test (gate before tagging)

This is the only test that proves "an actual agent can use this." Don't tag
a release without it.

Point a client at the local build. In Claude Desktop's
`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "govql-local": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/govql/mcp-server",
        "run",
        "govql-mcp-server"
      ]
    }
  }
}
```

Restart the client, confirm the tools appear, and ask something that
exercises the new surface. The standing smoke prompt:

> *How did Vermont's two senators vote on the most recent nomination?*

If the agent gets confused, the fix is almost always in the relevant tool's
docstring, the agent's primary guide. Fix it on the release PR, not after
publishing. Remove the `govql-local` config entry when done.

---

## 3. Tag and push (this is the release trigger)

After the release PR merges, from the **repo root**, on the merge commit:

```bash
git checkout main && git pull
git status && git log -1 --oneline   # clean tree, on the release merge commit

git tag -a govql-mcp-server-vX.Y.Z -m "govql-mcp-server vX.Y.Z"
git push origin govql-mcp-server-vX.Y.Z
```

The tag namespace (`govql-mcp-server-`) keeps it clear of other sub-projects'
future tags. The push starts the workflow; watch it in the repo's Actions
tab, where a tag-triggered run files under the tag's name, not on any branch
or PR (`git push` only confirms the push reached GitHub, not that the run
passed):

1. **build**: `uv build`, plus the guardrail: the run fails immediately if
   the tag version ≠ `pyproject.toml` version, or `CHANGELOG.md` has no entry
   for it. (If it fails, fix on a PR, merge, then delete and re-push the tag
   on the new commit: `git tag -d ... && git push origin :refs/tags/...`.)
2. **publish**: pauses at the `pypi` environment gate. GitHub emails the
   required reviewer; approve from the run page (Actions →
   mcp-server-release).

The version's shape routes the run: a final `X.Y.Z` tag publishes to PyPI
and creates the GitHub Release; an `X.Y.ZrcN` tag is a TestPyPI rehearsal
(§6), pauses at the `testpypi` gate instead, and creates no Release.

---

## 4. Approve, then verify

One click at the gate and the rest is automatic: OIDC publish to PyPI (with
PEP 740 attestations) and a GitHub Release named after the tag, carrying the
version's CHANGELOG section as notes and the built files as assets.

About 5 minutes after the run goes green:

```bash
# Package visible on PyPI at the right version
curl -sS https://pypi.org/pypi/govql-mcp-server/json | jq .info.version

# Fresh install from PyPI works (--refresh bypasses uv's cache). No prompt
# means it's waiting on stdin for MCP messages, which is correct.
uvx --refresh --from govql-mcp-server==X.Y.Z govql-mcp-server 2>&1 | head -5
```

Then point a real client at the PyPI version (the `uvx` snippet in
`README.md`) and re-run the §2 smoke prompt to confirm the published
artifact behaves like the local build did.

---

## 5. Submit / update the MCP registry listing (mcp.so)

1. Log into [mcp.so](https://mcp.so) and submit or update the listing:
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
2. Moderation typically takes a few hours to a few days. Once approved, note
   the registry URL in the next CHANGELOG entry.

---

## 6. TestPyPI rehearsal (`rc` tags)

The publish step can't be exercised by a PR; only a tag push runs it. The
workflow routes on the tag itself: a version with an `rc` segment publishes
to TestPyPI under the `testpypi` environment and creates no GitHub Release.
A rehearsal is therefore just a throwaway `rc` tag; there are no workflow
edits to make or revert.

1. On a throwaway branch, bump `pyproject.toml` to `X.Y.ZrcN` and add a
   matching `## [X.Y.ZrcN]` CHANGELOG heading. This is not optional: the
   guardrail applies to rehearsals too, so tagging without the bump fails
   the run at its first step. The `rc` segment is what routes the run to
   TestPyPI, and incrementing N gives retry room: uploads are immutable on
   TestPyPI too, so a failed run needs a fresh number (`rc2`, `rc3`).
2. Tag that commit and push only the tag, so the rehearsal branch never
   appears in a PR:
   ```bash
   git tag -a govql-mcp-server-vX.Y.ZrcN -m "TestPyPI rehearsal"
   git push origin govql-mcp-server-vX.Y.ZrcN
   ```
3. Watch the run from the repo's Actions tab; like any tag-triggered run it
   files under the tag's name (§3), so a guardrail failure is visible only
   there. Expect: the guardrail, the pause at the `testpypi` gate, your
   approval, the TestPyPI upload, and no GitHub Release afterwards. To
   install what was published, add TestPyPI as an extra index instead of
   replacing PyPI, since the runtime dependencies exist only on the real
   index:
   ```bash
   uvx --index https://test.pypi.org/simple/ \
     --from govql-mcp-server==X.Y.ZrcN govql-mcp-server
   ```
4. Clean up: delete the throwaway tag (`git push origin
   :refs/tags/govql-mcp-server-vX.Y.ZrcN`, then `git tag -d` locally) and
   drop the branch. TestPyPI itself needs no cleanup; it's a sandbox.

A tag-push workflow runs the workflow file **as of the tagged commit**, so a
rehearsal also exercises workflow changes from a branch before they merge.

---

## 7. Post-release consistency check

After the release settles, confirm the repo agrees with it:

- [ ] Latest version is on PyPI
- [ ] Matching git tag is pushed and its GitHub Release exists
- [ ] `CHANGELOG.md` has the entry
- [ ] `README.md` accurately describes the *current* tool set
- [ ] No half-merged branches, no commented-out scaffolding, no TODO
      comments pointing at the next version
- [ ] MCP-server Docusaurus page reflects the current tool set
- [ ] MCP registry listing submitted (or approved)
