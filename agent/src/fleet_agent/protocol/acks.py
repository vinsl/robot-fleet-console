"""Acknowledgements, mirrored from `packages/protocol/src/acks.ts`.

Every command the robot did not drop silently gets one ack: `ACK`, or `REJECT` with a reason.
A reason on an `ACK` is a contradiction, so the two results are separate models.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from fleet_agent.protocol.envelope import RobotEnvelope
from fleet_agent.protocol.primitives import (
    CorrelationId,
    IsoMs,
    ReportedState,
    Uuidv7,
)

AckReason = Literal[
    "EXPIRED", "DUPLICATE", "INVALID_STATE", "NOT_LOCK_HOLDER", "INVALID", "NOT_SIMULATED"
]
"""Why a command was refused. Each value maps to one stage of the command pipeline."""


class _AckBase(RobotEnvelope):
    """Fields shared by both results of an acknowledgement."""

    command_id: Uuidv7
    correlation_id: CorrelationId
    robot_ts: IsoMs
    state: ReportedState


class AckAccepted(_AckBase):
    """The command was accepted (a no-op counts as accepted)."""

    result: Literal["ACK"]


class AckRejected(_AckBase):
    """The command was refused, with the reason."""

    result: Literal["REJECT"]
    reason: AckReason


Ack = Annotated[AckAccepted | AckRejected, Field(discriminator="result")]
"""Any acknowledgement, discriminated on `result`."""
