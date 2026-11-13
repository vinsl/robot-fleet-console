"""Local video page API, mirrored from `packages/protocol/src/robot-video.ts`.

The page on the robot's loopback interface claims a one-time token, receives temporary
credentials for
the robot's own channel, and polls the robot status. These are the shapes it may receive.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from fleet_agent.protocol.constants import THING_NAME_PREFIX
from fleet_agent.protocol.primitives import (
    ISO_OFFSET_PATTERN,
    ProtocolModel,
    Region,
    ReportedState,
    RobotId,
    ThingName,
)
from fleet_agent.protocol.robots import (
    KVS_CHANNEL_ARN_PATTERN,
    channel_name_of_arn,
    region_of_arn,
)


class VideoClaimResponse(ProtocolModel):
    """Response to a one-time token claim: the session key the page keeps in memory."""

    session_key: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{43}$")]


class VideoCredentials(ProtocolModel):
    """Temporary credentials from the IoT credentials provider, valid for about an hour."""

    access_key_id: Annotated[str, Field(pattern=r"^ASIA[A-Z0-9]{16}$")]
    secret_access_key: Annotated[str, Field(pattern=r"^[A-Za-z0-9/+]{40}$")]
    session_token: Annotated[str, Field(pattern=r"^[A-Za-z0-9+/=]{16,8192}$")]
    expiration: Annotated[str, Field(pattern=ISO_OFFSET_PATTERN)]


class VideoSession(ProtocolModel):
    """Session returned to the page: the robot's channel and the credentials that reach it.

    Cross-field rules: the channel is the robot's own, the ARN names that channel, and the ARN is
    in the
    declared region. The page can therefore open only the channel of the robot it was given.
    """

    robot_id: RobotId
    region: Region
    channel_name: ThingName
    channel_arn: Annotated[str, Field(pattern=KVS_CHANNEL_ARN_PATTERN)]
    credentials: VideoCredentials

    @model_validator(mode="after")
    def _channel_belongs_to_the_robot(self) -> Self:
        """Refuses a session that names another robot's channel, or an ARN in another region.

        Returns:
            The validated session.

        Raises:
            ValueError: If the channel, the ARN or the region disagree.
        """
        if self.channel_name != f"{THING_NAME_PREFIX}{self.robot_id}":
            raise ValueError("channel must be the robot's")
        if channel_name_of_arn(self.channel_arn) != self.channel_name:
            raise ValueError("ARN must name the channel")
        if region_of_arn(self.channel_arn) != self.region:
            raise ValueError("ARN must be in the region")
        return self


class VideoStatus(ProtocolModel):
    """Status the page polls once per second.

    `connected` is False while the agent has no live link to the cloud. `simulated` marks a
    simulated robot; the page shows it as a badge and nothing else changes.
    """

    state: ReportedState
    banner: Literal["NONE", "ESTOP", "TELEOP"]
    lock_held: bool
    connected: bool
    simulated: bool
