"""Agent-local constants: timings and limits of the robot core that are not protocol values.

Protocol values (deadman, lock expiry, replay memory, payload cap) live in
`fleet_agent.protocol.constants`, which is the single place the console and the robot share. The
values here only shape the robot's own behaviour, so the cloud never needs to know them.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final

from fleet_agent.protocol.primitives import FaultCode

TICK_INTERVAL_MS: Final = 50
"""Period of the core tick. It bounds how late the deadman and the timers can fire."""

MOTION_STALL_CAP_MS: Final = 200
"""Largest time step the motion model integrates. A VM pause must not teleport the robot."""

ARRIVAL_TOLERANCE_M: Final = 0.05
"""Distance to the target below which the robot counts as arrived."""

ACCEL_MPS2: Final = 0.8
"""Acceleration and braking of the motion model, in metres per second squared."""

MIN_CREEP_MPS: Final = 0.1
"""Slowest speed while closing on a target. The robot keeps creeping, so it never stalls short."""

BATTERY_DRAIN_MOVING_PER_S: Final = 0.02
"""Battery percentage lost per second while moving."""

BATTERY_DRAIN_IDLE_PER_S: Final = 0.005
"""Battery percentage lost per second while stationary and not charging."""

BATTERY_CHARGE_PER_S: Final = 0.5
"""Battery percentage gained per second while charging."""

FAULT_DEFAULT_DURATION_MS: Final[MappingProxyType[FaultCode, int]] = MappingProxyType(
    {
        "OBSTACLE": 20000,
        "SENSOR_FAULT": 20000,
        "LINK_LOSS": 10000,
        "BATTERY_LOW": 0,
    }
)
"""How long a simulated fault lasts when the command gives no duration. Read-only."""

MAX_PENDING_QOS1: Final = 100
"""Upper bound of QoS 1 publishes waiting for a PUBACK. Beyond it the event is dropped, not queued.

Dropping instead of queueing bounds the memory of a long disconnection; the next telemetry carries
the state anyway.
"""

PRIORITY_QOS1_HEADROOM: Final = 8
"""Extra QoS 1 slots that only priority messages may take: an e-stop's acknowledgement and its state
change. It is bounded, so a flood of e-stops on a dead link cannot grow the queue without limit, and
it is enough for several e-stops, each of which needs two slots.
"""

SUBSCRIBE_RETRY_BASE_S: Final = 1.0
"""Window of the first subscribe retry, in seconds."""

SUBSCRIBE_RETRY_CAP_S: Final = 30.0
"""Largest subscribe retry window, in seconds."""

DROP_LINK_ACK_GRACE_MS: Final = 1000
"""How long a DROP_LINK waits for the ACK's PUBACK before it suspends the link anyway."""

TELEMETRY_SUMMARY_INTERVAL_MS: Final = 10000
"""Period of the `telemetry.summary` log line, so that an operator sees progress without a flood."""

LOG_THROTTLE_INTERVAL_MS: Final = 1000
"""Minimum gap between two log lines with the same throttle key."""
