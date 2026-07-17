"""The compare_voters tool — pairwise voting agreement between two members."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import display_chamber_code, full_name, network_error_response

_QUERY = """
query CompareVoters($a: String!, $b: String!, $filter: VoteSimilarityFilter) {
  sims: allVoteSimilarities(filter: $filter) {
    nodes { congress chamber sharedVotes agreed }
  }
  ma: legislatorByBioguideId(bioguideId: $a) { firstName lastName }
  mb: legislatorByBioguideId(bioguideId: $b) { firstName lastName }
}
"""


@mcp.tool
async def compare_voters(
    bioguide_id_a: Annotated[
        str,
        Field(description="First member's bioguide id (from find_legislator)."),
    ],
    bioguide_id_b: Annotated[
        str,
        Field(description="Second member's bioguide id (from find_legislator)."),
    ],
    congress: Annotated[
        int | None,
        Field(
            description="Restrict to one congress. Omit for every "
            "congress the two share."
        ),
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
        return {
            "data": None,
            "errors": [{"message": "both bioguide ids must be non-empty"}],
        }

    lo, hi = sorted([a, b])  # storage order: member_a < member_b
    filt: dict[str, Any] = {"memberA": {"equalTo": lo}, "memberB": {"equalTo": hi}}
    if congress is not None:
        filt["congress"] = {"equalTo": congress}

    try:
        result = await graphql_client.execute_graphql(
            _QUERY, {"a": a, "b": b, "filter": filt}
        )
    except httpx.HTTPError as err:
        logger.warning("compare_voters transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    data = result["data"]
    comparisons = []
    for row in data["sims"]["nodes"]:
        shared = row["sharedVotes"]
        comparisons.append(
            {
                "congress": row["congress"],
                "chamber": display_chamber_code(row["chamber"]),
                "sharedVotes": shared,
                "agreed": row["agreed"],
                "agreementRate": (row["agreed"] / shared) if shared else None,
            }
        )
    comparisons.sort(key=lambda r: r["congress"], reverse=True)

    out: dict[str, Any] = {
        "memberA": {"bioguideId": a, "name": full_name(data.get("ma"))},
        "memberB": {"bioguideId": b, "name": full_name(data.get("mb"))},
        "comparisons": comparisons,
    }
    if not comparisons:
        out["message"] = (
            "No shared congress+chamber found for these two members in vote_similarity."
        )
    return {"data": out}
