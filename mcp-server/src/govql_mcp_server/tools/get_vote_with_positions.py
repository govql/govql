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
    LIMIT_MAX,
    clamp_limit,
    display_chamber_code,
    guard_items,
    network_error_response,
    normalize_party_code,
    normalize_position,
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
    return f"{header} {{\n{meta}{_AGGS}\n}}"


@mcp.tool
async def get_vote_with_positions(
    vote_id: Annotated[
        str,
        Field(
            description="The vote id (e.g. 's192-119.2026'). Get one from find_vote."
        ),
    ],
    include_positions: Annotated[
        bool,
        Field(
            description="Include the per-member position list — returns the "
            "full roster (up to ~500, byte-guarded). Default "
            "false — tallies only."
        ),
    ] = False,
    party: Annotated[
        str | None,
        Field(
            description="Only positions from this party ('D'/'R'/'I'). "
            "Implies include_positions."
        ),
    ] = None,
    state: Annotated[
        str | None,
        Field(
            description="Only positions from this state (2-letter). "
            "Implies include_positions."
        ),
    ] = None,
    position: Annotated[
        str | None,
        Field(
            description="Only this position: 'Yea','Nay','Present',"
            "'Not Voting'. Implies include_positions."
        ),
    ] = None,
    positions_limit: Annotated[
        int | None,
        Field(
            description="Max positions returned; default = the full "
            "roster (up to 500). Set lower to sample."
        ),
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
    if not vote_id or not vote_id.strip():
        return {
            "data": None,
            "errors": [{"message": "vote_id must be a non-empty string"}],
        }

    want_positions = include_positions or any(
        v is not None for v in (party, state, position)
    )

    try:
        pos_filter: dict[str, Any] = {}
        if party is not None:
            pos_filter["party"] = {"equalTo": normalize_party_code(party)}
        if state is not None:
            pos_filter["state"] = {"equalTo": normalize_state(state)}
        if position is not None:
            pos_filter["position"] = {"equalTo": normalize_position(position)}
    except ValueError as err:
        return {"data": None, "errors": [{"message": str(err)}]}

    variables: dict[str, Any] = {"vid": vote_id}
    if want_positions:
        variables["posFilter"] = pos_filter or None
        variables["posFirst"] = (
            LIMIT_MAX if positions_limit is None else clamp_limit(positions_limit)
        )

    try:
        result = await graphql_client.execute_graphql(
            _build_query(want_positions), variables
        )
    except httpx.HTTPError as err:
        logger.warning("get_vote_with_positions transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    data = result["data"]
    vote = data.get("voteByVoteId")
    if vote is None:
        return {
            "data": {
                "vote": None,
                "totals": {},
                "party_breakdown": {},
                "positions": None,
                "truncated": False,
            }
        }
    vote["chamber"] = display_chamber_code(vote.get("chamber"))

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

    return {
        "data": {
            "vote": vote,
            "totals": totals,
            "party_breakdown": breakdown,
            "positions": positions_out,
            "truncated": truncated,
        }
    }
