"""Tests for the describe_type tool."""

from __future__ import annotations

import httpx

from tests.conftest import graphql_response, tool_payload

_DESCRIBE_VOTE_RESULT = {
    "__type": {
        "kind": "OBJECT",
        "name": "Vote",
        "description": "A roll-call vote.",
        "fields": [
            {
                "name": "voteId",
                "description": None,
                "args": [],
                "type": {"kind": "SCALAR", "name": "String", "ofType": None},
                "isDeprecated": False,
                "deprecationReason": None,
            }
        ],
        "inputFields": None,
        "interfaces": [],
        "enumValues": None,
        "possibleTypes": None,
    }
}


async def test_returns_full_type(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_DESCRIBE_VOTE_RESULT)
    )

    result = await client.call_tool("describe_type", {"name": "Vote"})

    payload = tool_payload(result)
    assert payload["data"]["type"]["name"] == "Vote"
    assert payload["data"]["type"]["fields"][0]["name"] == "voteId"
    assert result.is_error is False


async def test_forwards_name_as_variable(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_DESCRIBE_VOTE_RESULT)
    )

    await client.call_tool("describe_type", {"name": "Vote"})

    body = route.calls.last.request.read().decode()
    assert '"variables"' in body
    assert '"Vote"' in body


async def test_unknown_name_returns_null_type(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"__type": None})
    )

    result = await client.call_tool("describe_type", {"name": "NotAType"})

    payload = tool_payload(result)
    assert payload["data"]["type"] is None
    assert result.is_error is False


async def test_empty_name_rejected_without_network(
    client, mock_graphql, govql_endpoint
):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"should": "not_be_called"})
    )

    result = await client.call_tool("describe_type", {"name": "  "})

    payload = tool_payload(result)
    assert payload["errors"][0]["message"] == "name must be a non-empty string"
    assert route.called is False


async def test_network_failure_returns_errors_payload(
    client, mock_graphql, govql_endpoint
):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("down"))

    result = await client.call_tool("describe_type", {"name": "Vote"})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False
