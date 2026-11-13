"""Vocabulary of the state machine triggers, mirrored from `packages/protocol/src/state-machine.ts`.

Kept with the protocol because the event schema names a state change by its cause, and that name
must
be spelled the same way on both sides. The transition table itself lives in `fleet_agent.core`.
"""

from __future__ import annotations

from typing import Literal, get_args

CommandTrigger = Literal[
    "ESTOP",
    "ESTOP_RELEASE",
    "PAUSE",
    "RESUME",
    "RETURN_TO_BASE",
    "TAKE_CONTROL",
    "RELEASE_CONTROL",
    "HEARTBEAT",
    "SIMULATE_FAULT:OBSTACLE",
    "SIMULATE_FAULT:SENSOR_FAULT",
    "SIMULATE_FAULT:BATTERY_LOW",
    "SIMULATE_FAULT:LINK_LOSS",
]
"""Triggers raised by a command, or by the simulator's fault injection."""

InternalTrigger = Literal[
    "BOOT",
    "MISSION_ASSIGNED",
    "ARRIVED",
    "WORK_DONE",
    "CHARGED",
    "OBSTACLE_DETECTED",
    "SENSOR_FAULT",
    "CAUSE_CLEARED",
    "BATTERY_LOW",
    "DEADMAN_EXPIRED",
    "LOCK_EXPIRED",
]
"""Triggers raised by the robot itself."""

Trigger = CommandTrigger | InternalTrigger
"""Any trigger the robot can act on."""

StateChangeCause = Literal[
    "ESTOP",
    "ESTOP_RELEASE",
    "PAUSE",
    "RESUME",
    "RETURN_TO_BASE",
    "TAKE_CONTROL",
    "RELEASE_CONTROL",
    "HEARTBEAT",
    "SIMULATE_FAULT:OBSTACLE",
    "SIMULATE_FAULT:SENSOR_FAULT",
    "SIMULATE_FAULT:BATTERY_LOW",
    "SIMULATE_FAULT:LINK_LOSS",
    "MISSION_ASSIGNED",
    "ARRIVED",
    "WORK_DONE",
    "CHARGED",
    "OBSTACLE_DETECTED",
    "SENSOR_FAULT",
    "CAUSE_CLEARED",
    "BATTERY_LOW",
    "DEADMAN_EXPIRED",
    "LOCK_EXPIRED",
]
"""Causes a state change may carry. `BOOT` is absent: a boot is announced by the `BOOT` event."""

CloudTrigger = Literal["CLOUD_DISCONNECTED", "CLOUD_SILENCE_15S", "ROBOT_REPORTED"]
"""Triggers raised by the cloud. The robot never acts on them and never names one as a cause."""

CLOUD_TRIGGERS: tuple[str, ...] = get_args(CloudTrigger)
"""The cloud triggers as strings, for run-time checks of a value that came from outside the code."""


def command_triggers() -> frozenset[str]:
    """Returns the command triggers, for classifying a trigger without a table lookup.

    Returns:
        The set of every trigger a command can raise.
    """
    return frozenset(get_args(CommandTrigger))


def internal_triggers() -> frozenset[str]:
    """Returns the internal triggers.

    Returns:
        The set of every trigger the robot raises itself.
    """
    return frozenset(get_args(InternalTrigger))
