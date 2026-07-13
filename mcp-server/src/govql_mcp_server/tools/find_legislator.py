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
    display_chamber_termtype,
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
    totalCount
    nodes {
      bioguideId
      firstName
      lastName
      officialFull
      legislatorTermsByBioguideIdList(orderBy: END_DATE_DESC, first: 1) {
        party
        state
        termType
        district
        endDate
      }
    }
  }
}
"""


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
        "chamber": display_chamber_termtype(latest.get("termType")),
        "district": latest.get("district"),
        "current": bool(end and end > today_iso()),
    }


@mcp.tool
async def find_legislator(
    name: Annotated[
        str | None,
        Field(
            description="Case-insensitive substring matched across first name, "
            "last name, official full name, and nickname."
        ),
    ] = None,
    state: Annotated[
        str | None,
        Field(description="Two-letter USPS state code, e.g. 'CA'."),
    ] = None,
    party: Annotated[
        str | None,
        Field(
            description="Party: 'D'/'R'/'I' or a full name like "
            "'Democrat'. Matches the member's term party."
        ),
    ] = None,
    chamber: Annotated[
        str | None,
        Field(description="'house'/'h' or 'senate'/'s'."),
    ] = None,
    district: Annotated[
        int | None,
        Field(
            description="House district number (e.g. 3). House-only "
            "(senators have none); at-large districts are 0. "
            "Pair with state."
        ),
    ] = None,
    current_only: Annotated[
        bool,
        Field(
            description="Only members currently serving (a term ending in "
            "the future). Default true."
        ),
    ] = True,
    limit: Annotated[
        int | None,
        Field(description="Max results (default 20, capped at 500)."),
    ] = None,
) -> dict[str, Any]:
    """Find legislators by attributes when you don't know a bioguide id.

    A locator: give it a name and/or state/party/chamber/district and it returns
    matching members with their bioguide id and a compact snapshot of their
    latest term (name, party, state, chamber, district). Identity search only —
    it does NOT return committee membership, tenure, or voting behavior (and the
    committees/bills tables aren't populated). For a member's full detail (bio
    plus complete term history), pass a returned `bioguideId` to `get_legislator`;
    for voting behavior, use the analysis tools (`get_voting_record`,
    `compare_voters`, `find_party_defectors`).

    - `name` is a case-insensitive substring matched across first/last/official-
      full/nickname.
    - `party`/`state`/`chamber`/`district` match the member's *terms* (party is
      per-term, not on the legislator). `district` is House-only (senators have
      none) and at-large districts are 0 — pair `district` with `state`, since
      district numbers repeat across states.
    - `current_only` (default) restricts to members whose latest term ends in the
      future; set false to include past members (the term that matched a
      historical search may then differ from the latest term shown).

    `total_matches` is how many members match the filter overall (it can exceed
    the number returned — refine the filter or raise `limit`); `truncated` is
    true if the response-size guard trimmed the returned list.
    """
    try:
        term_facets: dict[str, Any] = {}
        if state is not None:
            term_facets["state"] = {"equalTo": normalize_state(state)}
        if party is not None:
            term_facets["party"] = {"equalTo": normalize_party(party)}
        if chamber is not None:
            term_facets["termType"] = {"equalTo": normalize_chamber_termtype(chamber)}
        if district is not None:
            term_facets["district"] = {"equalTo": district}
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

    connection = result["data"]["allLegislators"]
    shaped = [_shape(n) for n in connection["nodes"]]
    items, truncated = guard_items(shaped)
    return {
        "data": {
            "legislators": items,
            "total_matches": connection.get("totalCount"),
            "truncated": truncated,
        }
    }
