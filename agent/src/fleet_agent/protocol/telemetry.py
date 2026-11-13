"""Telemetry and the stored form of telemetry, mirrored from `packages/protocol/src/telemetry.ts`.

The bounds are the ones the console enforces, so an out-of-range pose is refused on both sides.
"""

from __future__ import annotations

import math
from typing import Annotated

from pydantic import Field

from fleet_agent.protocol.envelope import RobotEnvelope
from fleet_agent.protocol.primitives import (
    MAX_SAFE_INTEGER,
    FaultCode,
    MissionId,
    ReportedState,
    ThingName,
)


class Telemetry(RobotEnvelope):
    """Pose and status published by a robot on the telemetry topic."""

    x: Annotated[float, Field(ge=-1000, le=1000, allow_inf_nan=False)]
    y: Annotated[float, Field(ge=-1000, le=1000, allow_inf_nan=False)]
    heading: Annotated[float, Field(ge=-math.pi, le=math.pi, allow_inf_nan=False)]
    state: ReportedState
    battery: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
    speed: Annotated[float, Field(ge=0, le=5, allow_inf_nan=False)]
    mission_id: MissionId | None = None
    error_code: FaultCode | None = None


class IngestedTelemetry(Telemetry):
    """Telemetry as stored by the cloud.

    It is the robot's message plus the metadata the broker supplies.
    """

    iot_client_id: ThingName
    iot_topic: Annotated[str, Field(max_length=256)]
    iot_received_at: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
