"""Private helpers shared by the curated tools (find_/get_/compare_ ...).

Underscore prefix marks this as not-a-tool — server.py does not import it and
it registers no MCP handlers.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from ._discovery_shared import network_error_response  # re-exported

__all__ = [
    "normalize_party",
    "normalize_party_code",
    "normalize_chamber_termtype",
    "normalize_chamber_code",
    "normalize_state",
    "clamp_limit",
    "today_iso",
    "guard_items",
    "network_error_response",
    "LIMIT_DEFAULT",
    "LIMIT_MAX",
    "RESPONSE_BYTE_BUDGET",
]

LIMIT_DEFAULT = 20
LIMIT_MAX = 500
RESPONSE_BYTE_BUDGET = 100_000
_ENVELOPE_OVERHEAD = 2_000  # room for total_matches/truncated/keys around the list

_PARTY_FULL = {
    "d": "Democrat", "dem": "Democrat", "democrat": "Democrat", "democratic": "Democrat",
    "r": "Republican", "rep": "Republican", "republican": "Republican",
    "i": "Independent", "ind": "Independent", "independent": "Independent",
}
_PARTY_CODE = {
    "d": "D", "dem": "D", "democrat": "D", "democratic": "D",
    "r": "R", "rep": "R", "republican": "R",
    "i": "I", "ind": "I", "independent": "I",
}
_CHAMBER_TERMTYPE = {
    "s": "sen", "sen": "sen", "senate": "sen", "senator": "sen",
    "h": "rep", "house": "rep", "rep": "rep", "representative": "rep",
}
_CHAMBER_CODE = {
    "s": "s", "sen": "s", "senate": "s",
    "h": "h", "house": "h", "rep": "h",
}


def _lookup(value: str | None, table: dict[str, str], label: str) -> str | None:
    if value is None:
        return None
    key = value.strip().lower()
    if key not in table:
        raise ValueError(
            f"Unrecognized {label}: {value!r}. Expected one of "
            f"{sorted(set(table.values()))}."
        )
    return table[key]


def normalize_party(value: str | None) -> str | None:
    """Friendly party input -> full string ('Democrat'/'Republican'/'Independent')."""
    return _lookup(value, _PARTY_FULL, "party")


def normalize_party_code(value: str | None) -> str | None:
    """Friendly party input -> short code ('D'/'R'/'I')."""
    return _lookup(value, _PARTY_CODE, "party")


def normalize_chamber_termtype(value: str | None) -> str | None:
    """Friendly chamber input -> legislator_terms.term_type ('sen'/'rep')."""
    return _lookup(value, _CHAMBER_TERMTYPE, "chamber")


def normalize_chamber_code(value: str | None) -> str | None:
    """Friendly chamber input -> votes.chamber ('s'/'h')."""
    return _lookup(value, _CHAMBER_CODE, "chamber")


def normalize_state(value: str | None) -> str | None:
    """Two-letter USPS state code, upper-cased."""
    if value is None:
        return None
    v = value.strip().upper()
    if len(v) != 2 or not v.isalpha():
        raise ValueError(f"Unrecognized state: {value!r}. Expected a 2-letter code (e.g. 'CA').")
    return v


def clamp_limit(value: int | None) -> int:
    if value is None:
        return LIMIT_DEFAULT
    return max(1, min(LIMIT_MAX, int(value)))


def today_iso() -> str:
    return date.today().isoformat()


def guard_items(items: list[Any]) -> tuple[list[Any], bool]:
    """Return the largest prefix of `items` whose JSON stays within the byte
    budget, plus a truncated flag. Binary-searches the prefix length."""
    budget = RESPONSE_BYTE_BUDGET - _ENVELOPE_OVERHEAD
    if len(json.dumps(items)) <= budget:
        return items, False
    lo, hi = 0, len(items)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(json.dumps(items[:mid])) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return items[:lo], True
