"""Tests for the compare_voters tool."""

from __future__ import annotations

import json

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_DATA = {
    "sims": {"nodes": [
        {"congress": 118, "chamber": "s", "sharedVotes": 200, "agreed": 180},
    ]},
    # ma is the alias looked up by bioguide_id_a (S001150 = Schiff); mb by
    # bioguide_id_b (P000145 = Padilla). Keep the names consistent with the
    # request order so memberA/memberB map to the *requested* a/b (asserted below).
    "ma": {"firstName": "Adam", "lastName": "Schiff"},
    "mb": {"firstName": "Alex", "lastName": "Padilla"},
}


async def test_canonicalizes_pair_and_computes_rate(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    # Pass them in non-canonical order; tool must sort to member_a < member_b.
    result = await client.call_tool(
        "compare_voters",
        {"bioguide_id_a": "S001150", "bioguide_id_b": "P000145"},
    )

    filt = _last_variables(route)["filter"]
    assert filt["memberA"]["equalTo"] == "P000145"   # min
    assert filt["memberB"]["equalTo"] == "S001150"   # max
    data = tool_payload(result)["data"]
    comp = data["comparisons"][0]
    assert comp["sharedVotes"] == 200
    assert abs(comp["agreementRate"] - 0.9) < 1e-9   # 180/200
    assert comp["chamber"] == "Senate"
    # Names map back to the *requested* a/b, not the canonical order.
    assert data["memberA"]["bioguideId"] == "S001150"
    assert data["memberA"]["name"] == "Adam Schiff"


async def test_no_overlap_returns_empty_with_message(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"sims": {"nodes": []}, "ma": {"firstName": "A", "lastName": "B"},
                  "mb": {"firstName": "C", "lastName": "D"}}
        )
    )

    result = await client.call_tool(
        "compare_voters", {"bioguide_id_a": "A000001", "bioguide_id_b": "B000002"}
    )

    data = tool_payload(result)["data"]
    assert data["comparisons"] == []
    assert "message" in data


async def test_blank_id_rejected_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))
    result = await client.call_tool(
        "compare_voters", {"bioguide_id_a": "P000145", "bioguide_id_b": "  "}
    )
    assert "non-empty" in tool_payload(result)["errors"][0]["message"]
    assert route.called is False
