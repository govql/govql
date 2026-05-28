"""Shared test fixtures: in-memory MCP client + httpx mocking via respx."""

from __future__ import annotations

import json
from typing import Any

import pytest
import respx
from fastmcp import Client

from govql_mcp_server.graphql_client import DEFAULT_ENDPOINT
from govql_mcp_server.server import mcp


@pytest.fixture
async def client():
    """In-memory FastMCP client — no subprocess, no transport overhead."""
    async with Client(mcp) as c:
        yield c


@pytest.fixture
def mock_graphql():
    """Mock the GovQL endpoint. Caller supplies status/json/headers per route.

    Usage:
        mock_graphql.post(...).respond(...)
    """
    with respx.mock(assert_all_called=False) as router:
        yield router


def tool_payload(result) -> dict[str, Any]:
    """Unwrap a FastMCP CallToolResult into the dict the tool returned.

    FastMCP serializes the tool's return value to a JSON text content block;
    we parse it back so tests can assert on structured data.
    """
    assert result.content, "tool returned no content"
    text = result.content[0].text
    return json.loads(text)


def graphql_response(
    data: Any = None,
    errors: list[dict[str, Any]] | None = None,
    last_ingest: str | None = "2026-05-28T08:35:00.000Z",
    status: int = 200,
):
    """Build a respx Response for the GovQL endpoint."""
    import httpx

    body: dict[str, Any] = {}
    if data is not None:
        body["data"] = data
    if errors is not None:
        body["errors"] = errors
    headers = {}
    if last_ingest is not None:
        headers["X-Last-Ingest"] = last_ingest
    return httpx.Response(status, json=body, headers=headers)


@pytest.fixture
def govql_endpoint() -> str:
    return DEFAULT_ENDPOINT
