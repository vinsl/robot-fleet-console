"""Topic parity: the Python grammar reads the shared vectors exactly as the TypeScript grammar does.
Topic parity: the Python grammar reads the shared vectors exactly as the TypeScript grammar does."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from fleet_agent.protocol.topics import (
    FleetTopic,
    ack_topic,
    command_topic,
    events_topic,
    parse_fleet_topic,
    rule_source_filter,
    telemetry_topic,
)

from .conftest import read_generated


def test_every_vector_parses_to_its_expected_identity() -> None:
    """Each generated vector gives the same identity, or the same refusal, as the TypeScript parser.
    Each generated vector gives the same identity, or the same refusal, as the TypeScript parser."""
    vectors = read_generated("topic-vectors.json")
    assert isinstance(vectors, list)
    assert vectors, "the vector file must not be empty"
    for vector in vectors:
        assert isinstance(vector, dict)
        expected = vector["expected"]
        parsed = parse_fleet_topic(str(vector["topic"]))
        if expected is None:
            assert parsed is None, vector["topic"]
        else:
            assert isinstance(expected, dict)
            assert parsed == FleetTopic(
                site_id=str(expected["siteId"]),
                robot_id=str(expected["robotId"]),
                channel=expected["channel"],
            ), vector["topic"]


def test_builders_round_trip_through_the_parser() -> None:
    """A topic built for a robot parses back to the same site, robot and channel."""
    assert parse_fleet_topic(telemetry_topic("paris-01", "kali-01")) == FleetTopic(
        "paris-01", "kali-01", "telemetry"
    )
    assert parse_fleet_topic(events_topic("paris-01", "kali-01")) == FleetTopic(
        "paris-01", "kali-01", "events"
    )
    assert parse_fleet_topic(ack_topic("paris-01", "kali-01")) == FleetTopic(
        "paris-01", "kali-01", "ack"
    )
    assert parse_fleet_topic(command_topic("paris-01", "kali-01")) == FleetTopic(
        "paris-01", "kali-01", "cmd"
    )


def test_rule_source_filters_match_the_generated_contract() -> None:
    """The three source filters are the ones the TypeScript side emits."""
    assert rule_source_filter("telemetry") == "fleet/+/+/telemetry"
    assert rule_source_filter("events") == "fleet/+/+/events"
    assert rule_source_filter("acks") == "fleet/+/+/cmd/ack"


@pytest.mark.parametrize(
    "builder",
    [telemetry_topic, events_topic, ack_topic, command_topic],
    ids=["telemetry", "events", "ack", "command"],
)
@pytest.mark.parametrize(
    ("site_id", "robot_id"),
    [("paris+01", "kali-01"), ("paris-01", "KALI-01"), ("paris-01", "ka"), ("paris-01", "kali/#")],
    ids=["wildcard-site", "uppercase-robot", "short-robot", "slash-robot"],
)
def test_a_builder_refuses_an_identifier_outside_the_grammar(
    builder: Callable[[str, str], str], site_id: str, robot_id: str
) -> None:
    """Every builder refuses an identifier outside the grammar, as the TypeScript builders do."""
    with pytest.raises(TypeError):
        builder(site_id, robot_id)
