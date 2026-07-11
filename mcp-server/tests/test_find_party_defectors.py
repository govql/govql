"""Tests for the find_party_defectors tool."""

from __future__ import annotations

import json

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_DATA = {"allMemberPartyAgreements": {"nodes": [
    {"bioguideId": "M000001", "memberParty": "D", "chamber": "s", "agreementRate": 0.55,
     "sharedVotes": 500, "agreed": 275,
     "legislatorByBioguideId": {"firstName": "Joe", "lastName": "Manchin"}},
]}}


async def test_all_parties_uses_or_of_own_party_clauses(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    result = await client.call_tool(
        "find_party_defectors", {"congress": 118, "chamber": "senate"}
    )

    filt = _last_variables(route)["filter"]
    assert filt["congress"]["equalTo"] == 118
    assert filt["chamber"]["equalTo"] == "s"
    clauses = {(c["memberParty"]["equalTo"], c["otherParty"]["equalTo"]) for c in filt["or"]}
    assert clauses == {("D", "D"), ("R", "R"), ("I", "I")}
    d = tool_payload(result)["data"]["defectors"][0]
    assert d["name"] == "Joe Manchin"
    assert d["memberParty"] == "D"
    assert d["chamber"] == "Senate"
    assert tool_payload(result)["data"]["chamber"] == "Senate"
    assert result.is_error is False


async def test_single_party_uses_direct_clause(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    await client.call_tool("find_party_defectors", {"congress": 118, "party": "dem"})

    filt = _last_variables(route)["filter"]
    assert filt["memberParty"]["equalTo"] == "D"
    assert filt["otherParty"]["equalTo"] == "D"
    assert "or" not in filt


async def test_unknown_party_errors_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    result = await client.call_tool(
        "find_party_defectors", {"congress": 118, "party": "whigs"}
    )

    assert "Unrecognized party" in tool_payload(result)["errors"][0]["message"]
    assert route.called is False


async def test_limit_is_clamped(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    await client.call_tool("find_party_defectors", {"congress": 118})
    assert _last_variables(route)["first"] == 20          # default

    await client.call_tool("find_party_defectors", {"congress": 118, "limit": 9999})
    assert _last_variables(route)["first"] == 500          # capped at LIMIT_MAX
