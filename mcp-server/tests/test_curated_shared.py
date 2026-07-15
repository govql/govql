"""Unit tests for the shared curated-tool helpers."""

from __future__ import annotations

import json

import pytest

from govql_mcp_server.tools import _curated_shared as cs


def test_normalize_party_full_variants():
    assert cs.normalize_party("dem") == "Democrat"
    assert cs.normalize_party("D") == "Democrat"
    assert cs.normalize_party("republican") == "Republican"
    assert cs.normalize_party("I") == "Independent"
    assert cs.normalize_party(None) is None


def test_normalize_party_code_variants():
    assert cs.normalize_party_code("democrat") == "D"
    assert cs.normalize_party_code("R") == "R"
    assert cs.normalize_party_code(None) is None


def test_normalize_party_rejects_unknown():
    with pytest.raises(ValueError):
        cs.normalize_party("whigs")


def test_normalize_chamber():
    assert cs.normalize_chamber_termtype("senate") == "sen"
    assert cs.normalize_chamber_termtype("h") == "rep"
    assert cs.normalize_chamber_code("senate") == "s"
    assert cs.normalize_chamber_code("house") == "h"
    with pytest.raises(ValueError):
        cs.normalize_chamber_code("both")


def test_normalize_state():
    assert cs.normalize_state("ca") == "CA"
    assert cs.normalize_state(None) is None
    with pytest.raises(ValueError):
        cs.normalize_state("California")


def test_clamp_limit():
    assert cs.clamp_limit(None) == cs.LIMIT_DEFAULT
    assert cs.clamp_limit(0) == 1
    assert cs.clamp_limit(999) == cs.LIMIT_MAX
    assert cs.clamp_limit(50) == 50


def test_guard_items_under_budget_passes_through():
    items = [{"i": i} for i in range(10)]
    guarded, truncated = cs.guard_items(items)
    assert guarded == items
    assert truncated is False


def test_guard_items_truncates_oversized():
    items = [{"blob": "x" * 1000} for _ in range(500)]  # ~500 KB
    guarded, truncated = cs.guard_items(items)
    assert truncated is True
    assert 0 < len(guarded) < len(items)
    assert len(json.dumps(guarded)) <= cs.RESPONSE_BYTE_BUDGET


def test_today_iso_is_todays_date():
    from datetime import date

    assert cs.today_iso() == date.today().isoformat()
