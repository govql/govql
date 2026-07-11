"""The get_voting_record tool — a member's participation + party loyalty."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import display_chamber_code, full_name, network_error_response

_QUERY = """
query GetVotingRecord($sFilter: MemberVotingSummaryFilter,
                      $aFilter: MemberPartyAgreementFilter, $id: String!) {
  s: allMemberVotingSummaries(filter: $sFilter) {
    nodes { congress position positions }
  }
  a: allMemberPartyAgreements(filter: $aFilter) {
    nodes { congress chamber memberParty otherParty agreementRate }
  }
  m: legislatorByBioguideId(bioguideId: $id) { firstName lastName }
}
"""

# Classify each stored position by MEANING, not literal text:
#   yea  = up-vote:   Yea (Senate) | Aye (House) | Guilty (impeachment: convict)
#   nay  = down-vote: Nay (Senate) | No  (House) | Not Guilty (impeachment: acquit)
#   present / notVoting = as stored
# Anything else (Speaker-election votes cast for a named candidate, plus any
# future/unknown position) falls through to `other` via the .get default — still
# a vote cast, so it counts toward participation but is not a yea/nay/present.
_POS_KEY = {
    "Yea": "yea", "Aye": "yea", "Guilty": "yea",
    "Nay": "nay", "No": "nay", "Not Guilty": "nay",
    "Present": "present",
    "Not Voting": "notVoting",
}


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

    For each congress: total roll calls; vote counts bucketed by meaning — yea
    (Yea/Aye/Guilty), nay (Nay/No/Not Guilty), present, notVoting, and other
    (Speaker-election and any non-yea/nay vote); a participation rate (votes cast
    / total — everything except Not Voting); and a party-loyalty rate (how often
    they voted with their own party's majority). The five vote buckets sum to
    totalVotes. Complements get_legislator (identity). `records` is empty if the
    member has no summary rows.
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
    name = full_name(member)

    # Aggregate summary rows per congress (bucket by meaning).
    per_congress: dict[int, dict[str, Any]] = {}
    for row in data["s"]["nodes"]:
        c = row["congress"]
        rec = per_congress.setdefault(
            c, {"congress": c, "chamber": None, "totalVotes": 0,
                 "yea": 0, "nay": 0, "present": 0, "notVoting": 0, "other": 0,
                 "participationRate": None, "partyLoyaltyRate": None})
        rec[_POS_KEY.get(row["position"], "other")] += row["positions"]
        rec["totalVotes"] += row["positions"]

    # Own-party loyalty row (otherParty == memberParty) + chamber, per congress.
    for row in data["a"]["nodes"]:
        if row["memberParty"] == row["otherParty"]:
            rec = per_congress.get(row["congress"])
            if rec is not None:
                rec["partyLoyaltyRate"] = row["agreementRate"]
                rec["chamber"] = display_chamber_code(row["chamber"])

    for rec in per_congress.values():
        total = rec["totalVotes"]
        if total:
            rec["participationRate"] = (total - rec["notVoting"]) / total

    records = sorted(per_congress.values(), key=lambda r: r["congress"], reverse=True)
    return {"data": {"bioguideId": bid, "name": name, "records": records}}
