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
