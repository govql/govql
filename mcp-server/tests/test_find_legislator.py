"""End-to-end tests for the find_legislator tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    body = json.loads(route.calls.last.request.read().decode())
    return body["variables"]


_TWO_SENATORS = {
    "allLegislators": {
        "nodes": [
            {
                "bioguideId": "P000145", "firstName": "Alejandro",
                "lastName": "Padilla", "officialFull": "Alex Padilla",
                "legislatorTermsByBioguideIdList": [
                    {"party": "Democrat", "state": "CA", "termType": "sen",
                     "endDate": "2029-01-03"}
                ],
            },
            {
                "bioguideId": "S001150", "firstName": "Adam",
                "lastName": "Schiff", "officialFull": "Adam B. Schiff",
                "legislatorTermsByBioguideIdList": [
                    {"party": "Democrat", "state": "CA", "termType": "sen",
                     "endDate": "2031-01-03"}
                ],
            },
        ]
    }
}


async def test_builds_normalized_nested_term_filter(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_TWO_SENATORS)
    )

    result = await client.call_tool(
        "find_legislator",
        {"state": "ca", "party": "dem", "chamber": "senate"},
    )

    some = _last_variables(route)["filter"]["legislatorTermsByBioguideId"]["some"]
    assert some["state"]["equalTo"] == "CA"
    assert some["party"]["equalTo"] == "Democrat"   # full string, not "D"
    assert some["termType"]["equalTo"] == "sen"
    assert "greaterThan" in some["endDate"]          # current_only default
    payload = tool_payload(result)
    assert payload["data"]["result_count"] == 2
    first = payload["data"]["legislators"][0]
    assert first["bioguideId"] == "P000145"
    assert first["chamber"] == "Senate"
    assert first["party"] == "Democrat"
    assert first["current"] is True
    assert result.is_error is False


async def test_name_search_uses_or_clause(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allLegislators": {"nodes": []}})
    )

    await client.call_tool("find_legislator", {"name": "schiff", "current_only": False})

    filt = _last_variables(route)["filter"]
    or_fields = {list(c.keys())[0] for c in filt["or"]}
    assert or_fields == {"lastName", "firstName", "officialFull", "nickname"}
    assert "legislatorTermsByBioguideId" not in filt  # current_only False, no term facets


async def test_unknown_party_returns_error_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"allLegislators": {"nodes": []}})
    )

    result = await client.call_tool("find_legislator", {"party": "whigs"})

    payload = tool_payload(result)
    assert "Unrecognized party" in payload["errors"][0]["message"]
    assert route.called is False


async def test_network_failure_returns_errors_payload(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("down"))

    result = await client.call_tool("find_legislator", {"state": "VT"})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False
