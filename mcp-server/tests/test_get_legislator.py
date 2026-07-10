"""Tests for the get_legislator tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_PADILLA = {
    "legislatorByBioguideId": {
        "bioguideId": "P000145", "firstName": "Alejandro", "middleName": None,
        "lastName": "Padilla", "nameSuffix": None, "nickname": "Alex",
        "officialFull": "Alex Padilla", "birthday": "1973-03-22", "gender": "M",
        "legislatorTermsByBioguideIdList": [
            {"termType": "sen", "party": "Democrat", "state": "CA",
             "district": None, "startDate": "2021-01-20", "endDate": "2023-01-03",
             "how": "appointment", "caucus": None},
            {"termType": "sen", "party": "Democrat", "state": "CA",
             "district": None, "startDate": "2023-01-03", "endDate": "2029-01-03",
             "how": "election", "caucus": None},
        ],
    }
}


async def test_returns_identity_terms_and_current(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data=_PADILLA)
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "P000145"})

    assert _last_variables(route)["id"] == "P000145"
    leg = tool_payload(result)["data"]["legislator"]
    assert leg["bioguideId"] == "P000145"
    assert leg["nickname"] == "Alex"
    assert len(leg["terms"]) == 2
    assert leg["current"]["party"] == "Democrat"     # from the future-ending term
    assert leg["current"]["chamber"] == "Senate"
    assert result.is_error is False


async def test_missing_legislator_returns_null(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"legislatorByBioguideId": None})
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "X999999"})

    assert tool_payload(result)["data"]["legislator"] is None


async def test_blank_id_rejected_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"legislatorByBioguideId": None})
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "  "})

    assert "non-empty" in tool_payload(result)["errors"][0]["message"]
    assert route.called is False
