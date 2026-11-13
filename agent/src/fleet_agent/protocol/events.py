"""Robot events, mirrored from `packages/protocol/src/events.ts`.

A discriminated union on `kind`: each event is flat, so the discriminator sits beside its fields.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from fleet_agent.protocol.envelope import RobotEnvelope
from fleet_agent.protocol.primitives import (
    FaultCode,
    ReportedState,
    UserSub,
    Uuidv7,
)
from fleet_agent.protocol.triggers import StateChangeCause

AgentVersion = Annotated[str, Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")]
"""Dotted version of the agent software, reported once per boot."""

LockChangeCause = Literal["ACQUIRED", "RELEASED", "EXPIRED", "TAKEOVER"]
"""Why the robot lock changed, as the robot observed it."""


class BootEvent(RobotEnvelope):
    """First event of a boot.

    It carries the software version, whether the robot is simulated, and its state.
    """

    kind: Literal["BOOT"]
    agent_version: AgentVersion
    simulated: bool
    state: ReportedState


class StateChangedEvent(RobotEnvelope):
    """A state change and the trigger that caused it.

    `command_id` is set only when a command caused the change.
    """

    kind: Literal["STATE_CHANGED"]
    from_state: ReportedState = Field(alias="from")
    to: ReportedState
    cause: StateChangeCause
    command_id: Uuidv7 | None = None


class HeartbeatEvent(RobotEnvelope):
    """Periodic proof of life.

    It is sent after a silence, so that a quiet robot is not taken for a dead one.
    """

    kind: Literal["HEARTBEAT"]
    state: ReportedState
    battery: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]


class FaultRaisedEvent(RobotEnvelope):
    """A fault appeared."""

    kind: Literal["FAULT_RAISED"]
    fault: FaultCode


class FaultClearedEvent(RobotEnvelope):
    """A fault went away."""

    kind: Literal["FAULT_CLEARED"]
    fault: FaultCode


class LockHeldEvent(RobotEnvelope):
    """The robot lock was acquired or taken over: it names its holder."""

    kind: Literal["LOCK_CHANGED"]
    held: Literal[True]
    holder: UserSub
    cause: LockChangeCause


class LockFreeEvent(RobotEnvelope):
    """The robot lock was released or expired: there is no holder to name."""

    kind: Literal["LOCK_CHANGED"]
    held: Literal[False]
    cause: LockChangeCause


LockChangedEvent = Annotated[LockHeldEvent | LockFreeEvent, Field(discriminator="held")]
"""A lock change, discriminated on `held`: a holder on a release, or none on an acquisition, is
refused."""


class GoingOfflineEvent(RobotEnvelope):
    """The robot's own announcement of a clean shutdown.

    The cloud, not the robot, sets `OFFLINE`.
    """

    kind: Literal["GOING_OFFLINE"]
    reason: Literal["SHUTDOWN"]


RobotEvent = Annotated[
    BootEvent
    | StateChangedEvent
    | HeartbeatEvent
    | FaultRaisedEvent
    | FaultClearedEvent
    | LockChangedEvent
    | GoingOfflineEvent,
    Field(discriminator="kind"),
]
"""Any event a robot publishes, discriminated on `kind`."""

__all__ = [
    "AgentVersion",
    "BootEvent",
    "FaultClearedEvent",
    "FaultRaisedEvent",
    "GoingOfflineEvent",
    "HeartbeatEvent",
    "LockChangeCause",
    "LockChangedEvent",
    "LockFreeEvent",
    "LockHeldEvent",
    "RobotEvent",
    "StateChangedEvent",
]
