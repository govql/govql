# MCP Curated Tools v0.3 (Per-entity detail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v0.3 "Per-entity detail" milestone: `get_legislator` (identity + full term history) and `get_vote_with_positions` (one vote + tallies/party-breakdown, positions optional), plus README/CHANGELOG updates and the version bump to `0.3.0`.

**Architecture:** Same pattern as v0.2 — thin async `@mcp.tool` modules using variable-based GraphQL and the existing `tools/_curated_shared.py` helpers, registered in `server.py`, tested with respx against the in-memory client. `get_vote_with_positions` issues **one multi-field query** combining `voteByVoteId` with the standalone aggregate connections `allVoteTotals` / `allVotePartyBreakdowns` (these aggregates are NOT relations on `Vote`; they are long-format tables `{voteId, position, positions}` where `positions` is the count).

**Tech Stack:** Python ≥3.10, FastMCP ≥3.3.0, httpx, pydantic; pytest + pytest-asyncio + respx. `uv`.

**Prerequisite:** v0.2 (PR #68) is merged; this branch is cut from fresh `main`, so `tools/_curated_shared.py` already exists.

## Global Constraints

- Component dir: `mcp-server/`. All commands run from there.
- Variable-based GraphQL filters; envelope + error handling identical to v0.2.
- Reuse `_curated_shared.py` (`clamp_limit`, `guard_items`, `normalize_party_code`, `normalize_state`, `normalize_chamber_code`, `network_error_response`, `today_iso`). Do not redefine helpers.
- `get_*` tools take an explicit id (`bioguide_id` / `vote_id`) — the discovery→detail split. A missing entity yields `{"data": {"legislator": null}}` / `{"data": {"vote": null}}`, not an error.
- Aggregate count field is `positions` (integer) on `VoteTotal` (`{position, positions}`) and `VotePartyBreakdown` (`{party, position, positions}`).
- Every mocked query verified live against `https://api.govql.us/graphql` first.
- Version target: `0.3.0`. Commits authored by Alex, no Claude co-author trailer.
- Full suite: `uv run pytest -q` (all prior tests stay green).

---

### Task 1: `get_legislator` tool

**Files:**
- Create: `src/govql_mcp_server/tools/get_legislator.py`
- Modify: `src/govql_mcp_server/server.py` (add `get_legislator` to the import)
- Test: `tests/test_get_legislator.py`

**Interfaces:**
- Consumes: `_curated_shared.today_iso`, `network_error_response`; `graphql_client`; `mcp`; `logger`.
- Produces: MCP tool `get_legislator(bioguide_id)` → `{"data": {"legislator": {...} | null}}`.

- [ ] **Step 1: Live-verify the query**

```bash
curl -s -X POST https://api.govql.us/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query($id:String!){legislatorByBioguideId(bioguideId:$id){bioguideId firstName middleName lastName nameSuffix nickname officialFull birthday gender legislatorTermsByBioguideIdList(orderBy:START_DATE_ASC){termType party state district startDate endDate how caucus}}}","variables":{"id":"P000145"}}'
```

Expected: Padilla with an ordered term list.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_get_legislator.py`:

```python
"""Tests for the get_legislator tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_PADILLA = {
    "legislatorByBioguideId": {
        "bioguideId": "P000145", "firstName": "Alejandro", "middleName": None,
        "lastName": "Padilla", "nameSuffix": None, "nickname": "Alex",
        "officialFull": "Alex Padilla", "birthday": "1973-03-22", "gender": "M",
        "legislatorTermsByBioguideIdList": [
            {"termType": "sen", "party": "Democrat", "state": "CA",
             "district": None, "startDate": "2021-01-20", "endDate": "2023-01-03",
             "how": "appointment", "caucus": None},
            {"termType": "sen", "party": "Democrat", "state": "CA",
             "district": None, "startDate": "2023-01-03", "endDate": "2029-01-03",
             "how": "election", "caucus": None},
        ],
    }
}


async def test_returns_identity_terms_and_current(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_PADILLA)
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "P000145"})

    assert _last_variables(route)["id"] == "P000145"
    leg = tool_payload(result)["data"]["legislator"]
    assert leg["bioguideId"] == "P000145"
    assert leg["nickname"] == "Alex"
    assert len(leg["terms"]) == 2
    assert leg["current"]["party"] == "Democrat"     # from the future-ending term
    assert leg["current"]["chamber"] == "Senate"
    assert result.is_error is False


async def test_missing_legislator_returns_null(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"legislatorByBioguideId": None})
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "X999999"})

    assert tool_payload(result)["data"]["legislator"] is None


async def test_blank_id_rejected_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"legislatorByBioguideId": None})
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "  "})

    assert "non-empty" in tool_payload(result)["errors"][0]["message"]
    assert route.called is False
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_get_legislator.py -q`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement `get_legislator.py`**

Create `src/govql_mcp_server/tools/get_legislator.py`:

```python
"""The get_legislator tool — identity + full term history for one member."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import network_error_response, today_iso

_QUERY = """
query GetLegislator($id: String!) {
  legislatorByBioguideId(bioguideId: $id) {
    bioguideId
    firstName
    middleName
    lastName
    nameSuffix
    nickname
    officialFull
    birthday
    gender
    legislatorTermsByBioguideIdList(orderBy: START_DATE_ASC) {
      termType
      party
      state
      district
      startDate
      endDate
      how
      caucus
    }
  }
}
"""

_CHAMBER_DISPLAY = {"sen": "Senate", "rep": "House"}


def _current(terms: list[dict[str, Any]]) -> dict[str, Any] | None:
    now = today_iso()
    for term in terms:
        end = term.get("endDate")
        if end and end > now:
            return {
                "party": term.get("party"),
                "state": term.get("state"),
                "chamber": _CHAMBER_DISPLAY.get(term.get("termType")),
                "district": term.get("district"),
            }
    return None


@mcp.tool
async def get_legislator(
    bioguide_id: Annotated[
        str, Field(description="The member's bioguide id (e.g. 'P000145'). Get one "
                             "from find_legislator."),
    ],
) -> dict[str, Any]:
    """Return one member's identity and full term history.

    Includes names, birthday, gender, every term (party/state/chamber/district/
    dates/how), and a `current` block derived from the term ending in the future
    (null if the member is not currently serving). `data.legislator` is null if
    the id doesn't exist.
    """
    if not bioguide_id or not bioguide_id.strip():
        return {"data": None, "errors": [{"message": "bioguide_id must be a non-empty string"}]}

    try:
        result = await graphql_client.execute_graphql(_QUERY, {"id": bioguide_id.strip()})
    except httpx.HTTPError as err:
        logger.warning("get_legislator transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    node = result["data"]["legislatorByBioguideId"]
    if node is None:
        return {"data": {"legislator": None}}

    terms = node.get("legislatorTermsByBioguideIdList") or []
    legislator = {
        "bioguideId": node["bioguideId"],
        "firstName": node.get("firstName"),
        "middleName": node.get("middleName"),
        "lastName": node.get("lastName"),
        "nameSuffix": node.get("nameSuffix"),
        "nickname": node.get("nickname"),
        "officialFull": node.get("officialFull"),
        "birthday": node.get("birthday"),
        "gender": node.get("gender"),
        "terms": terms,
        "current": _current(terms),
    }
    return {"data": {"legislator": legislator}}
```

- [ ] **Step 5: Register the tool** in `src/govql_mcp_server/server.py` — add `get_legislator` to the `from .tools import (...)` list (keep alphabetical).

- [ ] **Step 6: Run tests**

Run: `uv run pytest tests/test_get_legislator.py -q`
Expected: PASS (3).

- [ ] **Step 7: Commit**

```bash
git add src/govql_mcp_server/tools/get_legislator.py src/govql_mcp_server/server.py tests/test_get_legislator.py
git commit -m "feat(mcp): add get_legislator detail tool"
```

---

### Task 2: `get_vote_with_positions` tool

**Files:**
- Create: `src/govql_mcp_server/tools/get_vote_with_positions.py`
- Modify: `src/govql_mcp_server/server.py`
- Test: `tests/test_get_vote_with_positions.py`

**Interfaces:**
- Consumes: `_curated_shared` (`clamp_limit`, `guard_items`, `normalize_party_code`, `normalize_state`, `network_error_response`); `graphql_client`; `mcp`; `logger`.
- Produces: MCP tool `get_vote_with_positions(vote_id, include_positions, party, state, position, positions_limit)` → `{"data": {"vote": {...} | null, "totals": {...}, "party_breakdown": {...}, "positions": [...] | null, "truncated": bool}}`.

- [ ] **Step 1: Live-verify the combined query**

```bash
curl -s -X POST https://api.govql.us/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query($vid:String!){voteByVoteId(voteId:$vid){voteId chamber congress votedAt question category result resultText requires sourceUrl} t:allVoteTotals(filter:{voteId:{equalTo:$vid}}){nodes{position positions}} b:allVotePartyBreakdowns(filter:{voteId:{equalTo:$vid}}){nodes{party position positions}}}","variables":{"vid":"s192-119.2026"}}'
```

Expected: vote metadata + totals rows (`Yea`/`Nay`/…) + party-breakdown rows.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_get_vote_with_positions.py`:

```python
"""Tests for the get_vote_with_positions tool."""

from __future__ import annotations

import json

from tests.conftest import graphql_response, tool_payload


def _last_body(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())


_VOTE = {
    "voteByVoteId": {
        "voteId": "s192-119.2026", "chamber": "s", "congress": 119,
        "votedAt": "2026-03-01T00:00:00Z", "question": "On the Motion",
        "category": "cloture", "result": "Rejected",
        "resultText": "Motion Rejected", "requires": "1/2",
        "sourceUrl": "https://example.gov/s192",
    },
    "t": {"nodes": [
        {"position": "Yea", "positions": 47},
        {"position": "Nay", "positions": 50},
        {"position": "Present", "positions": 1},
        {"position": "Not Voting", "positions": 2},
    ]},
    "b": {"nodes": [
        {"party": "D", "position": "Yea", "positions": 43},
        {"party": "R", "position": "Nay", "positions": 49},
        {"party": "I", "position": "Yea", "positions": 2},
    ]},
}


async def test_default_returns_tallies_no_positions(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_VOTE)
    )

    result = await client.call_tool(
        "get_vote_with_positions", {"vote_id": "s192-119.2026"}
    )

    # positions relation must NOT be selected when include_positions is false
    assert "votePositionsByVoteIdList" not in _last_body(route)["query"]
    data = tool_payload(result)["data"]
    assert data["vote"]["voteId"] == "s192-119.2026"
    assert data["totals"] == {"Yea": 47, "Nay": 50, "Present": 1, "Not Voting": 2}
    assert data["party_breakdown"]["D"]["Yea"] == 43
    assert data["party_breakdown"]["R"]["Nay"] == 49
    assert data["positions"] is None


async def test_include_positions_selects_and_filters(client, mock_graphql, govql_endpoint):
    with_positions = dict(_VOTE)
    with_positions["voteByVoteId"] = dict(_VOTE["voteByVoteId"])
    with_positions["voteByVoteId"]["votePositionsByVoteIdList"] = [
        {"position": "Nay", "party": "R", "state": "VT",
         "legislatorByBioguideId": {"firstName": "A", "lastName": "B"}},
    ]
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=with_positions)
    )

    result = await client.call_tool(
        "get_vote_with_positions",
        {"vote_id": "s192-119.2026", "state": "vt", "position": "Nay"},
    )

    body = _last_body(route)
    assert "votePositionsByVoteIdList" in body["query"]        # positions selected
    pos_filter = body["variables"]["posFilter"]
    assert pos_filter["state"]["equalTo"] == "VT"              # normalized
    assert pos_filter["position"]["equalTo"] == "Nay"
    data = tool_payload(result)["data"]
    assert data["positions"][0]["lastName"] == "B"


async def test_missing_vote_returns_null(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"voteByVoteId": None, "t": {"nodes": []}, "b": {"nodes": []}}
        )
    )

    result = await client.call_tool("get_vote_with_positions", {"vote_id": "nope"})

    assert tool_payload(result)["data"]["vote"] is None
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_get_vote_with_positions.py -q`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement `get_vote_with_positions.py`**

Create `src/govql_mcp_server/tools/get_vote_with_positions.py`:

```python
"""The get_vote_with_positions tool — one vote plus tallies, party breakdown,
and (optionally) individual member positions."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import (
    clamp_limit,
    guard_items,
    network_error_response,
    normalize_party_code,
    normalize_state,
)

_META = """
    voteByVoteId(voteId: $vid) {
      voteId chamber congress votedAt question category result resultText
      requires sourceUrl%(positions)s
    }
"""

_POSITIONS = """
      votePositionsByVoteIdList(filter: $posFilter, first: $posFirst) {
        position party state
        legislatorByBioguideId { firstName lastName }
      }
"""

_AGGS = """
    t: allVoteTotals(filter: {voteId: {equalTo: $vid}}) { nodes { position positions } }
    b: allVotePartyBreakdowns(filter: {voteId: {equalTo: $vid}}) {
      nodes { party position positions }
    }
"""


def _build_query(include_positions: bool) -> str:
    meta = _META % {"positions": ("\n" + _POSITIONS) if include_positions else ""}
    header = (
        "query GetVote($vid: String!, $posFilter: VotePositionFilter, $posFirst: Int)"
        if include_positions
        else "query GetVote($vid: String!)"
    )
    return "%s {\n%s%s\n}" % (header, meta, _AGGS)


@mcp.tool
async def get_vote_with_positions(
    vote_id: Annotated[
        str, Field(description="The vote id (e.g. 's192-119.2026'). Get one from find_vote."),
    ],
    include_positions: Annotated[
        bool, Field(description="Include the per-member position list (up to ~500 "
                              "rows). Default false — tallies only."),
    ] = False,
    party: Annotated[
        str | None, Field(description="Only positions from this party ('D'/'R'/'I'). "
                                     "Implies include_positions."),
    ] = None,
    state: Annotated[
        str | None, Field(description="Only positions from this state (2-letter). "
                                     "Implies include_positions."),
    ] = None,
    position: Annotated[
        str | None, Field(description="Only this position: 'Yea','Nay','Present',"
                                     "'Not Voting'. Implies include_positions."),
    ] = None,
    positions_limit: Annotated[
        int | None, Field(description="Max positions returned (default 20, cap 500)."),
    ] = None,
) -> dict[str, Any]:
    """Return one roll-call vote with tallies, party breakdown, and optional
    member positions.

    By default returns vote metadata plus `totals` (Yea/Nay/Present/Not-Voting
    counts) and `party_breakdown` (counts per party × position) from the
    precomputed aggregates. Set `include_positions` (or pass any of
    `party`/`state`/`position`) to also get the individual member list.
    `data.vote` is null if the vote id doesn't exist.
    """
    want_positions = include_positions or any(v is not None for v in (party, state, position))

    try:
        pos_filter: dict[str, Any] = {}
        if party is not None:
            pos_filter["party"] = {"equalTo": normalize_party_code(party)}
        if state is not None:
            pos_filter["state"] = {"equalTo": normalize_state(state)}
        if position is not None:
            pos_filter["position"] = {"equalTo": position}
    except ValueError as err:
        return {"data": None, "errors": [{"message": str(err)}]}

    variables: dict[str, Any] = {"vid": vote_id}
    if want_positions:
        variables["posFilter"] = pos_filter or None
        variables["posFirst"] = clamp_limit(positions_limit)

    try:
        result = await graphql_client.execute_graphql(_build_query(want_positions), variables)
    except httpx.HTTPError as err:
        logger.warning("get_vote_with_positions transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    data = result["data"]
    vote = data.get("voteByVoteId")
    if vote is None:
        return {"data": {"vote": None, "totals": {}, "party_breakdown": {},
                         "positions": None, "truncated": False}}

    totals = {r["position"]: r["positions"] for r in data["t"]["nodes"]}
    breakdown: dict[str, dict[str, int]] = {}
    for r in data["b"]["nodes"]:
        breakdown.setdefault(r["party"], {})[r["position"]] = r["positions"]

    positions_out = None
    truncated = False
    if want_positions:
        raw = vote.pop("votePositionsByVoteIdList", []) or []
        shaped = [
            {
                "firstName": (p.get("legislatorByBioguideId") or {}).get("firstName"),
                "lastName": (p.get("legislatorByBioguideId") or {}).get("lastName"),
                "party": p.get("party"),
                "state": p.get("state"),
                "position": p.get("position"),
            }
            for p in raw
        ]
        positions_out, truncated = guard_items(shaped)
    else:
        vote.pop("votePositionsByVoteIdList", None)

    return {"data": {"vote": vote, "totals": totals, "party_breakdown": breakdown,
                     "positions": positions_out, "truncated": truncated}}
```

- [ ] **Step 5: Register the tool** in `server.py` (add `get_vote_with_positions`, keep alphabetical).

- [ ] **Step 6: Run the full suite**

Run: `uv run pytest -q`
Expected: PASS — prior tests + Task 1 (3) + Task 2 (3).

- [ ] **Step 7: Commit**

```bash
git add src/govql_mcp_server/tools/get_vote_with_positions.py src/govql_mcp_server/server.py tests/test_get_vote_with_positions.py
git commit -m "feat(mcp): add get_vote_with_positions detail tool"
```

---

### Task 3: Docs, CHANGELOG, and version bump

**Files:**
- Modify: `README.md` (Tools table, Status)
- Modify: `CHANGELOG.md` (`## [0.3.0]`)
- Modify: `pyproject.toml` (version `0.2.0` → `0.3.0`)

- [ ] **Step 1: README Tools-table rows** (after `find_vote`):

```markdown
| `get_legislator` | Full detail for one member by bioguide id: names, bio, and complete term history (party/state/chamber/district over time) with a `current` block. |
| `get_vote_with_positions` | One vote by id with tallies and per-party breakdown; optionally the individual member positions (filter by party/state/position). |
```

Update **Status** to say `0.3.0` and that per-entity detail tools (`get_legislator`, `get_vote_with_positions`) have joined the discovery tools; analysis tools remain planned.

- [ ] **Step 2: CHANGELOG** — insert above `## [0.2.0]`:

```markdown
## [0.3.0] — 2026-07-09

### Added

- `get_legislator` tool — one member's identity plus full term history and a
  derived `current` term block, by bioguide id.
- `get_vote_with_positions` tool — one vote by id with precomputed tallies and
  per-party breakdown; individual member positions are optional and filterable
  by party/state/position, capped and byte-guarded.
```

- [ ] **Step 3: Version bump** — `pyproject.toml` `0.2.0` → `0.3.0`.

- [ ] **Step 4: Verify + commit**

```bash
uv run pytest -q
git add README.md CHANGELOG.md pyproject.toml
git commit -m "docs(mcp): v0.3 tool docs and bump to 0.3.0"
```

---

## Self-Review

**1. Spec coverage:**
- `get_legislator` identity + all terms + current block → Task 1 ✓
- `get_vote_with_positions` metadata + tallies + party breakdown + optional/filtered positions + byte guard → Task 2 ✓
- Aggregates queried as top-level `allVoteTotals`/`allVotePartyBreakdowns` (not Vote relations — corrected from spec after live probe) → Task 2 ✓
- Missing-entity → null (not error) → both tasks + tests ✓
- README/CHANGELOG/version 0.3.0 → Task 3 ✓

**2. Placeholder scan:** No TBD/TODO; complete code and concrete doc text throughout. ✓

**3. Type consistency:** `_curated_shared` helper names match v0.2 definitions. Return keys (`legislator`, `terms`, `current`; `vote`, `totals`, `party_breakdown`, `positions`, `truncated`) match between impl and tests. The positions relation is conditionally selected and the variable is named `posFilter`/`posFirst` consistently in query, impl, and tests. ✓

> **Note vs spec:** the spec described the tallies as "the `vote_totals`/`vote_party_breakdown` aggregate relations"; a live probe showed these are **not** relations on `Vote` but standalone connections (`allVoteTotals`, `allVotePartyBreakdowns`) filtered by `voteId`. This plan implements the verified shape.
