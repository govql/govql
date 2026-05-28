"""Tests for the introspect_schema tool."""

from __future__ import annotations

import httpx

from tests.conftest import graphql_response, tool_payload


_SCHEMA_STUB = {
    "__schema": {
        "queryType": {"name": "Query"},
        "types": [{"kind": "OBJECT", "name": "Query", "fields": []}],
        "directives": [],
    }
}


async def test_returns_schema_under_data_key(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_SCHEMA_STUB))

    result = await client.call_tool("introspect_schema", {})

    payload = tool_payload(result)
    assert payload["data"] == _SCHEMA_STUB
    # last_ingest / http_status are stripped from introspection responses.
    assert "last_ingest" not in payload
    assert "http_status" not in payload
    assert result.is_error is False


async def test_sends_an_introspection_query(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_SCHEMA_STUB)
    )

    await client.call_tool("introspect_schema", {})

    body = route.calls.last.request.read().decode()
    assert "__schema" in body
    assert "IntrospectionQuery" in body


async def test_network_failure_returns_errors_payload(
    client, mock_graphql, govql_endpoint
):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("nope"))

    result = await client.call_tool("introspect_schema", {})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False
