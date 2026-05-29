"""End-to-end tests for the execute_graphql tool via the in-memory client."""

from __future__ import annotations

import httpx

from tests.conftest import graphql_response, tool_payload


async def test_returns_data_through_mcp(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"allLegislators": {"nodes": [{"bioguideId": "A000360"}]}}
        )
    )

    result = await client.call_tool(
        "execute_graphql",
        {"query": "{ allLegislators(first: 1) { nodes { bioguideId } } }"},
    )

    payload = tool_payload(result)
    assert payload["data"]["allLegislators"]["nodes"][0]["bioguideId"] == "A000360"
    assert payload["last_ingest"] == "2026-05-28T08:35:00.000Z"
    assert result.is_error is False


async def test_graphql_errors_returned_as_data_not_tool_error(
    client, mock_graphql, govql_endpoint
):
    """A query with bad fields gets `errors` populated — but isError is False
    so the agent can read the error and fix the query."""
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            errors=[{"message": "Cannot query field 'notARealField'"}]
        )
    )

    result = await client.call_tool("execute_graphql", {"query": "{ notARealField }"})

    payload = tool_payload(result)
    assert payload["errors"][0]["message"] == "Cannot query field 'notARealField'"
    assert result.is_error is False  # GraphQL errors are data, not tool failures.


async def test_empty_query_rejected_without_network_call(
    client, mock_graphql, govql_endpoint
):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"should": "not_be_called"})
    )

    result = await client.call_tool("execute_graphql", {"query": "   "})

    payload = tool_payload(result)
    assert payload["errors"][0]["message"] == "query must be a non-empty string"
    assert route.called is False, "empty query must not hit the network"


async def test_network_failure_returns_errors_payload(
    client, mock_graphql, govql_endpoint
):
    """When the upstream is unreachable, the tool returns errors — it does not
    raise, and isError is False (errors are still data)."""
    mock_graphql.post(govql_endpoint).mock(
        side_effect=httpx.ConnectError("upstream down")
    )

    result = await client.call_tool("execute_graphql", {"query": "{ x }"})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert payload["data"] is None
    assert result.is_error is False


async def test_forwards_variables_through_mcp(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"result": 42})
    )

    await client.call_tool(
        "execute_graphql",
        {"query": "query($n: Int!) { result }", "variables": {"n": 7}},
    )

    body = route.calls.last.request.read().decode()
    assert '"variables"' in body
