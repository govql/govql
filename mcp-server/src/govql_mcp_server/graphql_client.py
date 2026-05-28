"""Thin httpx wrapper around the GovQL GraphQL endpoint.

The client is deliberately ignorant of MCP. The tool layer is responsible for
catching ``httpx.HTTPError`` and converting it to an MCP-shaped error response.
That separation keeps this module independently testable.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from . import __version__

DEFAULT_ENDPOINT = "https://api.govql.us/graphql"
DEFAULT_TIMEOUT_MS = 30_000


def _endpoint() -> str:
    return os.environ.get("GOVQL_ENDPOINT", DEFAULT_ENDPOINT)


def _timeout_seconds() -> float:
    return int(os.environ.get("GOVQL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)) / 1000


def _user_agent() -> str:
    return f"govql-mcp-server/{__version__}"


async def execute_graphql(
    query: str, variables: dict[str, Any] | None = None
) -> dict[str, Any]:
    """POST a GraphQL document to the configured endpoint.

    Returns a dict with keys:

    - ``data``: the GraphQL ``data`` payload (or ``None`` if errors-only)
    - ``errors``: the GraphQL ``errors`` array (omitted if absent)
    - ``last_ingest``: the ``X-Last-Ingest`` response header (or ``None``)
    - ``http_status``: the HTTP status code

    GraphQL-level errors are returned as data — only network/transport failures
    raise ``httpx.HTTPError``.
    """
    payload: dict[str, Any] = {"query": query}
    if variables is not None:
        payload["variables"] = variables

    async with httpx.AsyncClient(timeout=_timeout_seconds()) as client:
        response = await client.post(
            _endpoint(),
            json=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": _user_agent(),
            },
        )

    result: dict[str, Any] = {
        "http_status": response.status_code,
        "last_ingest": response.headers.get("x-last-ingest"),
    }

    # Try to parse the body as JSON. A non-2xx response from the GraphQL
    # server still carries useful information (e.g. rate-limit text), so we
    # surface the body as a string if it can't be parsed.
    try:
        body = response.json()
        result["data"] = body.get("data")
        if "errors" in body:
            result["errors"] = body["errors"]
    except ValueError:
        result["data"] = None
        result["errors"] = [
            {
                "message": (
                    f"Non-JSON response from upstream "
                    f"(HTTP {response.status_code}): {response.text[:500]}"
                )
            }
        ]

    return result
