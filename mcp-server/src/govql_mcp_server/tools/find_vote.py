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

_CHAMBER_DISPLAY = {"s": "Senate", "h": "House"}

_QUERY = """
query FindVote($filter: VoteFilter, $first: Int) {
  allVotes(filter: $filter, orderBy: VOTED_AT_DESC, first: $first) {
    totalCount
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

    `total_matches` is how many votes match the filter overall (it can exceed
    the number returned — raise `limit` or refine the filter to see more).
    `truncated` is true if the response-size guard trimmed the returned list.
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

    connection = result["data"]["allVotes"]
    shaped = [
        {**n, "chamber": _CHAMBER_DISPLAY.get(n.get("chamber"), n.get("chamber"))}
        for n in connection["nodes"]
    ]
    items, truncated = guard_items(shaped)
    return {"data": {"votes": items, "total_matches": connection.get("totalCount"),
                     "truncated": truncated}}
