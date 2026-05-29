"""Tests for the list_types tool."""

from __future__ import annotations

import httpx

from tests.conftest import graphql_response, tool_payload


_RESULT = {
    "__schema": {
        "types": [
            {"kind": "OBJECT", "name": "Query", "description": "Root query."},
            {"kind": "OBJECT", "name": "Vote", "description": "A roll-call vote."},
            {"kind": "INPUT_OBJECT", "name": "VoteFilter", "description": None},
            {"kind": "ENUM", "name": "VotesOrderBy", "description": None},
            {"kind": "SCALAR", "name": "String", "description": None},
        ]
    }
}


async def test_returns_all_types(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_RESULT))

    result = await client.call_tool("list_types", {})

    payload = tool_payload(result)
    names = [t["name"] for t in payload["data"]["types"]]
    assert names == ["Query", "Vote", "VoteFilter", "VotesOrderBy", "String"]
    assert result.is_error is False


async def test_filters_by_kind(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_RESULT))

    result = await client.call_tool("list_types", {"kind": "OBJECT"})

    payload = tool_payload(result)
    names = [t["name"] for t in payload["data"]["types"]]
    assert names == ["Query", "Vote"]


async def test_kind_filter_is_case_insensitive(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_RESULT))

    result = await client.call_tool("list_types", {"kind": "object"})

    payload = tool_payload(result)
    assert all(t["kind"] == "OBJECT" for t in payload["data"]["types"])


async def test_network_failure_returns_errors_payload(
    client, mock_graphql, govql_endpoint
):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("nope"))

    result = await client.call_tool("list_types", {})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False
