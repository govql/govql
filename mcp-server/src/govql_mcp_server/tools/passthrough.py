"""The execute_graphql tool — raw passthrough to the GovQL GraphQL endpoint."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp


@mcp.tool
async def execute_graphql(
    query: Annotated[
        str,
        Field(description="A GraphQL query document. Must not be empty."),
    ],
    variables: Annotated[
        dict[str, Any] | None,
        Field(description="Optional GraphQL variables, as a JSON object."),
    ] = None,
) -> dict[str, Any]:
    """Execute a GraphQL query against the GovQL API and return the result.

    GovQL exposes US Congressional data — roll call votes (Congress 93 onward,
    every member's Yea/Nay/Present/Not Voting) and legislators (with terms,
    party, state, chamber) — via PostGraphile v5 at https://api.govql.us/graphql.
    Tables for bills, cosponsors, committees, and committee memberships exist
    in the schema but are not yet populated.

    Common values to know (saves you a wrong-guess round-trip):

    - `Vote.category` is a lowercase string. Frequent values: `"nomination"`,
      `"passage"`, `"cloture"`, `"amendment"`, `"procedural"`,
      `"veto-override"`, `"treaty"`. Use `equalTo` to filter.
    - `Vote.chamber` is `"s"` (Senate) or `"h"` (House).
    - `VotePosition.position` is one of `"Yea"`, `"Nay"`, `"Present"`,
      `"Not Voting"` (case-sensitive).
    - `VotePosition.state` is the two-letter USPS code (e.g. `"VT"`, `"CA"`).
    - `VotePosition.party` is `"D"`, `"R"`, or `"I"`.
    - **Legislator names are NOT a field on `VotePosition`.** Traverse the
      `legislatorByBioguideId` relation to reach `firstName`, `lastName`,
      `officialFull`, etc. There is no `name` or `memberName` field.

    Query conventions:

    - Connection fields (`allX`) support Relay pagination: `first: N,
      after: "<cursor>"`, with `pageInfo { endCursor hasNextPage }`. Many
      relations also have a flat `*List` variant (e.g.
      `votePositionsByVoteIdList`) that skips edges/nodes boilerplate.
    - Cross-table filtering uses the connection-filter plugin syntax:
      `filter: { field: { operator: value } }`, e.g.
      `votes(filter: { category: { equalTo: "nomination" } })`.
      Operators include equalTo, in, greaterThan, lessThan, contains, etc.
      Filters can traverse relations and apply to nested *List variants too
      (e.g. `votePositionsByVoteIdList(filter: { state: { equalTo: "VT" } })`).
    - Sorting uses generated enums: `orderBy: VOTED_AT_DESC` (pattern:
      `{FIELD}_ASC` or `{FIELD}_DESC`).
    - Hard limits enforced server-side: max query depth 10, max complexity
      ~10 billion points (paginated lists cost pageSize × childCost).

    Returns a dict with `data` (the GraphQL result), `errors` (if any —
    GraphQL errors are returned here as data, not as a tool failure, so you
    can iterate on the query), `last_ingest` (ISO timestamp of when the
    underlying data was last refreshed — votes refresh hourly, legislators
    daily), and `http_status`.

    Schema discovery: `introspect_schema` returns the full GraphQL schema,
    but the payload is very large (~250k characters as of v0.1) and may
    exceed the client's tool-result size limit. If that happens, write the
    schema to a file and grep/jq for the types you need; future versions of
    this server will provide narrower discovery tools.

    Examples:

    - Most recent nomination + how VT senators voted (one round-trip):
      `{ allVotes(filter: {category: {equalTo: "nomination"}},
         orderBy: VOTED_AT_DESC, first: 1) {
         nodes { question result resultText votedAt
           votePositionsByVoteIdList(filter: {state: {equalTo: "VT"}}) {
             position party
             legislatorByBioguideId { firstName lastName }
           } } } }`
    - First legislator: `{ allLegislators(first: 1) { nodes { bioguideId
         firstName lastName } } }`
    """
    if not query or not query.strip():
        return {
            "data": None,
            "errors": [{"message": "query must be a non-empty string"}],
            "last_ingest": None,
            "http_status": None,
        }

    try:
        return await graphql_client.execute_graphql(query, variables)
    except httpx.HTTPError as err:
        logger.warning("execute_graphql transport failure: %s", err)
        return {
            "data": None,
            "errors": [
                {
                    "message": (
                        f"Failed to reach GovQL endpoint: {type(err).__name__}: {err}"
                    )
                }
            ],
            "last_ingest": None,
            "http_status": None,
        }
