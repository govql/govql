"""Unit tests for the HTTP client. Uses respx to mock httpx."""

from __future__ import annotations

import httpx
import pytest

from govql_mcp_server import graphql_client
from tests.conftest import graphql_response


async def test_returns_data_and_last_ingest(mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"hello": "world"})
    )

    result = await graphql_client.execute_graphql("{ hello }")

    assert result["data"] == {"hello": "world"}
    assert result["last_ingest"] == "2026-05-28T08:35:00.000Z"
    assert result["http_status"] == 200
    assert "errors" not in result


async def test_returns_errors_alongside_data(mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data=None,
            errors=[{"message": "Field 'nope' doesn't exist"}],
        )
    )

    result = await graphql_client.execute_graphql("{ nope }")

    assert result["data"] is None
    assert result["errors"][0]["message"] == "Field 'nope' doesn't exist"


async def test_forwards_variables(mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"x": 1})
    )

    await graphql_client.execute_graphql(
        "query ($a: Int!) { foo(a: $a) }", variables={"a": 7}
    )

    sent = route.calls.last.request
    body = sent.read().decode()
    assert '"variables"' in body
    assert '"a": 7' in body or '"a":7' in body


async def test_network_failure_raises_httpx_error(mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("nope"))

    with pytest.raises(httpx.HTTPError):
        await graphql_client.execute_graphql("{ hello }")


async def test_non_json_body_surfaces_as_errors(mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=httpx.Response(429, text="Too many requests")
    )

    result = await graphql_client.execute_graphql("{ hello }")

    assert result["http_status"] == 429
    assert result["data"] is None
    assert result["errors"][0]["message"].startswith("Non-JSON response")


async def test_endpoint_env_var(monkeypatch, mock_graphql):
    custom = "http://localhost:9999/graphql"
    monkeypatch.setenv("GOVQL_ENDPOINT", custom)
    mock_graphql.post(custom).mock(return_value=graphql_response(data={"ok": True}))

    result = await graphql_client.execute_graphql("{ ok }")

    assert result["data"] == {"ok": True}


async def test_user_agent_header(mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"ok": True})
    )

    await graphql_client.execute_graphql("{ ok }")

    ua = route.calls.last.request.headers["User-Agent"]
    assert ua.startswith("govql-mcp-server/")
