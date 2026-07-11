"""The get_legislator tool — identity + full term history for one member."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._curated_shared import display_chamber_termtype, network_error_response, today_iso

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


def _current(terms: list[dict[str, Any]]) -> dict[str, Any] | None:
    now = today_iso()
    for term in terms:
        end = term.get("endDate")
        if end and end > now:
            return {
                "party": term.get("party"),
                "state": term.get("state"),
                "chamber": display_chamber_termtype(term.get("termType")),
                "district": term.get("district"),
            }
    return None


def _term(term: dict[str, Any]) -> dict[str, Any]:
    """One term with its chamber humanized (termType 'sen'/'rep' -> Senate/House)."""
    return {
        "chamber": display_chamber_termtype(term.get("termType")),
        "party": term.get("party"),
        "state": term.get("state"),
        "district": term.get("district"),
        "startDate": term.get("startDate"),
        "endDate": term.get("endDate"),
        "how": term.get("how"),
        "caucus": term.get("caucus"),
    }


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
        "terms": [_term(t) for t in terms],
        "current": _current(terms),
    }
    return {"data": {"legislator": legislator}}
