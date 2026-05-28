"""The introspect_schema tool — fetches the GovQL GraphQL schema as
standard introspection JSON."""

from __future__ import annotations

from typing import Any

import httpx

from .. import graphql_client
from ..logger import logger
from ..server import mcp

# The canonical introspection query from the GraphQL spec, trimmed to what
# clients actually need: types, fields, args, input fields, enum values, and
# the directive list. Skips deprecation reasons and descriptions on directive
# args to keep the payload small.
_INTROSPECTION_QUERY = """
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives {
      name
      description
      locations
      args { ...InputValue }
    }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes { ...TypeRef }
}

fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
}
"""


@mcp.tool
async def introspect_schema() -> dict[str, Any]:
    """Return the GovQL GraphQL schema as standard introspection JSON.

    Call this once at the start of a session to learn what's queryable, then
    build queries against `execute_graphql`. The result is the standard
    GraphQL `__schema` payload — types, fields, args, enum values, and
    directives — wrapped in a `data` key, matching what a normal GraphQL
    introspection query would return.

    No caching: each call hits the upstream. Introspection is fast (tens of
    ms) and you typically only need it once per session.
    """
    try:
        result = await graphql_client.execute_graphql(_INTROSPECTION_QUERY)
    except httpx.HTTPError as err:
        logger.warning("introspect_schema transport failure: %s", err)
        return {
            "data": None,
            "errors": [
                {
                    "message": (
                        f"Failed to reach GovQL endpoint: {type(err).__name__}: {err}"
                    )
                }
            ],
        }

    # Strip last_ingest / http_status from introspection — they're noise here.
    return {k: v for k, v in result.items() if k in ("data", "errors")}
