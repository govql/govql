"""The list_types tool — returns the names and kinds of every type in the
GovQL GraphQL schema."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._discovery_shared import network_error_response

_QUERY = """
{
  __schema {
    types { kind name description }
  }
}
"""


@mcp.tool
async def list_types(
    kind: Annotated[
        str | None,
        Field(
            description=(
                "Optional GraphQL type-kind filter, case-insensitive. "
                "Common values: 'OBJECT' (the queryable entities — Vote, "
                "Legislator, etc.), 'INPUT_OBJECT' (filter inputs like "
                "VoteFilter), 'ENUM' (orderBy enums). Omit to list every "
                "type in the schema."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """List the names and kinds of every type in the GovQL GraphQL schema.

    Call this first when you don't yet know what's queryable. The returned
    payload is small (a few KB) and gives you the type names you can then
    pass to `describe_type` for full details.

    Tip: most agents start with `list_types(kind="OBJECT")` to see just the
    queryable entities (Vote, Legislator, Bill, Committee, …), then call
    `describe_type("Query")` to see the available top-level query fields
    (such as `allVotes`, `allLegislators`, `voteByVoteId`).

    Returns `{"data": {"types": [{"kind": ..., "name": ..., "description": ...}, ...]}}`
    on success, or `{"data": null, "errors": [...]}` on network failure.
    """
    try:
        result = await graphql_client.execute_graphql(_QUERY)
    except httpx.HTTPError as err:
        logger.warning("list_types transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    types = result["data"]["__schema"]["types"]
    if kind is not None:
        wanted = kind.upper()
        types = [t for t in types if t["kind"] == wanted]

    return {"data": {"types": types}}
