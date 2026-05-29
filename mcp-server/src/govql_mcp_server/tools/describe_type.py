"""The describe_type tool — returns the full description of one GraphQL type."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from pydantic import Field

from .. import graphql_client
from ..logger import logger
from ..server import mcp
from ._discovery_shared import TYPE_REF_FRAGMENT, network_error_response

_QUERY = (
    """
query DescribeType($name: String!) {
  __type(name: $name) {
    kind
    name
    description
    fields(includeDeprecated: true) {
      name
      description
      args {
        name
        description
        defaultValue
        type { ...TypeRef }
      }
      type { ...TypeRef }
      isDeprecated
      deprecationReason
    }
    inputFields {
      name
      description
      defaultValue
      type { ...TypeRef }
    }
    interfaces { ...TypeRef }
    enumValues(includeDeprecated: true) {
      name
      description
      isDeprecated
      deprecationReason
    }
    possibleTypes { ...TypeRef }
  }
}
"""
    + TYPE_REF_FRAGMENT
)


@mcp.tool
async def describe_type(
    name: Annotated[
        str,
        Field(
            description=(
                "Exact, case-sensitive name of a GraphQL type. Get valid "
                "names from `list_types`. Examples: 'Vote', 'VotePosition', "
                "'Legislator', 'VoteFilter', 'VotesOrderBy', 'Query'."
            )
        ),
    ],
) -> dict[str, Any]:
    """Return the full description of one GraphQL type.

    Returns the type's `kind`, `description`, `fields` (with arg
    signatures), `inputFields` (for INPUT_OBJECT types), `enumValues`
    (for ENUM types), `interfaces`, and `possibleTypes` — everything you
    need to write a query against this type.

    For OBJECT types, `fields[].args` tells you what filters/pagination
    each field accepts. For INPUT_OBJECT types, `inputFields` is the list
    of accepted properties (e.g. `VoteFilter` has `category`, `chamber`,
    etc.). For ENUM types, `enumValues` lists the valid choices.

    Returns `{"data": {"type": {...}}}` on success. If the name doesn't
    match any type, `data.type` is `null`. On network failure,
    `{"data": null, "errors": [...]}`.
    """
    if not name or not name.strip():
        return {
            "data": None,
            "errors": [{"message": "name must be a non-empty string"}],
        }

    try:
        result = await graphql_client.execute_graphql(_QUERY, variables={"name": name})
    except httpx.HTTPError as err:
        logger.warning("describe_type transport failure: %s", err)
        return network_error_response(err)

    if result.get("errors"):
        return {"data": None, "errors": result["errors"]}

    return {"data": {"type": result["data"]["__type"]}}
