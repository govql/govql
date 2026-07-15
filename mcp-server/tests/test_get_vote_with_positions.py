"""Tests for the get_vote_with_positions tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload


def _last_body(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())


_VOTE = {
    "voteByVoteId": {
        "voteId": "s192-119.2026",
        "chamber": "s",
        "congress": 119,
        "votedAt": "2026-03-01T00:00:00Z",
        "question": "On the Motion",
        "category": "cloture",
        "result": "Rejected",
        "resultText": "Motion Rejected",
        "requires": "1/2",
        "sourceUrl": "https://example.gov/s192",
    },
    "t": {
        "nodes": [
            {"position": "Yea", "positions": 47},
            {"position": "Nay", "positions": 50},
            {"position": "Present", "positions": 1},
            {"position": "Not Voting", "positions": 2},
        ]
    },
    "b": {
        "nodes": [
            {"party": "D", "position": "Yea", "positions": 43},
            {"party": "R", "position": "Nay", "positions": 49},
            {"party": "I", "position": "Yea", "positions": 2},
        ]
    },
}


async def test_default_returns_tallies_no_positions(
    client, mock_graphql, govql_endpoint
):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_VOTE)
    )

    result = await client.call_tool(
        "get_vote_with_positions", {"vote_id": "s192-119.2026"}
    )

    # positions relation must NOT be selected when include_positions is false
    assert "votePositionsByVoteIdList" not in _last_body(route)["query"]
    data = tool_payload(result)["data"]
    assert data["vote"]["voteId"] == "s192-119.2026"
    assert data["vote"]["chamber"] == "Senate"  # humanized from "s"
    assert data["totals"] == {"Yea": 47, "Nay": 50, "Present": 1, "Not Voting": 2}
    assert data["party_breakdown"]["D"]["Yea"] == 43
    assert data["party_breakdown"]["R"]["Nay"] == 49
    assert data["positions"] is None


async def test_include_positions_selects_and_filters(
    client, mock_graphql, govql_endpoint
):
    with_positions = dict(_VOTE)
    with_positions["voteByVoteId"] = dict(_VOTE["voteByVoteId"])
    with_positions["voteByVoteId"]["votePositionsByVoteIdList"] = [
        {
            "position": "Nay",
            "party": "R",
            "state": "VT",
            "legislatorByBioguideId": {"firstName": "A", "lastName": "B"},
        },
    ]
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=with_positions)
    )

    result = await client.call_tool(
        "get_vote_with_positions",
        {"vote_id": "s192-119.2026", "state": "vt", "position": "Nay"},
    )

    body = _last_body(route)
    assert "votePositionsByVoteIdList" in body["query"]  # positions selected
    pos_filter = body["variables"]["posFilter"]
    assert pos_filter["state"]["equalTo"] == "VT"  # normalized
    assert pos_filter["position"]["equalTo"] == "Nay"
    data = tool_payload(result)["data"]
    assert data["positions"][0]["lastName"] == "B"


async def test_missing_vote_returns_null(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"voteByVoteId": None, "t": {"nodes": []}, "b": {"nodes": []}}
        )
    )

    result = await client.call_tool("get_vote_with_positions", {"vote_id": "nope"})

    assert tool_payload(result)["data"]["vote"] is None


async def test_network_failure_returns_errors_payload(
    client, mock_graphql, govql_endpoint
):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("down"))

    result = await client.call_tool(
        "get_vote_with_positions", {"vote_id": "s192-119.2026"}
    )

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False


async def test_party_filter_is_normalized_to_code(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_VOTE)
    )

    await client.call_tool(
        "get_vote_with_positions", {"vote_id": "s192-119.2026", "party": "d"}
    )

    pos_filter = _last_body(route)["variables"]["posFilter"]
    assert pos_filter["party"]["equalTo"] == "D"


async def test_position_filter_is_normalized(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_VOTE)
    )

    await client.call_tool(
        "get_vote_with_positions", {"vote_id": "s192-119.2026", "position": "nay"}
    )

    pos_filter = _last_body(route)["variables"]["posFilter"]
    assert pos_filter["position"]["equalTo"] == "Nay"


async def test_include_positions_defaults_to_full_roster(
    client, mock_graphql, govql_endpoint
):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_VOTE)
    )

    await client.call_tool(
        "get_vote_with_positions",
        {"vote_id": "s192-119.2026", "include_positions": True},
    )

    assert _last_body(route)["variables"]["posFirst"] == 500


async def test_explicit_positions_limit_still_honored(
    client, mock_graphql, govql_endpoint
):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_VOTE)
    )

    await client.call_tool(
        "get_vote_with_positions",
        {"vote_id": "s192-119.2026", "include_positions": True, "positions_limit": 5},
    )

    assert _last_body(route)["variables"]["posFirst"] == 5


async def test_blank_vote_id_rejected_without_network(
    client, mock_graphql, govql_endpoint
):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"voteByVoteId": None, "t": {"nodes": []}, "b": {"nodes": []}}
        )
    )

    result = await client.call_tool("get_vote_with_positions", {"vote_id": "  "})

    assert "non-empty" in tool_payload(result)["errors"][0]["message"]
    assert route.called is False
