"""Tests for the get_voting_record tool."""

from __future__ import annotations

from tests.conftest import graphql_response, tool_payload


_DATA = {
    "s": {"nodes": [
        {"congress": 118, "category": "cloture", "position": "Yea", "positions": 100},
        {"congress": 118, "category": "cloture", "position": "Nay", "positions": 40},
        {"congress": 118, "category": "cloture", "position": "Not Voting", "positions": 10},
        {"congress": 118, "category": "passage", "position": "Yea", "positions": 50},
    ]},
    "a": {"nodes": [
        {"congress": 118, "chamber": "s", "memberParty": "D", "otherParty": "D",
         "agreementRate": 0.95},
        {"congress": 118, "chamber": "s", "memberParty": "D", "otherParty": "R",
         "agreementRate": 0.20},
    ]},
    "m": {"firstName": "Alex", "lastName": "Padilla"},
}


async def test_aggregates_per_congress_with_loyalty(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_DATA))

    result = await client.call_tool("get_voting_record", {"bioguide_id": "P000145"})

    data = tool_payload(result)["data"]
    assert data["name"] == "Alex Padilla"
    rec = data["records"][0]
    assert rec["congress"] == 118
    assert rec["chamber"] == "s"
    assert rec["totalVotes"] == 200           # 100+40+10+50
    assert rec["yea"] == 150
    assert rec["nay"] == 40
    assert rec["present"] == 0
    assert rec["notVoting"] == 10
    assert rec["other"] == 0
    # five buckets reconcile with totalVotes
    assert (rec["yea"] + rec["nay"] + rec["present"] + rec["notVoting"]
            + rec["other"]) == rec["totalVotes"]
    assert abs(rec["participationRate"] - 190 / 200) < 1e-9   # (total - notVoting) / total
    assert rec["partyLoyaltyRate"] == 0.95    # own-party row only
    assert result.is_error is False


_HOUSE_DATA = {
    "s": {"nodes": [
        {"congress": 118, "category": "passage", "position": "Aye", "positions": 30},
        {"congress": 118, "category": "amendment", "position": "No", "positions": 20},
        {"congress": 118, "category": "election-of-the-speaker", "position": "Jeffries",
         "positions": 1},
        {"congress": 118, "category": "passage", "position": "Not Voting", "positions": 4},
        {"congress": 117, "category": "conviction", "position": "Guilty", "positions": 1},
        {"congress": 117, "category": "conviction", "position": "Not Guilty", "positions": 1},
    ]},
    "a": {"nodes": [
        {"congress": 118, "chamber": "h", "memberParty": "D", "otherParty": "D",
         "agreementRate": 0.9},
    ]},
    "m": {"firstName": "Hakeem", "lastName": "Jeffries"},
}


async def test_buckets_by_meaning_house_impeachment_and_speaker(
    client, mock_graphql, govql_endpoint
):
    mock_graphql.post(govql_endpoint).mock(return_value=graphql_response(data=_HOUSE_DATA))

    result = await client.call_tool("get_voting_record", {"bioguide_id": "J000294"})

    payload = tool_payload(result)["data"]
    records = {r["congress"]: r for r in payload["records"]}

    # 118: House Aye->yea, No->nay, Speaker name (Jeffries)->other, Not Voting.
    r118 = records[118]
    assert r118["chamber"] == "h"
    assert r118["yea"] == 30          # Aye
    assert r118["nay"] == 20          # No
    assert r118["present"] == 0
    assert r118["notVoting"] == 4
    assert r118["other"] == 1         # Speaker-election vote for "Jeffries"
    assert r118["totalVotes"] == 55
    assert (r118["yea"] + r118["nay"] + r118["present"] + r118["notVoting"]
            + r118["other"]) == 55
    # `other` (Speaker) counts as participation; only Not Voting is excluded.
    assert abs(r118["participationRate"] - 51 / 55) < 1e-9
    assert r118["partyLoyaltyRate"] == 0.9

    # 117: impeachment Guilty->yea, Not Guilty->nay.
    r117 = records[117]
    assert r117["yea"] == 1           # Guilty
    assert r117["nay"] == 1           # Not Guilty
    assert r117["other"] == 0
    assert r117["totalVotes"] == 2
    assert abs(r117["participationRate"] - 1.0) < 1e-9
    # no own-party agreement row for 117 -> chamber/loyalty stay null
    assert r117["chamber"] is None
    assert r117["partyLoyaltyRate"] is None

    # records sorted by congress descending
    assert [r["congress"] for r in payload["records"]] == [118, 117]


async def test_no_records_returns_empty_list(client, mock_graphql, govql_endpoint):
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(
            data={"s": {"nodes": []}, "a": {"nodes": []},
                  "m": {"firstName": "No", "lastName": "One"}}
        )
    )

    result = await client.call_tool("get_voting_record", {"bioguide_id": "X"})

    assert tool_payload(result)["data"]["records"] == []
