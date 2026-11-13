"""Who the robot is: the identity the core reads from its kit and its configuration."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AgentIdentity:
    """Who this robot is, as read from its kit and its configuration.

    Attributes:
        robot_id: The robot identifier.
        site_id: The site the robot belongs to.
        thing_name: The IoT thing name, which is also the MQTT client identifier. Logged, never
            used by the core to talk to the broker.
        simulated: Whether the robot is a simulator, which alone accepts fault injection.
        agent_version: Dotted version of the agent software.
    """

    robot_id: str
    site_id: str
    thing_name: str
    simulated: bool
    agent_version: str
