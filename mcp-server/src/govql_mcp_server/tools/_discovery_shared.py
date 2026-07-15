"""Private helpers shared by the schema-discovery tools.

Underscore prefix marks this as not-a-tool — it's not imported by
``server.py`` and registers no MCP handlers.
"""

from __future__ import annotations

from typing import Any

import httpx

# Used by describe_type's introspection query.
TYPE_REF_FRAGMENT = """
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
        ofType {
          kind
          name
          ofType { kind name ofType { kind name ofType { kind name } } }
        }
      }
    }
  }
}
"""


def network_error_response(err: httpx.HTTPError) -> dict[str, Any]:
    """Build the standard ``{"data": None, "errors": [...]}`` payload for an
    upstream transport failure, matching the shape execute_graphql uses."""
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
