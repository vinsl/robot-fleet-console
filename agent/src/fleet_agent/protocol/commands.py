"""Commands, mirrored from `packages/protocol/src/commands.ts`.

A command is discriminated on `type`, so a command with the parameters of another type is refused
as a
whole. The pipeline rules (age, replay, lock, state) are not here; they live in the agent core.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from fleet_agent.protocol.envelope import CloudEnvelope
from fleet_agent.protocol.primitives import (
    CorrelationId,
    FaultCode,
    IsoMs,
    LockToken,
    ProtocolModel,
    UserSub,
    Uuidv7,
)

CommandType = Literal[
    "PAUSE",
    "RESUME",
    "RETURN_TO_BASE",
    "ESTOP",
    "ESTOP_RELEASE",
    "TAKE_CONTROL",
    "RELEASE_CONTROL",
    "HEARTBEAT",
    "DRIVE",
    "SIMULATE_FAULT",
]
"""The ten command types of the protocol."""


class NoParams(ProtocolModel):
    """Parameters of commands that take none. Strict, so no value can be smuggled through."""


class DriveParams(ProtocolModel):
    """Joystick axes and the burst duration of a DRIVE command."""

    linear: Annotated[float, Field(ge=-1, le=1, allow_inf_nan=False)]
    angular: Annotated[float, Field(ge=-1.5, le=1.5, allow_inf_nan=False)]
    duration_ms: Annotated[int, Field(ge=50, le=500)]


class SimulateFaultParams(ProtocolModel):
    """The fault to inject on a simulated robot, and for how long."""

    fault: FaultCode
    duration_s: Annotated[int, Field(ge=1, le=300)] | None = None


class CommandBase(CloudEnvelope):
    """Fields shared by every command."""

    command_id: Uuidv7
    issued_at: IsoMs
    issued_by: UserSub
    correlation_id: CorrelationId
    lock_token: LockToken | None = None


class PauseCommand(CommandBase):
    """Stop motion and hold the mission."""

    type: Literal["PAUSE"]
    params: NoParams


class ResumeCommand(CommandBase):
    """Resume a paused or blocked robot."""

    type: Literal["RESUME"]
    params: NoParams


class ReturnToBaseCommand(CommandBase):
    """Send the robot to its charger."""

    type: Literal["RETURN_TO_BASE"]
    params: NoParams


class EstopCommand(CommandBase):
    """Emergency stop. Accepted without the lock and outside the age window."""

    type: Literal["ESTOP"]
    params: NoParams


class EstopReleaseCommand(CommandBase):
    """Clear an emergency stop. The robot resumes paused, never in motion."""

    type: Literal["ESTOP_RELEASE"]
    params: NoParams


class TakeControlCommand(CommandBase):
    """Take the robot lock.

    The lock token is required, because it is what the lock is granted to.
    """

    type: Literal["TAKE_CONTROL"]
    lock_token: LockToken
    params: NoParams


class ReleaseControlCommand(CommandBase):
    """Give the robot lock back."""

    type: Literal["RELEASE_CONTROL"]
    params: NoParams


class HeartbeatCommand(CommandBase):
    """Refresh the lock and the deadman. Never acknowledged."""

    type: Literal["HEARTBEAT"]
    params: NoParams


class DriveCommand(CommandBase):
    """Joystick drive burst. Not built by the robot; refused with `INVALID`."""

    type: Literal["DRIVE"]
    params: DriveParams


class SimulateFaultCommand(CommandBase):
    """Inject a fault into a simulated robot. Refused on a real one."""

    type: Literal["SIMULATE_FAULT"]
    params: SimulateFaultParams


Command = Annotated[
    PauseCommand
    | ResumeCommand
    | ReturnToBaseCommand
    | EstopCommand
    | EstopReleaseCommand
    | TakeControlCommand
    | ReleaseControlCommand
    | HeartbeatCommand
    | DriveCommand
    | SimulateFaultCommand,
    Field(discriminator="type"),
]
"""Any command, discriminated on `type`."""
