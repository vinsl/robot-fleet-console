r"""MQTT topic grammar, mirrored from `packages/protocol/src/topics.ts`.

Matching uses `fullmatch` on unanchored patterns. A `$` anchor would accept a trailing
newline, which the TypeScript grammar refuses, so the two sides would disagree on a topic that
ends with a line feed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from fleet_agent.protocol.constants import RULE_NAMES

FleetChannel = Literal["telemetry", "events", "cmd", "ack"]
"""Channel a fleet topic belongs to. `cmd` is cloud-to-robot, `ack` the robot's answer."""

_ID = re.compile(r"[a-z0-9-]{3,32}")
_FLEET = re.compile(
    r"(?:\$aws/rules/(mfc_demo_telemetry|mfc_demo_events|mfc_demo_acks)/)?"
    r"fleet/([a-z0-9-]{3,32})/([a-z0-9-]{3,32})/(telemetry|events|cmd/ack|cmd)"
)
_RULE_CHANNELS: dict[str, FleetChannel] = {
    RULE_NAMES["telemetry"]: "telemetry",
    RULE_NAMES["events"]: "events",
    RULE_NAMES["acks"]: "ack",
}
_SEGMENT_CHANNELS: dict[str, FleetChannel] = {
    "telemetry": "telemetry",
    "events": "events",
    "cmd/ack": "ack",
    "cmd": "cmd",
}


@dataclass(frozen=True, slots=True)
class FleetTopic:
    """Identity and channel extracted from a fleet topic."""

    site_id: str
    robot_id: str
    channel: FleetChannel


def _assert_ids(site_id: str, robot_id: str) -> None:
    """Refuses a builder call with an identifier outside the grammar.

    Args:
        site_id: The site identifier.
        robot_id: The robot identifier.

    Raises:
        TypeError: If either identifier is not valid.
    """
    if _ID.fullmatch(site_id) is None:
        raise TypeError("invalid site id")
    if _ID.fullmatch(robot_id) is None:
        raise TypeError("invalid robot id")


def telemetry_topic(site_id: str, robot_id: str) -> str:
    """Returns the topic a robot publishes its telemetry on, through the telemetry rule.

    Args:
        site_id: The site identifier.
        robot_id: The robot identifier.

    Returns:
        The rule topic.

    Raises:
        TypeError: If an identifier is not valid.
    """
    _assert_ids(site_id, robot_id)
    return f"$aws/rules/{RULE_NAMES['telemetry']}/fleet/{site_id}/{robot_id}/telemetry"


def events_topic(site_id: str, robot_id: str) -> str:
    """Returns the topic a robot publishes its events on, through the events rule.

    Args:
        site_id: The site identifier.
        robot_id: The robot identifier.

    Returns:
        The rule topic.

    Raises:
        TypeError: If an identifier is not valid.
    """
    _assert_ids(site_id, robot_id)
    return f"$aws/rules/{RULE_NAMES['events']}/fleet/{site_id}/{robot_id}/events"


def ack_topic(site_id: str, robot_id: str) -> str:
    """Returns the topic a robot publishes its acknowledgements on, through the acks rule.

    Args:
        site_id: The site identifier.
        robot_id: The robot identifier.

    Returns:
        The rule topic.

    Raises:
        TypeError: If an identifier is not valid.
    """
    _assert_ids(site_id, robot_id)
    return f"$aws/rules/{RULE_NAMES['acks']}/fleet/{site_id}/{robot_id}/cmd/ack"


def command_topic(site_id: str, robot_id: str) -> str:
    """Returns the topic the cloud publishes commands on for one robot.

    Args:
        site_id: The site identifier.
        robot_id: The robot identifier.

    Returns:
        The plain command topic.

    Raises:
        TypeError: If an identifier is not valid.
    """
    _assert_ids(site_id, robot_id)
    return f"fleet/{site_id}/{robot_id}/cmd"


def rule_source_filter(kind: Literal["telemetry", "events", "acks"]) -> str:
    """Returns the source filter of a rule's SQL statement.

    Args:
        kind: The stream the rule forwards.

    Returns:
        The MQTT topic filter used in the rule's `FROM` clause.
    """
    filters: dict[str, str] = {
        "telemetry": "fleet/+/+/telemetry",
        "events": "fleet/+/+/events",
        "acks": "fleet/+/+/cmd/ack",
    }
    return filters[kind]


def parse_fleet_topic(topic: str) -> FleetTopic | None:
    """Parses a topic received from the broker. The input is untrusted, so it never raises.

    A rule prefix must name a known rule and must match the channel it carries.

    Args:
        topic: The topic string as received.

    Returns:
        The identity and channel, or None if the topic is not a well-formed fleet topic.
    """
    match = _FLEET.fullmatch(topic)
    if match is None:
        return None
    rule, site_id, robot_id, segment = match.groups()
    channel = _SEGMENT_CHANNELS[segment]
    if rule is not None and _RULE_CHANNELS[rule] != channel:
        return None
    return FleetTopic(site_id=site_id, robot_id=robot_id, channel=channel)
