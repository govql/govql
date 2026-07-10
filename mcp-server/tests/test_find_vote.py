"""End-to-end tests for the find_vote tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_ONE_VOTE = {
    "allVotes": {
        "totalCount": 1,
        "nodes": [
            {"voteId": "s100-118.2023", "chamber": "s", "congress": 118,
             "votedAt": "2023-05-10T00:00:00Z", "category": "cloture",
             "question": "On Cloture on the Motion re immigration",
             "result": "Rejected", "resultText": "Cloture Motion Rejected",
             "sourceUrl": "https://example.gov/s100"}
        ]
    }
}


async def test_builds_normalized_filter_and_shapes(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_ONE_VOTE)
    )

    result = await client.call_tool(
        "find_vote",
        {"topic": "immigration", "chamber": "senate", "congress": 118,
         "category": "cloture"},
    )

    filt = _last_variables(route)["filter"]
    assert filt["question"]["includesInsensitive"] == "immigration"
    assert filt["chamber"]["equalTo"] == "s"        # normalized
    assert filt["congress"]["equalTo"] == 118
    assert filt["category"]["equalTo"] == "cloture"
    payload = tool_payload(result)
    assert payload["data"]["total_matches"] == 1
    assert payload["data"]["votes"][0]["voteId"] == "s100-118.2023"
    assert payload["data"]["votes"][0]["chamber"] == "Senate"  # humanized
    assert result.is_error is False


async def test_no_filters_sends_null_filter(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allVotes": {"nodes": []}})
    )

    await client.call_tool("find_vote", {})

    assert _last_variables(route)["filter"] is None


async def test_unknown_chamber_returns_error_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allVotes": {"nodes": []}})
    )

    result = await client.call_tool("find_vote", {"chamber": "both"})

    payload = tool_payload(result)
    assert "Unrecognized chamber" in payload["errors"][0]["message"]
    assert route.called is False


async def test_network_failure_returns_errors_payload(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("down"))

    result = await client.call_tool("find_vote", {"topic": "budget"})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False


async def test_limit_is_clamped_to_max(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allVotes": {"nodes": []}})
    )

    await client.call_tool("find_vote", {"limit": 9999})

    assert _last_variables(route)["first"] == 500


async def test_oversized_response_is_truncated(client, mock_graphql, govql_endpoint):
    big_nodes = [
        {"voteId": f"s{i}-118.2023", "chamber": "s", "congress": 118,
         "votedAt": "2023-05-10T00:00:00Z", "category": "cloture",
         "question": "Q" * 1000, "result": "Agreed to",
         "resultText": "Agreed to", "sourceUrl": "https://example.gov"}
        for i in range(500)
    ]
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"allVotes": {"totalCount": 500, "nodes": big_nodes}}
        )
    )

    result = await client.call_tool("find_vote", {"topic": "budget"})

    data = tool_payload(result)["data"]
    assert data["truncated"] is True
    assert data["total_matches"] == 500
    assert 0 < len(data["votes"]) < data["total_matches"]
