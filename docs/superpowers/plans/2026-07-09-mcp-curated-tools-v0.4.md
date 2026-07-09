# MCP Curated Tools v0.4 (Aggregation/analysis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v0.4 "Aggregation/analysis" milestone: `get_voting_record` (a member's participation + party loyalty), `compare_voters` (pairwise agreement between two members), and `find_party_defectors` (least-loyal members), plus README/CHANGELOG updates and the version bump to `0.4.0`.

**Architecture:** Same pattern as v0.2/v0.3 — thin async `@mcp.tool` modules over the precomputed aggregate connections (`allMemberVotingSummaries`, `allMemberPartyAgreements`, `allVoteSimilarities`), variable-based GraphQL, `_curated_shared.py` helpers. None of these tools depend on the #63 `vote_similarity` FKs: `compare_voters` filters `vote_similarity` on its scalar `memberA`/`memberB` columns and looks names up via aliased `legislatorByBioguideId`.

**Tech Stack:** Python ≥3.10, FastMCP ≥3.3.0, httpx, pydantic; pytest + pytest-asyncio + respx. `uv`.

**Prerequisite:** v0.3 is merged; this branch is cut from fresh `main`, so `_curated_shared.py` and the earlier tools exist.

## Global Constraints

- Component dir: `mcp-server/`. Variable-based filters; envelope + error handling as before.
- Reuse `_curated_shared.py` (`clamp_limit`, `guard_items`, `normalize_party_code`, `normalize_chamber_code`, `network_error_response`).
- Aggregate facts (verified live):
  - `MemberVotingSummary` is long-format `{bioguideId, congress, category, position, positions}` (`positions` = count); **no chamber column**.
  - `MemberPartyAgreement` is `{congress, chamber, bioguideId, memberParty, otherParty, sharedVotes, agreed, agreementRate}` and exposes `legislatorByBioguideId`. Party codes are `"D"`/`"R"`/`"I"`. The **own-party loyalty row** is where `otherParty == memberParty`.
  - `VoteSimilarity` is `{congress, chamber, memberA, memberB, sharedVotes, agreed}` — **no precomputed rate** (compute `agreed / sharedVotes`), pairs stored once with `member_a < member_b`.
- Every mocked query verified live against `https://api.govql.us/graphql` first.
- Version target: `0.4.0`. Commits authored by Alex, no Claude co-author trailer.
- Full suite: `uv run pytest -q`.

---

### Task 1: `get_voting_record` tool

**Files:**
- Create: `src/govql_mcp_server/tools/get_voting_record.py`
- Modify: `src/govql_mcp_server/server.py`
- Test: `tests/test_get_voting_record.py`

**Interfaces:**
- Consumes: `network_error_response`; `graphql_client`; `mcp`; `logger`.
- Produces: MCP tool `get_voting_record(bioguide_id, congress)` → `{"data": {"bioguideId", "name", "records": [ {congress, chamber, totalVotes, yea, nay, present, notVoting, participationRate, partyLoyaltyRate} ]}}`.

- [ ] **Step 1: Live-verify**

```bash
curl -s -X POST https://api.govql.us/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query($id:String!){s:allMemberVotingSummaries(filter:{bioguideId:{equalTo:$id}}){nodes{congress category position positions}} a:allMemberPartyAgreements(filter:{bioguideId:{equalTo:$id}}){nodes{congress chamber memberParty otherParty agreementRate}} m:legislatorByBioguideId(bioguideId:$id){firstName lastName}}","variables":{"id":"P000145"}}'
```

Expected: summary rows (per congress/category/position), agreement rows (incl. own-party where `memberParty==otherParty`), and the member's name.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_get_voting_record.py`:

```python
"""Tests for the get_voting_record tool."""

from __future__ import annotations

from tests.conftest import graphql_response, tool_payload


_DATA = {
    "s": {"nodes": [
        {"congress": 118, "category": "cloture", "position": "Yea", "positions": 100},
        {"congress": 118, "category": "cloture", "position": "Nay", "positions": 40},
        {"congress": 118, "category": "cloture", "position": "Not Voting", "positions": 10},
        {"congress": 118, "category": "passage", "position": "Yea", "positions": 50},
    ]},
    "a": {"nodes": [
        {"congress": 118, "chamber": "s", "memberParty": "D", "otherParty": "D",
         "agreementRate": 0.95},
        {"congress": 118, "chamber": "s", "memberParty": "D", "otherParty": "R",
         "agreementRate": 0.20},
    ]},
    "m": {"firstName": "Alex", "lastName": "Padilla"},
}


async def test_aggregates_per_congress_with_loyalty(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    result = await client.call_tool("get_voting_record", {"bioguide_id": "P000145"})

    data = tool_payload(result)["data"]
    assert data["name"] == "Alex Padilla"
    rec = data["records"][0]
    assert rec["congress"] == 118
    assert rec["chamber"] == "s"
    assert rec["totalVotes"] == 200           # 100+40+10+50
    assert rec["yea"] == 150
    assert rec["nay"] == 40
    assert rec["notVoting"] == 10
    assert abs(rec["participationRate"] - 190 / 200) < 1e-9   # voted / total
    assert rec["partyLoyaltyRate"] == 0.95    # own-party row only
    assert result.is_error is False


async def test_no_records_returns_empty_list(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"s": {"nodes": []}, "a": {"nodes": []},
                  "m": {"firstName": "No", "lastName": "One"}}
        )
    )

    result = await client.call_tool("get_voting_record", {"bioguide_id": "X"})

    assert tool_payload(result)["data"]["records"] == []
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_get_voting_record.py -q`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement `get_voting_record.py`**

Create `src/govql_mcp_server/tools/get_voting_record.py`:

```python
"""The get_voting_record tool — a member's participation + party loyalty."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import network_error_response

_QUERY = """
query GetVotingRecord($sFilter: MemberVotingSummaryFilter,
                      $aFilter: MemberPartyAgreementFilter, $id: String!) {
  s: allMemberVotingSummaries(filter: $sFilter) {
    nodes { congress category position positions }
  }
  a: allMemberPartyAgreements(filter: $aFilter) {
    nodes { congress chamber memberParty otherParty agreementRate }
  }
  m: legislatorByBioguideId(bioguideId: $id) { firstName lastName }
}
"""

_POS_KEY = {"Yea": "yea", "Nay": "nay", "Present": "present", "Not Voting": "notVoting"}


@mcp.tool
async def get_voting_record(
    bioguide_id: Annotated[
        str, Field(description="The member's bioguide id. Get one from find_legislator."),
    ],
    congress: Annotated[
        int | None, Field(description="Restrict to one congress (e.g. 118). Omit for "
                                     "all congresses, one record each."),
    ] = None,
) -> dict[str, Any]:
    """Return a member's voting behavior per congress.

    For each congress: total roll calls, Yea/Nay/Present/Not-Voting counts, a
    participation rate (votes cast / total), and party-loyalty rate (how often
    they voted with their own party's majority). Complements get_legislator
    (which covers identity). `records` is empty if the member has no summary rows.
    """
    if not bioguide_id or not bioguide_id.strip():
        return {"data": None, "errors": [{"message": "bioguide_id must be a non-empty string"}]}
    bid = bioguide_id.strip()

    s_filter: dict[str, Any] = {"bioguideId": {"equalTo": bid}}
    a_filter: dict[str, Any] = {"bioguideId": {"equalTo": bid}}
    if congress is not None:
        s_filter["congress"] = {"equalTo": congress}
        a_filter["congress"] = {"equalTo": congress}

    variables = {"sFilter": s_filter, "aFilter": a_filter, "id": bid}
    try:
        result = await graphql_client.execute_graphql(_QUERY, variables)
    except httpx.HTTPError as err:
        logger.warning("get_voting_record transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    data = result["data"]
    member = data.get("m") or {}
    name = " ".join(x for x in (member.get("firstName"), member.get("lastName")) if x) or None

    # Aggregate summary rows per congress.
    per_congress: dict[int, dict[str, Any]] = {}
    for row in data["s"]["nodes"]:
        c = row["congress"]
        rec = per_congress.setdefault(
            c, {"congress": c, "chamber": None, "totalVotes": 0,
                 "yea": 0, "nay": 0, "present": 0, "notVoting": 0,
                 "participationRate": None, "partyLoyaltyRate": None})
        key = _POS_KEY.get(row["position"])
        if key:
            rec[key] += row["positions"]
        rec["totalVotes"] += row["positions"]

    # Own-party loyalty row (otherParty == memberParty) + chamber, per congress.
    for row in data["a"]["nodes"]:
        if row["memberParty"] == row["otherParty"]:
            rec = per_congress.get(row["congress"])
            if rec is not None:
                rec["partyLoyaltyRate"] = row["agreementRate"]
                rec["chamber"] = row["chamber"]

    for rec in per_congress.values():
        total = rec["totalVotes"]
        if total:
            rec["participationRate"] = (rec["yea"] + rec["nay"] + rec["present"]) / total

    records = sorted(per_congress.values(), key=lambda r: r["congress"], reverse=True)
    return {"data": {"bioguideId": bid, "name": name, "records": records}}
```

- [ ] **Step 5: Register** in `server.py` (add `get_voting_record`, keep alphabetical).

- [ ] **Step 6: Run tests**

Run: `uv run pytest tests/test_get_voting_record.py -q`
Expected: PASS (2).

- [ ] **Step 7: Commit**

```bash
git add src/govql_mcp_server/tools/get_voting_record.py src/govql_mcp_server/server.py tests/test_get_voting_record.py
git commit -m "feat(mcp): add get_voting_record analysis tool"
```

---

### Task 2: `compare_voters` tool

**Files:**
- Create: `src/govql_mcp_server/tools/compare_voters.py`
- Modify: `src/govql_mcp_server/server.py`
- Test: `tests/test_compare_voters.py`

**Interfaces:**
- Consumes: `network_error_response`; `graphql_client`; `mcp`; `logger`.
- Produces: MCP tool `compare_voters(bioguide_id_a, bioguide_id_b, congress)` → `{"data": {"memberA": {bioguideId, name}, "memberB": {bioguideId, name}, "comparisons": [ {congress, chamber, sharedVotes, agreed, agreementRate} ]}}`.

- [ ] **Step 1: Live-verify** (pick two real senators; canonicalize the pair so member_a < member_b)

```bash
curl -s -X POST https://api.govql.us/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query($a:String!,$b:String!,$f:VoteSimilarityFilter){sims:allVoteSimilarities(filter:$f){nodes{congress chamber sharedVotes agreed}} ma:legislatorByBioguideId(bioguideId:$a){firstName lastName} mb:legislatorByBioguideId(bioguideId:$b){firstName lastName}}","variables":{"a":"S001150","b":"P000145","f":{"memberA":{"equalTo":"P000145"},"memberB":{"equalTo":"S001150"}}}}'
```

Expected: similarity rows for the canonical pair + both names.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_compare_voters.py`:

```python
"""Tests for the compare_voters tool."""

from __future__ import annotations

import json

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_DATA = {
    "sims": {"nodes": [
        {"congress": 118, "chamber": "s", "sharedVotes": 200, "agreed": 180},
    ]},
    "ma": {"firstName": "Alex", "lastName": "Padilla"},
    "mb": {"firstName": "Adam", "lastName": "Schiff"},
}


async def test_canonicalizes_pair_and_computes_rate(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    # Pass them in non-canonical order; tool must sort to member_a < member_b.
    result = await client.call_tool(
        "compare_voters",
        {"bioguide_id_a": "S001150", "bioguide_id_b": "P000145"},
    )

    filt = _last_variables(route)["filter"]
    assert filt["memberA"]["equalTo"] == "P000145"   # min
    assert filt["memberB"]["equalTo"] == "S001150"   # max
    data = tool_payload(result)["data"]
    comp = data["comparisons"][0]
    assert comp["sharedVotes"] == 200
    assert abs(comp["agreementRate"] - 0.9) < 1e-9   # 180/200
    # Names map back to the *requested* a/b, not the canonical order.
    assert data["memberA"]["bioguideId"] == "S001150"
    assert data["memberA"]["name"] == "Adam Schiff"


async def test_no_overlap_returns_empty_with_message(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"sims": {"nodes": []}, "ma": {"firstName": "A", "lastName": "B"},
                  "mb": {"firstName": "C", "lastName": "D"}}
        )
    )

    result = await client.call_tool(
        "compare_voters", {"bioguide_id_a": "A000001", "bioguide_id_b": "B000002"}
    )

    data = tool_payload(result)["data"]
    assert data["comparisons"] == []
    assert "message" in data
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_compare_voters.py -q`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement `compare_voters.py`**

Create `src/govql_mcp_server/tools/compare_voters.py`:

```python
"""The compare_voters tool — pairwise voting agreement between two members."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import network_error_response

_QUERY = """
query CompareVoters($a: String!, $b: String!, $filter: VoteSimilarityFilter) {
  sims: allVoteSimilarities(filter: $filter) {
    nodes { congress chamber sharedVotes agreed }
  }
  ma: legislatorByBioguideId(bioguideId: $a) { firstName lastName }
  mb: legislatorByBioguideId(bioguideId: $b) { firstName lastName }
}
"""


def _name(node: dict[str, Any] | None) -> str | None:
    node = node or {}
    return " ".join(x for x in (node.get("firstName"), node.get("lastName")) if x) or None


@mcp.tool
async def compare_voters(
    bioguide_id_a: Annotated[
        str, Field(description="First member's bioguide id."),
    ],
    bioguide_id_b: Annotated[
        str, Field(description="Second member's bioguide id."),
    ],
    congress: Annotated[
        int | None, Field(description="Restrict to one congress. Omit for every "
                                     "congress the two share."),
    ] = None,
) -> dict[str, Any]:
    """Compare how often two members voted the same way.

    Uses the precomputed `vote_similarity` aggregate (shared Yea/Nay votes and
    how many agreed) per congress+chamber. Returns each shared slice with an
    `agreementRate` (`agreed / sharedVotes`). Empty `comparisons` (with a
    message) if the two never served in the same chamber+congress.
    """
    a, b = bioguide_id_a.strip(), bioguide_id_b.strip()
    if not a or not b:
        return {"data": None, "errors": [{"message": "both bioguide ids must be non-empty"}]}

    lo, hi = sorted([a, b])  # storage order: member_a < member_b
    filt: dict[str, Any] = {"memberA": {"equalTo": lo}, "memberB": {"equalTo": hi}}
    if congress is not None:
        filt["congress"] = {"equalTo": congress}

    try:
        result = await graphql_client.execute_graphql(_QUERY, {"a": a, "b": b, "filter": filt})
    except httpx.HTTPError as err:
        logger.warning("compare_voters transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    data = result["data"]
    comparisons = []
    for row in data["sims"]["nodes"]:
        shared = row["sharedVotes"]
        comparisons.append({
            "congress": row["congress"],
            "chamber": row["chamber"],
            "sharedVotes": shared,
            "agreed": row["agreed"],
            "agreementRate": (row["agreed"] / shared) if shared else None,
        })
    comparisons.sort(key=lambda r: r["congress"], reverse=True)

    out: dict[str, Any] = {
        "memberA": {"bioguideId": a, "name": _name(data.get("ma"))},
        "memberB": {"bioguideId": b, "name": _name(data.get("mb"))},
        "comparisons": comparisons,
    }
    if not comparisons:
        out["message"] = ("No shared congress+chamber found for these two members "
                          "in vote_similarity.")
    return {"data": out}
```

- [ ] **Step 5: Register** in `server.py` (add `compare_voters`, keep alphabetical).

- [ ] **Step 6: Run tests**

Run: `uv run pytest tests/test_compare_voters.py -q`
Expected: PASS (2).

- [ ] **Step 7: Commit**

```bash
git add src/govql_mcp_server/tools/compare_voters.py src/govql_mcp_server/server.py tests/test_compare_voters.py
git commit -m "feat(mcp): add compare_voters analysis tool"
```

---

### Task 3: `find_party_defectors` tool

**Files:**
- Create: `src/govql_mcp_server/tools/find_party_defectors.py`
- Modify: `src/govql_mcp_server/server.py`
- Test: `tests/test_find_party_defectors.py`

**Interfaces:**
- Consumes: `_curated_shared` (`clamp_limit`, `normalize_party_code`, `normalize_chamber_code`, `network_error_response`); `graphql_client`; `mcp`; `logger`.
- Produces: MCP tool `find_party_defectors(congress, chamber, party, limit)` → `{"data": {"congress", "chamber", "defectors": [ {bioguideId, name, memberParty, agreementRate, sharedVotes, agreed} ]}}`.

- [ ] **Step 1: Live-verify** (own-party rows via an OR of per-party clauses)

```bash
curl -s -X POST https://api.govql.us/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query($f:MemberPartyAgreementFilter,$n:Int){allMemberPartyAgreements(filter:$f,orderBy:AGREEMENT_RATE_ASC,first:$n){nodes{bioguideId memberParty agreementRate sharedVotes agreed legislatorByBioguideId{firstName lastName}}}}","variables":{"f":{"congress":{"equalTo":118},"chamber":{"equalTo":"s"},"or":[{"memberParty":{"equalTo":"D"},"otherParty":{"equalTo":"D"}},{"memberParty":{"equalTo":"R"},"otherParty":{"equalTo":"R"}},{"memberParty":{"equalTo":"I"},"otherParty":{"equalTo":"I"}}]},"n":5}}'
```

Expected: the 5 lowest own-party agreement rows for the 118th Senate, names inline.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_find_party_defectors.py`:

```python
"""Tests for the find_party_defectors tool."""

from __future__ import annotations

import json

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_DATA = {"allMemberPartyAgreements": {"nodes": [
    {"bioguideId": "M000001", "memberParty": "D", "agreementRate": 0.55,
     "sharedVotes": 500, "agreed": 275,
     "legislatorByBioguideId": {"firstName": "Joe", "lastName": "Manchin"}},
]}}


async def test_all_parties_uses_or_of_own_party_clauses(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    result = await client.call_tool(
        "find_party_defectors", {"congress": 118, "chamber": "senate"}
    )

    filt = _last_variables(route)["filter"]
    assert filt["congress"]["equalTo"] == 118
    assert filt["chamber"]["equalTo"] == "s"
    clauses = {(c["memberParty"]["equalTo"], c["otherParty"]["equalTo"]) for c in filt["or"]}
    assert clauses == {("D", "D"), ("R", "R"), ("I", "I")}
    d = tool_payload(result)["data"]["defectors"][0]
    assert d["name"] == "Joe Manchin"
    assert d["memberParty"] == "D"
    assert result.is_error is False


async def test_single_party_uses_direct_clause(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    await client.call_tool("find_party_defectors", {"congress": 118, "party": "dem"})

    filt = _last_variables(route)["filter"]
    assert filt["memberParty"]["equalTo"] == "D"
    assert filt["otherParty"]["equalTo"] == "D"
    assert "or" not in filt


async def test_unknown_party_errors_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    result = await client.call_tool(
        "find_party_defectors", {"congress": 118, "party": "whigs"}
    )

    assert "Unrecognized party" in tool_payload(result)["errors"][0]["message"]
    assert route.called is False
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_find_party_defectors.py -q`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement `find_party_defectors.py`**

Create `src/govql_mcp_server/tools/find_party_defectors.py`:

```python
"""The find_party_defectors tool — members who least often vote with their party."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import (
    clamp_limit,
    network_error_response,
    normalize_chamber_code,
    normalize_party_code,
)

_QUERY = """
query FindPartyDefectors($filter: MemberPartyAgreementFilter, $first: Int) {
  allMemberPartyAgreements(filter: $filter, orderBy: AGREEMENT_RATE_ASC, first: $first) {
    nodes {
      bioguideId
      memberParty
      agreementRate
      sharedVotes
      agreed
      legislatorByBioguideId { firstName lastName }
    }
  }
}
"""

_ALL_PARTIES = ("D", "R", "I")


@mcp.tool
async def find_party_defectors(
    congress: Annotated[
        int, Field(description="Congress number, e.g. 118. Required."),
    ],
    chamber: Annotated[
        str | None, Field(description="'house'/'h' or 'senate'/'s'. Omit for both."),
    ] = None,
    party: Annotated[
        str | None, Field(description="Limit to one party ('D'/'R'/'I' or a full "
                                     "name). Omit to rank across all parties."),
    ] = None,
    limit: Annotated[
        int | None, Field(description="Max results (default 20, cap 500). Lowest "
                                     "own-party agreement first."),
    ] = None,
) -> dict[str, Any]:
    """Find members who least often voted with their own party's majority.

    Ranks the own-party agreement rate (from `member_party_agreement`, where
    `other_party == member_party`) ascending, so the biggest defectors come
    first. Restrict with `party` or `chamber`; results carry each member's name.
    """
    try:
        chamber_code = normalize_chamber_code(chamber)
        party_code = normalize_party_code(party)
    except ValueError as err:
        return {"data": None, "errors": [{"message": str(err)}]}

    filt: dict[str, Any] = {"congress": {"equalTo": congress}}
    if chamber_code is not None:
        filt["chamber"] = {"equalTo": chamber_code}
    if party_code is not None:
        filt["memberParty"] = {"equalTo": party_code}
        filt["otherParty"] = {"equalTo": party_code}
    else:
        filt["or"] = [
            {"memberParty": {"equalTo": p}, "otherParty": {"equalTo": p}}
            for p in _ALL_PARTIES
        ]

    try:
        result = await graphql_client.execute_graphql(
            _QUERY, {"filter": filt, "first": clamp_limit(limit)}
        )
    except httpx.HTTPError as err:
        logger.warning("find_party_defectors transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    defectors = []
    for row in result["data"]["allMemberPartyAgreements"]["nodes"]:
        leg = row.get("legislatorByBioguideId") or {}
        name = " ".join(x for x in (leg.get("firstName"), leg.get("lastName")) if x) or None
        defectors.append({
            "bioguideId": row["bioguideId"],
            "name": name,
            "memberParty": row["memberParty"],
            "agreementRate": row["agreementRate"],
            "sharedVotes": row["sharedVotes"],
            "agreed": row["agreed"],
        })

    return {"data": {"congress": congress, "chamber": chamber_code, "defectors": defectors}}
```

- [ ] **Step 5: Register** in `server.py` (add `find_party_defectors`, keep alphabetical).

- [ ] **Step 6: Run the full suite**

Run: `uv run pytest -q`
Expected: PASS — prior tests + Task 1 (2) + Task 2 (2) + Task 3 (3).

- [ ] **Step 7: Commit**

```bash
git add src/govql_mcp_server/tools/find_party_defectors.py src/govql_mcp_server/server.py tests/test_find_party_defectors.py
git commit -m "feat(mcp): add find_party_defectors analysis tool"
```

---

### Task 4: Docs, CHANGELOG, version bump, and roadmap note

**Files:**
- Modify: `README.md` (Tools table, Status)
- Modify: `CHANGELOG.md` (`## [0.4.0]`)
- Modify: `pyproject.toml` (`0.3.0` → `0.4.0`)
- Modify: `docs/design.md` (post-v0.4 note)

- [ ] **Step 1: README Tools-table rows** (after `get_vote_with_positions`):

```markdown
| `get_voting_record` | A member's voting behavior per congress: participation rate and party-loyalty rate, from the precomputed summaries. |
| `compare_voters` | How often two members voted the same way, per congress+chamber, with an agreement rate. |
| `find_party_defectors` | Members who least often voted with their own party's majority in a congress; optional party/chamber filters. |
```

Update **Status** to `0.4.0`: all three analysis tools shipped; the discovery/detail/analysis curated set is complete. Note the remaining `most_agreeing_pairs` and bill/committee tools are post-v0.4 (data/FK-gated) per the roadmap.

- [ ] **Step 2: CHANGELOG** — insert above `## [0.3.0]`:

```markdown
## [0.4.0] — 2026-07-09

### Added

- `get_voting_record` tool — per-congress participation and party-loyalty rates
  for a member, from the precomputed voting summaries.
- `compare_voters` tool — pairwise agreement between two members (shared votes,
  agreed count, agreement rate) per congress+chamber, via `vote_similarity`.
- `find_party_defectors` tool — members ranked by lowest own-party agreement in
  a congress, with optional party/chamber filters.
```

- [ ] **Step 3: Version bump** — `pyproject.toml` `0.3.0` → `0.4.0`.

- [ ] **Step 4: Roadmap note** — in `mcp-server/docs/design.md`, mark the v0.4 curated milestone complete and confirm `most_agreeing_pairs` (needs the #63 FK's `legislatorByMemberA/B`) plus the bill/committee tools remain the post-v0.4 items.

- [ ] **Step 5: Verify + commit**

```bash
uv run pytest -q
git add README.md CHANGELOG.md pyproject.toml docs/design.md
git commit -m "docs(mcp): v0.4 tool docs and bump to 0.4.0"
```

---

## Self-Review

**1. Spec coverage:**
- `get_voting_record` — per-congress participation + party loyalty, own-party row selection, no-chamber-on-summary handled (chamber sourced from agreement row) → Task 1 ✓
- `compare_voters` — canonical `member_a < member_b`, client-side `agreed/sharedVotes`, names via side lookup (no FK), empty-overlap message → Task 2 ✓
- `find_party_defectors` — `otherParty==memberParty` loyalty rows via single-query OR (all parties) or direct clause (one party), ascending, names inline → Task 3 ✓
- No FK dependency anywhere → confirmed (compare_voters uses scalar columns) ✓
- README/CHANGELOG/version 0.4.0 + roadmap note → Task 4 ✓

**2. Placeholder scan:** No TBD/TODO; complete code and concrete doc text. ✓

**3. Type consistency:** `_curated_shared` helper names match prior definitions. Return keys (`records`; `memberA`/`memberB`/`comparisons`; `defectors`) match impl and tests. Party-code normalization (`normalize_party_code`) and chamber-code (`normalize_chamber_code`) used consistently. The own-party OR-clause shape is identical in the live-verify curl, the impl, and the test assertion. ✓

> **Note vs spec:** the spec's `get_voting_record` return listed a `chamber`; since `member_voting_summary` has no chamber column, chamber is sourced from the member's `member_party_agreement` row for that congress (null if absent). This is the verified-shape implementation.
