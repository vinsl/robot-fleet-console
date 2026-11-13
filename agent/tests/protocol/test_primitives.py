"""Strictness of the protocol base model: what strict mode refuses, and what the protocol allows."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from fleet_agent.protocol.telemetry import Telemetry

VALID: dict[str, object] = {
    "schemaVersion": "1.0.0",
    "messageId": "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
    "robotId": "kali-01",
    "siteId": "paris-01",
    "ts": "2026-11-01T10:00:00.000Z",
    "seq": 42,
    "bootId": "0190a7c4-0000-7000-8000-000000000001",
    "x": 0,
    "y": 0,
    "heading": 0,
    "state": "IDLE",
    "battery": 100,
    "speed": 0,
}


def test_an_integer_is_accepted_where_a_number_is_expected() -> None:
    """JSON has one number type; a whole number is a valid pose coordinate."""
    assert Telemetry.model_validate(VALID).x == 0


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("seq", True),
        ("seq", 1.5),
        ("x", None),
        ("missionId", None),
        ("unknownKey", 1),
    ],
    ids=["bool-for-int", "fraction-for-int", "null-pose", "null-optional", "unknown-key"],
)
def test_strict_mode_refuses_coercions_nulls_and_unknown_keys(key: str, value: object) -> None:
    """Each of these would be silently fixed by a lenient model; the protocol refuses them."""
    data = {**VALID, key: value}
    with pytest.raises(ValidationError):
        Telemetry.model_validate(data)


def test_a_sequence_beyond_the_safe_integer_range_is_refused() -> None:
    """Sequence numbers are bounded by the largest integer a JavaScript number holds exactly."""
    with pytest.raises(ValidationError):
        Telemetry.model_validate({**VALID, "seq": 2**53})


def test_an_uppercase_uuid_is_refused_because_identifiers_compare_as_strings() -> None:
    """Two spellings of one identifier would be two keys, so only lowercase is a protocol value."""
    with pytest.raises(ValidationError):
        Telemetry.model_validate({**VALID, "messageId": "0190A7C4-5B1E-7D2A-9C3F-4E5D6A7B8C9D"})


def test_the_rule_names_cannot_be_changed_at_run_time() -> None:
    """RULE_NAMES is read-only, so no caller can rename a rule the cloud relies on."""
    from fleet_agent.protocol.constants import RULE_NAMES

    with pytest.raises(TypeError):
        RULE_NAMES["telemetry"] = "other"  # type: ignore[index]
