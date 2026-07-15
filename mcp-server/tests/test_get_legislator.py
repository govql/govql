"""Tests for the get_legislator tool."""

from __future__ import annotations

import json

import httpx

from tests.conftest import graphql_response, tool_payload

_RETIRED = {
    "legislatorByBioguideId": {
        "bioguideId": "R000001",
        "firstName": "Ret",
        "middleName": None,
        "lastName": "Ired",
        "nameSuffix": None,
        "nickname": None,
        "officialFull": "Ret Ired",
        "birthday": "1950-01-01",
        "gender": "M",
        "legislatorTermsByBioguideIdList": [
            {
                "termType": "sen",
                "party": "Democrat",
                "state": "CA",
                "district": None,
                "startDate": "1999-01-06",
                "endDate": "2001-01-03",
                "how": "election",
                "caucus": None,
            },
            {
                "termType": "sen",
                "party": "Democrat",
                "state": "CA",
                "district": None,
                "startDate": "2001-01-03",
                "endDate": "2003-01-03",
                "how": "election",
                "caucus": None,
            },
        ],
    }
}


def _last_variables(route) -> dict:
    return json.loads(route.calls.last.request.read().decode())["variables"]


_PADILLA = {
    "legislatorByBioguideId": {
        "bioguideId": "P000145",
        "firstName": "Alejandro",
        "middleName": None,
        "lastName": "Padilla",
        "nameSuffix": None,
        "nickname": "Alex",
        "officialFull": "Alex Padilla",
        "birthday": "1973-03-22",
        "gender": "M",
        "legislatorTermsByBioguideIdList": [
            {
                "termType": "sen",
                "party": "Democrat",
                "state": "CA",
                "district": None,
                "startDate": "2021-01-20",
                "endDate": "2023-01-03",
                "how": "appointment",
                "caucus": None,
            },
            {
                "termType": "sen",
                "party": "Democrat",
                "state": "CA",
                "district": None,
                "startDate": "2023-01-03",
                "endDate": "2029-01-03",
                "how": "election",
                "caucus": None,
            },
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
    assert leg["terms"][0]["chamber"] == "Senate"  # humanized from termType "sen"
    assert "termType" not in leg["terms"][0]  # raw code renamed to chamber
    assert leg["terms"][0]["party"] == "Democrat"  # other term fields preserved
    assert leg["terms"][0]["state"] == "CA"
    assert leg["current"]["party"] == "Democrat"  # from the future-ending term
    assert leg["current"]["chamber"] == "Senate"
    assert result.is_error is False


async def test_missing_legislator_returns_null(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"legislatorByBioguideId": None})
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "X999999"})

    payload = tool_payload(result)
    assert payload["data"]["legislator"] is None
    assert result.is_error is False
    assert "errors" not in payload


async def test_blank_id_rejected_without_network(client, mock_graphql, govql_endpoint):
    route = mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"legislatorByBioguideId": None})
    )

    result = await client.call_tool("get_legislator", {"bioguide_id": "  "})

    assert "non-empty" in tool_payload(result)["errors"][0]["message"]
    assert route.called is False


async def test_network_failure_returns_errors_payload(
    client, mock_graphql, govql_endpoint
):
    mock_graphql.post(govql_endpoint).mock(side_effect=httpx.ConnectError("down"))

    result = await client.call_tool("get_legislator", {"bioguide_id": "P000145"})

    payload = tool_payload(result)
    assert "Failed to reach GovQL endpoint" in payload["errors"][0]["message"]
    assert result.is_error is False


async def test_current_is_null_when_every_term_has_ended(
    client, mock_graphql, govql_endpoint
):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_RETIRED))

    result = await client.call_tool("get_legislator", {"bioguide_id": "R000001"})

    leg = tool_payload(result)["data"]["legislator"]
    assert len(leg["terms"]) == 2
    assert leg["current"] is None
