# MCP Curated Tools v0.2 (Discovery/lookup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v0.2 "Discovery/lookup" milestone of `govql-mcp-server`: the shared curated-tool helper module plus `find_legislator` and `find_vote`, with the roadmap/README/CHANGELOG updates and the version bump to `0.2.0`.

**Architecture:** Each tool is a thin async `@mcp.tool` function in its own module under `src/govql_mcp_server/tools/`, registered by importing it in `server.py`. Tools normalize friendly params, build a **variable-based** GraphQL document (filters passed as GraphQL variables — never string-interpolated), call `graphql_client.execute_graphql`, and shape a compact result via helpers in a new `tools/_curated_shared.py`. Tests are `respx`-mocked against the in-memory FastMCP client, asserting both the outgoing query/variables and the shaped response.

**Tech Stack:** Python ≥3.10, FastMCP ≥3.3.0, httpx, pydantic; pytest + pytest-asyncio + respx for tests. Package manager: `uv`.

## Global Constraints

- Component dir: `mcp-server/`. All commands below run from `mcp-server/`.
- Filters are passed as GraphQL **variables** (typed `LegislatorFilter` / `VoteFilter`), never interpolated into the query string.
- Envelope matches existing tools: success → `{"data": {...}}`; GraphQL errors → `{"data": None, "errors": [...]}` (tool result NOT an MCP error); transport failure → `network_error_response(err)`.
- Row limit: default `20`, hard cap `500` (`LIMIT_DEFAULT` / `LIMIT_MAX`). Real safeguard is the byte budget `RESPONSE_BYTE_BUDGET = 100_000`, applied to the shaped list.
- Param normalization: `legislator_terms.party` is a full string (`"Democrat"`); `votes.chamber` is `"h"`/`"s"`; `legislator_terms.term_type` is `"rep"`/`"sen"`. An **unrecognized** provided value raises `ValueError`, which the tool returns as `{"data": None, "errors": [{"message": ...}]}`.
- Reuse `network_error_response` from `_discovery_shared.py` — do not duplicate it.
- Every mocked query must first be run **live** against `https://api.govql.us/graphql` to confirm shape.
- Version target: `0.2.0`. Commits authored by Alex, no Claude co-author trailer.
- Run the full suite with `uv run pytest -q` (existing ~23 tests must stay green).

---

### Task 1: `_curated_shared.py` helper module

**Files:**
- Create: `src/govql_mcp_server/tools/_curated_shared.py`
- Test: `tests/test_curated_shared.py`

**Interfaces:**
- Consumes: `network_error_response` from `._discovery_shared`.
- Produces (used by every later task and both other plans):
  - `normalize_party(value: str | None) -> str | None` — full string (`"Democrat"`/`"Republican"`/`"Independent"`); raises `ValueError` on an unrecognized non-null value.
  - `normalize_party_code(value: str | None) -> str | None` — short code (`"D"`/`"R"`/`"I"`); raises `ValueError` on unrecognized.
  - `normalize_chamber_termtype(value: str | None) -> str | None` — `"sen"`/`"rep"`; raises on unrecognized.
  - `normalize_chamber_code(value: str | None) -> str | None` — `"s"`/`"h"`; raises on unrecognized.
  - `normalize_state(value: str | None) -> str | None` — upper-cased 2-letter; raises on non-2-letter.
  - `clamp_limit(value: int | None) -> int` — `None` → `20`; clamps to `1..500`.
  - `today_iso() -> str` — `date.today().isoformat()`.
  - `guard_items(items: list) -> tuple[list, bool]` — returns the largest prefix whose JSON stays under `RESPONSE_BYTE_BUDGET` minus overhead, plus a `truncated` flag.
  - Re-exports `network_error_response`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_curated_shared.py`:

```python
"""Unit tests for the shared curated-tool helpers."""

from __future__ import annotations

import json

import pytest

from govql_mcp_server.tools import _curated_shared as cs


def test_normalize_party_full_variants():
    assert cs.normalize_party("dem") == "Democrat"
    assert cs.normalize_party("D") == "Democrat"
    assert cs.normalize_party("republican") == "Republican"
    assert cs.normalize_party("I") == "Independent"
    assert cs.normalize_party(None) is None


def test_normalize_party_code_variants():
    assert cs.normalize_party_code("democrat") == "D"
    assert cs.normalize_party_code("R") == "R"
    assert cs.normalize_party_code(None) is None


def test_normalize_party_rejects_unknown():
    with pytest.raises(ValueError):
        cs.normalize_party("whigs")


def test_normalize_chamber():
    assert cs.normalize_chamber_termtype("senate") == "sen"
    assert cs.normalize_chamber_termtype("h") == "rep"
    assert cs.normalize_chamber_code("senate") == "s"
    assert cs.normalize_chamber_code("house") == "h"
    with pytest.raises(ValueError):
        cs.normalize_chamber_code("both")


def test_normalize_state():
    assert cs.normalize_state("ca") == "CA"
    assert cs.normalize_state(None) is None
    with pytest.raises(ValueError):
        cs.normalize_state("California")


def test_clamp_limit():
    assert cs.clamp_limit(None) == cs.LIMIT_DEFAULT
    assert cs.clamp_limit(0) == 1
    assert cs.clamp_limit(999) == cs.LIMIT_MAX
    assert cs.clamp_limit(50) == 50


def test_guard_items_under_budget_passes_through():
    items = [{"i": i} for i in range(10)]
    guarded, truncated = cs.guard_items(items)
    assert guarded == items
    assert truncated is False


def test_guard_items_truncates_oversized():
    items = [{"blob": "x" * 1000} for _ in range(500)]  # ~500 KB
    guarded, truncated = cs.guard_items(items)
    assert truncated is True
    assert 0 < len(guarded) < len(items)
    assert len(json.dumps(guarded)) <= cs.RESPONSE_BYTE_BUDGET
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_curated_shared.py -q`
Expected: FAIL — `ModuleNotFoundError: govql_mcp_server.tools._curated_shared`.

- [ ] **Step 3: Implement `_curated_shared.py`**

Create `src/govql_mcp_server/tools/_curated_shared.py`:

```python
"""Private helpers shared by the curated tools (find_/get_/compare_ ...).

Underscore prefix marks this as not-a-tool — server.py does not import it and
it registers no MCP handlers.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from ._discovery_shared import network_error_response  # re-exported

__all__ = [
    "normalize_party",
    "normalize_party_code",
    "normalize_chamber_termtype",
    "normalize_chamber_code",
    "normalize_state",
    "clamp_limit",
    "today_iso",
    "guard_items",
    "network_error_response",
    "LIMIT_DEFAULT",
    "LIMIT_MAX",
    "RESPONSE_BYTE_BUDGET",
]

LIMIT_DEFAULT = 20
LIMIT_MAX = 500
RESPONSE_BYTE_BUDGET = 100_000
_ENVELOPE_OVERHEAD = 2_000  # room for result_count/truncated/keys around the list

_PARTY_FULL = {
    "d": "Democrat", "dem": "Democrat", "democrat": "Democrat", "democratic": "Democrat",
    "r": "Republican", "rep": "Republican", "republican": "Republican",
    "i": "Independent", "ind": "Independent", "independent": "Independent",
}
_PARTY_CODE = {
    "d": "D", "dem": "D", "democrat": "D", "democratic": "D",
    "r": "R", "rep": "R", "republican": "R",
    "i": "I", "ind": "I", "independent": "I",
}
_CHAMBER_TERMTYPE = {
    "s": "sen", "sen": "sen", "senate": "sen", "senator": "sen",
    "h": "rep", "house": "rep", "rep": "rep", "representative": "rep",
}
_CHAMBER_CODE = {
    "s": "s", "sen": "s", "senate": "s",
    "h": "h", "house": "h", "rep": "h",
}


def _lookup(value: str | None, table: dict[str, str], label: str) -> str | None:
    if value is None:
        return None
    key = value.strip().lower()
    if key not in table:
        raise ValueError(
            f"Unrecognized {label}: {value!r}. Expected one of "
            f"{sorted(set(table.values()))}."
        )
    return table[key]


def normalize_party(value: str | None) -> str | None:
    """Friendly party input -> full string ('Democrat'/'Republican'/'Independent')."""
    return _lookup(value, _PARTY_FULL, "party")


def normalize_party_code(value: str | None) -> str | None:
    """Friendly party input -> short code ('D'/'R'/'I')."""
    return _lookup(value, _PARTY_CODE, "party")


def normalize_chamber_termtype(value: str | None) -> str | None:
    """Friendly chamber input -> legislator_terms.term_type ('sen'/'rep')."""
    return _lookup(value, _CHAMBER_TERMTYPE, "chamber")


def normalize_chamber_code(value: str | None) -> str | None:
    """Friendly chamber input -> votes.chamber ('s'/'h')."""
    return _lookup(value, _CHAMBER_CODE, "chamber")


def normalize_state(value: str | None) -> str | None:
    """Two-letter USPS state code, upper-cased."""
    if value is None:
        return None
    v = value.strip().upper()
    if len(v) != 2 or not v.isalpha():
        raise ValueError(f"Unrecognized state: {value!r}. Expected a 2-letter code (e.g. 'CA').")
    return v


def clamp_limit(value: int | None) -> int:
    if value is None:
        return LIMIT_DEFAULT
    return max(1, min(LIMIT_MAX, int(value)))


def today_iso() -> str:
    return date.today().isoformat()


def guard_items(items: list[Any]) -> tuple[list[Any], bool]:
    """Return the largest prefix of `items` whose JSON stays within the byte
    budget, plus a truncated flag. Binary-searches the prefix length."""
    budget = RESPONSE_BYTE_BUDGET - _ENVELOPE_OVERHEAD
    if len(json.dumps(items)) <= budget:
        return items, False
    lo, hi = 0, len(items)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(json.dumps(items[:mid])) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return items[:lo], True
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_curated_shared.py -q`
Expected: PASS (all 9).

- [ ] **Step 5: Commit**

```bash
git add src/govql_mcp_server/tools/_curated_shared.py tests/test_curated_shared.py
git commit -m "feat(mcp): add shared helpers for curated tools (#68)"
```

---

### Task 2: `find_legislator` tool

**Files:**
- Create: `src/govql_mcp_server/tools/find_legislator.py`
- Modify: `src/govql_mcp_server/server.py` (add `find_legislator` to the tool import)
- Test: `tests/test_find_legislator.py`

**Interfaces:**
- Consumes: everything from Task 1; `graphql_client.execute_graphql`; `mcp` from `..server`; `logger`.
- Produces: MCP tool `find_legislator(name, state, party, chamber, current_only, limit)` returning `{"data": {"legislators": [...], "result_count": int, "truncated": bool}}`.

- [ ] **Step 1: Live-verify the query** (no code)

Run this against `https://api.govql.us/graphql` and confirm it returns current CA senators (e.g. Padilla, Schiff):

```bash
curl -s -X POST https://api.govql.us/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query($f:LegislatorFilter,$n:Int){allLegislators(filter:$f,first:$n){nodes{bioguideId firstName lastName officialFull legislatorTermsByBioguideIdList(orderBy:END_DATE_DESC,first:1){party state termType endDate}}}}","variables":{"f":{"legislatorTermsByBioguideId":{"some":{"termType":{"equalTo":"sen"},"state":{"equalTo":"CA"},"party":{"equalTo":"Democrat"},"endDate":{"greaterThan":"2026-07-09"}}}},"n":5}}'
```

Expected: 2 nodes, each with a `sen`/`CA`/`Democrat` latest term.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_find_legislator.py`:

```python
"""End-to-end tests for the find_legislator tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    body = json.loads(route.calls.last.request.read().decode())
    return body["variables"]


_TWO_SENATORS = {
    "allLegislators": {
        "nodes": [
            {
                "bioguideId": "P000145", "firstName": "Alejandro",
                "lastName": "Padilla", "officialFull": "Alex Padilla",
                "legislatorTermsByBioguideIdList": [
                    {"party": "Democrat", "state": "CA", "termType": "sen",
                     "endDate": "2029-01-03"}
                ],
            },
            {
                "bioguideId": "S001150", "firstName": "Adam",
                "lastName": "Schiff", "officialFull": "Adam B. Schiff",
                "legislatorTermsByBioguideIdList": [
                    {"party": "Democrat", "state": "CA", "termType": "sen",
                     "endDate": "2031-01-03"}
                ],
            },
        ]
    }
}


async def test_builds_normalized_nested_term_filter(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_TWO_SENATORS)
    )

    result = await client.call_tool(
        "find_legislator",
        {"state": "ca", "party": "dem", "chamber": "senate"},
    )

    some = _last_variables(route)["filter"]["legislatorTermsByBioguideId"]["some"]
    assert some["state"]["equalTo"] == "CA"
    assert some["party"]["equalTo"] == "Democrat"   # full string, not "D"
    assert some["termType"]["equalTo"] == "sen"
    assert "greaterThan" in some["endDate"]          # current_only default
    payload = tool_payload(result)
    assert payload["data"]["result_count"] == 2
    first = payload["data"]["legislators"][0]
    assert first["bioguideId"] == "P000145"
    assert first["chamber"] == "Senate"
    assert first["party"] == "Democrat"
    assert first["current"] is True
    assert result.is_error is False


async def test_name_search_uses_or_clause(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allLegislators": {"nodes": []}})
    )

    await client.call_tool("find_legislator", {"name": "schiff", "current_only": False})

    filt = _last_variables(route)["filter"]
    or_fields = {list(c.keys())[0] for c in filt["or"]}
    assert or_fields == {"lastName", "firstName", "officialFull", "nickname"}
    assert "legislatorTermsByBioguideId" not in filt  # current_only False, no term facets


async def test_unknown_party_returns_error_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allLegislators": {"nodes": []}})
    )

    result = await client.call_tool("find_legislator", {"party": "whigs"})

    payload = tool_payload(result)
    assert "Unrecognized party" in payload["errors"][0]["message"]
    assert route.called is False


async def test_network_failure_returns_errors_payload(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("down"))

    result = await client.call_tool("find_legislator", {"state": "VT"})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_find_legislator.py -q`
Expected: FAIL — tool `find_legislator` not registered / not found.

- [ ] **Step 4: Implement `find_legislator.py`**

Create `src/govql_mcp_server/tools/find_legislator.py`:

```python
"""The find_legislator tool — discover members by name/party/state/chamber."""

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
    normalize_chamber_termtype,
    normalize_party,
    normalize_state,
    today_iso,
)

_QUERY = """
query FindLegislator($filter: LegislatorFilter, $first: Int) {
  allLegislators(filter: $filter, first: $first) {
    nodes {
      bioguideId
      firstName
      lastName
      officialFull
      legislatorTermsByBioguideIdList(orderBy: END_DATE_DESC, first: 1) {
        party
        state
        termType
        endDate
      }
    }
  }
}
"""

_CHAMBER_DISPLAY = {"sen": "Senate", "rep": "House"}


def _shape(node: dict[str, Any]) -> dict[str, Any]:
    terms = node.get("legislatorTermsByBioguideIdList") or []
    latest = terms[0] if terms else {}
    end = latest.get("endDate")
    return {
        "bioguideId": node["bioguideId"],
        "firstName": node.get("firstName"),
        "lastName": node.get("lastName"),
        "officialFull": node.get("officialFull"),
        "party": latest.get("party"),
        "state": latest.get("state"),
        "chamber": _CHAMBER_DISPLAY.get(latest.get("termType")),
        "current": bool(end and end > today_iso()),
    }


@mcp.tool
async def find_legislator(
    name: Annotated[
        str | None,
        Field(description="Case-insensitive substring matched across first name, "
                          "last name, official full name, and nickname."),
    ] = None,
    state: Annotated[
        str | None, Field(description="Two-letter USPS state code, e.g. 'CA'."),
    ] = None,
    party: Annotated[
        str | None, Field(description="Party: 'D'/'R'/'I' or a full name like "
                                     "'Democrat'. Matches the member's term party."),
    ] = None,
    chamber: Annotated[
        str | None, Field(description="'house'/'h' or 'senate'/'s'."),
    ] = None,
    current_only: Annotated[
        bool, Field(description="Only members currently serving (a term ending in "
                              "the future). Default true."),
    ] = True,
    limit: Annotated[
        int | None, Field(description="Max results (default 20, capped at 500)."),
    ] = None,
) -> dict[str, Any]:
    """Find legislators by attributes when you don't know a bioguide id.

    Party/state/chamber are matched against the member's *terms* (party is
    per-term, not on the legislator). `current_only` (default) restricts to
    members whose latest term ends in the future. Returns a compact ranked
    list — pass a returned `bioguideId` to `get_legislator` for full detail.
    """
    try:
        term_facets: dict[str, Any] = {}
        if state is not None:
            term_facets["state"] = {"equalTo": normalize_state(state)}
        if party is not None:
            term_facets["party"] = {"equalTo": normalize_party(party)}
        if chamber is not None:
            term_facets["termType"] = {"equalTo": normalize_chamber_termtype(chamber)}
        if current_only:
            term_facets["endDate"] = {"greaterThan": today_iso()}
    except ValueError as err:
        return {"data": None, "errors": [{"message": str(err)}]}

    filt: dict[str, Any] = {}
    if name is not None:
        filt["or"] = [
            {"lastName": {"includesInsensitive": name}},
            {"firstName": {"includesInsensitive": name}},
            {"officialFull": {"includesInsensitive": name}},
            {"nickname": {"includesInsensitive": name}},
        ]
    if term_facets:
        filt["legislatorTermsByBioguideId"] = {"some": term_facets}

    variables = {"filter": filt or None, "first": clamp_limit(limit)}
    try:
        result = await graphql_client.execute_graphql(_QUERY, variables)
    except httpx.HTTPError as err:
        logger.warning("find_legislator transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    nodes = result["data"]["allLegislators"]["nodes"]
    shaped = [_shape(n) for n in nodes]
    items, truncated = guard_items(shaped)
    return {"data": {"legislators": items, "result_count": len(shaped),
                     "truncated": truncated}}
```

- [ ] **Step 5: Register the tool** in `src/govql_mcp_server/server.py`

Change the tool import line to include `find_legislator`:

```python
from .tools import describe_type, find_legislator, list_types, passthrough  # noqa: E402, F401
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_find_legislator.py -q`
Expected: PASS (4).

- [ ] **Step 7: Commit**

```bash
git add src/govql_mcp_server/tools/find_legislator.py src/govql_mcp_server/server.py tests/test_find_legislator.py
git commit -m "feat(mcp): add find_legislator discovery tool (#68)"
```

---

### Task 3: `find_vote` tool

**Files:**
- Create: `src/govql_mcp_server/tools/find_vote.py`
- Modify: `src/govql_mcp_server/server.py` (add `find_vote` to the tool import)
- Test: `tests/test_find_vote.py`

**Interfaces:**
- Consumes: Task 1 helpers; `graphql_client`; `mcp`; `logger`.
- Produces: MCP tool `find_vote(topic, chamber, congress, category, limit)` returning `{"data": {"votes": [...], "result_count": int, "truncated": bool}}`.

- [ ] **Step 1: Live-verify the query** (no code)

```bash
curl -s -X POST https://api.govql.us/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query($f:VoteFilter,$n:Int){allVotes(filter:$f,orderBy:VOTED_AT_DESC,first:$n){nodes{voteId chamber congress votedAt category question result resultText sourceUrl}}}","variables":{"f":{"question":{"includesInsensitive":"immigration"},"chamber":{"equalTo":"s"}},"n":3}}'
```

Expected: up to 3 Senate votes whose `question` mentions immigration, newest first.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_find_vote.py`:

```python
"""End-to-end tests for the find_vote tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_ONE_VOTE = {
    "allVotes": {
        "nodes": [
            {"voteId": "s100-118.2023", "chamber": "s", "congress": 118,
             "votedAt": "2023-05-10T00:00:00Z", "category": "cloture",
             "question": "On Cloture on the Motion re immigration",
             "result": "Rejected", "resultText": "Cloture Motion Rejected",
             "sourceUrl": "https://example.gov/s100"}
        ]
    }
}


async def test_builds_normalized_filter_and_shapes(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_ONE_VOTE)
    )

    result = await client.call_tool(
        "find_vote",
        {"topic": "immigration", "chamber": "senate", "congress": 118,
         "category": "cloture"},
    )

    filt = _last_variables(route)["filter"]
    assert filt["question"]["includesInsensitive"] == "immigration"
    assert filt["chamber"]["equalTo"] == "s"        # normalized
    assert filt["congress"]["equalTo"] == 118
    assert filt["category"]["equalTo"] == "cloture"
    payload = tool_payload(result)
    assert payload["data"]["result_count"] == 1
    assert payload["data"]["votes"][0]["voteId"] == "s100-118.2023"
    assert result.is_error is False


async def test_no_filters_sends_null_filter(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allVotes": {"nodes": []}})
    )

    await client.call_tool("find_vote", {})

    assert _last_variables(route)["filter"] is None


async def test_unknown_chamber_returns_error_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allVotes": {"nodes": []}})
    )

    result = await client.call_tool("find_vote", {"chamber": "both"})

    payload = tool_payload(result)
    assert "Unrecognized chamber" in payload["errors"][0]["message"]
    assert route.called is False


async def test_network_failure_returns_errors_payload(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("down"))

    result = await client.call_tool("find_vote", {"topic": "budget"})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_find_vote.py -q`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement `find_vote.py`**

Create `src/govql_mcp_server/tools/find_vote.py`:

```python
"""The find_vote tool — topic/keyword search over roll-call votes."""

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
    normalize_chamber_code,
)

_QUERY = """
query FindVote($filter: VoteFilter, $first: Int) {
  allVotes(filter: $filter, orderBy: VOTED_AT_DESC, first: $first) {
    nodes {
      voteId
      chamber
      congress
      votedAt
      category
      question
      result
      resultText
      sourceUrl
    }
  }
}
"""


@mcp.tool
async def find_vote(
    topic: Annotated[
        str | None,
        Field(description="Free-text searched (case-insensitive) within the vote "
                          "'question' text, e.g. 'immigration'."),
    ] = None,
    chamber: Annotated[
        str | None, Field(description="'house'/'h' or 'senate'/'s'."),
    ] = None,
    congress: Annotated[
        int | None, Field(description="Congress number, e.g. 118."),
    ] = None,
    category: Annotated[
        str | None, Field(description="Vote category, e.g. 'nomination', 'passage', "
                                     "'cloture', 'amendment'. Exact match."),
    ] = None,
    limit: Annotated[
        int | None, Field(description="Max results (default 20, capped at 500). "
                                     "Newest first."),
    ] = None,
) -> dict[str, Any]:
    """Find roll-call votes by topic/chamber/congress/category.

    Searches the vote `question` text for `topic`; results are newest-first.
    Returns a compact list — pass a returned `voteId` to
    `get_vote_with_positions` for tallies and member positions.
    """
    try:
        chamber_code = normalize_chamber_code(chamber)
    except ValueError as err:
        return {"data": None, "errors": [{"message": str(err)}]}

    filt: dict[str, Any] = {}
    if topic is not None:
        filt["question"] = {"includesInsensitive": topic}
    if chamber_code is not None:
        filt["chamber"] = {"equalTo": chamber_code}
    if congress is not None:
        filt["congress"] = {"equalTo": congress}
    if category is not None:
        filt["category"] = {"equalTo": category}

    variables = {"filter": filt or None, "first": clamp_limit(limit)}
    try:
        result = await graphql_client.execute_graphql(_QUERY, variables)
    except httpx.HTTPError as err:
        logger.warning("find_vote transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    nodes = result["data"]["allVotes"]["nodes"]
    items, truncated = guard_items(nodes)
    return {"data": {"votes": items, "result_count": len(nodes),
                     "truncated": truncated}}
```

- [ ] **Step 5: Register the tool** in `src/govql_mcp_server/server.py`

```python
from .tools import (  # noqa: E402, F401
    describe_type,
    find_legislator,
    find_vote,
    list_types,
    passthrough,
)
```

- [ ] **Step 6: Run the full suite**

Run: `uv run pytest -q`
Expected: PASS — existing ~23 + Task 1 (9) + Task 2 (4) + Task 3 (4).

- [ ] **Step 7: Commit**

```bash
git add src/govql_mcp_server/tools/find_vote.py src/govql_mcp_server/server.py tests/test_find_vote.py
git commit -m "feat(mcp): add find_vote discovery tool (#68)"
```

---

### Task 4: Docs, roadmap edit, CHANGELOG, and version bump

**Files:**
- Modify: `docs/design.md` (repo path `mcp-server/docs/design.md`) — roadmap
- Modify: `README.md` (repo path `mcp-server/README.md`) — Tools table, What-you-can-do, Status
- Modify: `CHANGELOG.md` (repo path `mcp-server/CHANGELOG.md`) — `## [0.2.0]`
- Modify: `pyproject.toml` — version `0.1.1` → `0.2.0`

**Interfaces:** none (documentation + metadata).

- [ ] **Step 1: Roadmap edit — `mcp-server/docs/design.md`**

Apply these edits to the "Roadmap" section:

1. In "Next up (before v0.2)", rewrite the FK paragraph and bullet to past tense — the FKs shipped in #63. Replace the "party-blind / no foreign key / [next task]" framing with a completed note, e.g.:

   > `vote_similarity.member_a`/`member_b` now carry foreign keys to
   > `legislators` (shipped in #63), so PostGraphile exposes
   > `legislatorByMemberA` / `legislatorByMemberB`. That unblocks a future
   > cross-party `most_agreeing_pairs` tool (see post-v0.4).

   Keep the **passthrough robustness** bullet as remaining pre-curated work.

2. Trim the milestone tool lists to the buildable set:
   - **v0.2:** `find_legislator`, `find_vote`
   - **v0.3:** `get_legislator`, `get_vote_with_positions`
   - **v0.4:** `get_voting_record`, `compare_voters`, `find_party_defectors`

3. Add a **post-v0.4** subsection that gathers the relocated, data/-FK-gated tools:

   ```markdown
   ### Post-v0.4 (data- or FK-gated)

   These are designed but deferred until their prerequisites land:

   - **`most_agreeing_pairs`** (cross-party) — needs the `vote_similarity`
     legislator FKs (#63) for inline `legislatorByMemberA/B` navigation.
   - **`find_bill`, `list_committees`** (discovery) and **`get_bill`,
     `get_committee`** (detail) — need the `bills`/`cosponsors`/`committees`
     tables populated (the post-v0.4 GovQL data work).
   ```

4. Adjust the closing paragraph so the "past v0.4 shifts back to GovQL itself
   (populating bills/committees…)" note now explicitly precedes the relocated
   bill/committee tools above (data first, then their tools).

- [ ] **Step 2: README edits — `mcp-server/README.md`**

Add two rows to the Tools table (after `describe_type`):

```markdown
| `find_legislator` | Find members by name, party, state, or chamber when you don't know a bioguide id. Party/state/chamber match the member's terms; `current_only` (default) restricts to sitting members. Returns a compact ranked list. |
| `find_vote` | Search roll-call votes by topic (free-text over the question), chamber, congress, or category. Newest first. Returns a compact list with each `voteId`. |
```

Update the **Status** section to reflect five tools:

```markdown
As of 0.2.0, the server provides the three foundational tools (`execute_graphql`,
`list_types`, `describe_type`) plus the first curated **discovery** tools,
`find_legislator` and `find_vote`. Further curated tools (per-entity detail and
analysis — `get_legislator`, `get_voting_record`, `compare_voters`, …) are
planned for subsequent releases — see
[design.md](https://github.com/govql/govql/blob/main/mcp-server/docs/design.md).
```

(The existing "What you can do" example bullets already cover find-style
questions; no change required there.)

- [ ] **Step 3: CHANGELOG — `mcp-server/CHANGELOG.md`**

Insert below the top header block, above `## [0.1.1]`:

```markdown
## [0.2.0] — 2026-07-09

### Added

- `find_legislator` tool — discover members by `name`, `state`, `party`, and
  `chamber` (matched against their terms), with `current_only` (default) and a
  `limit`. Returns a compact ranked list with each member's `bioguideId` and
  current party/state/chamber.
- `find_vote` tool — search roll-call votes by `topic` (free-text over the vote
  question), `chamber`, `congress`, and `category`, newest first, with a `limit`.
- Curated tools cap result size two ways: a `limit` (default 20, max 500) and a
  response-byte guard that truncates oversized payloads and flags `truncated`.
```

- [ ] **Step 4: Version bump — `mcp-server/pyproject.toml`**

Change `version = "0.1.1"` to `version = "0.2.0"`.

- [ ] **Step 5: Verify install metadata + full suite**

```bash
uv run pytest -q
uv run python -c "from importlib.metadata import version; print(version('govql-mcp-server'))"
```

Expected: tests green; version prints `0.2.0` (after `uv`'s editable install picks up the bump — run `uv sync` first if it still prints `0.1.1`).

- [ ] **Step 6: Commit**

```bash
git add docs/design.md README.md CHANGELOG.md pyproject.toml
git commit -m "docs(mcp): roadmap re-slot, v0.2 tool docs, bump to 0.2.0 (#68)"
```

---

## Self-Review

**1. Spec coverage:**
- `_curated_shared.py` (normalizers, clamp_limit, byte guard, network reuse) → Task 1 ✓
- `find_legislator` (nested-term filter, party-full-string, current_only, name OR) → Task 2 ✓
- `find_vote` (question search, chamber code, recency) → Task 3 ✓
- Variable-based filters (no interpolation) → both tools use `$filter` ✓
- Envelope + GraphQL-errors-as-data + transport failure → every tool + tests ✓
- Row cap + byte guard → Task 1 + used in Tasks 2–3, asserted in Task 1 ✓
- Roadmap edit (trim, relocate, FK past tense) → Task 4 Step 1 ✓
- README/CHANGELOG/version 0.2.0 → Task 4 Steps 2–4 ✓
- Live-verified fixtures → Steps 1 in Tasks 2 & 3 ✓
- No FK dependency → find_* never touch vote_similarity ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; the roadmap-edit step gives concrete replacement text. ✓

**3. Type consistency:** Helper names (`normalize_party`, `normalize_chamber_termtype`, `normalize_chamber_code`, `clamp_limit`, `guard_items`, `today_iso`) are identical in Task 1 and their call sites in Tasks 2–3. Tool return keys (`legislators`/`votes`, `result_count`, `truncated`) match between implementation and tests. `server.py` import grows monotonically (Task 2 adds `find_legislator`, Task 3 adds `find_vote`). ✓
