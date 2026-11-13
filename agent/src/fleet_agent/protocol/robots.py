"""Robot registry and kit schemas, mirrored from `packages/protocol/src/robots.ts`.

The kit carries a private key and is returned once by the registration. The PEM patterns bound the
block, and the header and footer are checked independently, as the TypeScript schema does.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from fleet_agent.protocol.constants import THING_NAME_PREFIX
from fleet_agent.protocol.primitives import (
    CorrelationId,
    IsoDate,
    IsoMs,
    ProtocolModel,
    Region,
    RobotId,
    SiteId,
    ThingName,
)
from fleet_agent.protocol.problem import Problem

RobotStatus = Literal["PROVISIONING", "ACTIVE", "PROVISIONING_FAILED", "RETIRING", "RETIRED"]
"""Lifecycle of a registry entry."""

_ROBOT_NAME = r"^[A-Za-z0-9À-ÖØ-öø-ÿ ._-]{1,64}$"
"""Display name: ASCII letters and digits, the Latin-1 letters of French names, space, dot,
underscore, hyphen."""

_ROBOT_TYPE = r"^[A-Za-z0-9-]{1,32}$"
_ACTOR = r"^[A-Za-z0-9._+-]{1,64}$"
_IOT_ENDPOINT = r"^[a-z0-9]+-ats\.iot\.(?:eu-west-3|eu-west-1)\.amazonaws\.com$"
_CREDENTIALS_ENDPOINT = r"^[a-z0-9]+\.credentials\.iot\.(?:eu-west-3|eu-west-1)\.amazonaws\.com$"
KVS_CHANNEL_ARN_PATTERN = (
    r"^arn:aws:kinesisvideo:(?:eu-west-3|eu-west-1):[0-9]{12}"
    r"\:channel\/mfc-demo-[a-z0-9-]{3,32}\/[0-9]{1,20}$"
)
_PEM_MAX_LENGTH = 4096
_PEM_CERTIFICATE = r"^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n?$"
# Each full pair is an alternative, so the footer names the form of its header. The empty group
# inside
# each label matches the same text but keeps a contiguous key header out of the source and the JSON.
_PEM_PRIVATE_KEY = (
    r"^(?:-----BEGIN RSA PRIVATE(?:) KEY-----\n[A-Za-z0-9+/=\n]+\n-----END RSA PRIVATE(?:) KEY-----"
    r"|-----BEGIN PRIVATE(?:) KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE(?:) KEY-----)\n?$"
)


class RegisterRobotRequest(ProtocolModel):
    """Request to register a robot. The caller cannot set the status or any timestamp."""

    robot_id: RobotId
    site_id: SiteId
    name: Annotated[str, Field(pattern=_ROBOT_NAME)]
    type: Annotated[str, Field(pattern=_ROBOT_TYPE)]
    design_date: IsoDate
    simulated: bool


class RobotSummary(ProtocolModel):
    """Registry entry of a robot as returned by the API."""

    robot_id: RobotId
    site_id: SiteId
    name: Annotated[str, Field(pattern=_ROBOT_NAME)]
    type: Annotated[str, Field(pattern=_ROBOT_TYPE)]
    design_date: IsoDate
    simulated: bool
    status: RobotStatus
    created_at: IsoMs
    retired_at: IsoMs | None = None


def channel_name_of_arn(arn: str) -> str:
    """Returns the channel name of a KVS channel ARN.

    The ARN has the form `arn:aws:kinesisvideo:<region>:<acct>:channel/<name>/<id>`.

    The ARN has already matched its pattern, so the channel segment is present.

    Args:
        arn: A channel ARN that matched the channel pattern.

    Returns:
        The channel name.
    """
    return arn.split("/")[1]


def region_of_arn(arn: str) -> str:
    """Returns the region of a KVS channel ARN, its fourth colon-separated field.

    Args:
        arn: A channel ARN that matched the pattern.

    Returns:
        The region.
    """
    return arn.split(":")[3]


def iot_endpoint_region(endpoint: str) -> str:
    """Returns the region of an IoT data endpoint, `<id>-ats.iot.<region>.amazonaws.com`.

    Args:
        endpoint: An endpoint that matched its pattern.

    Returns:
        The region.
    """
    return endpoint.split(".")[2]


def credentials_endpoint_region(endpoint: str) -> str:
    """Returns the region of an IoT credentials endpoint.

    The endpoint has the form `<id>.credentials.iot.<region>.amazonaws.com`.

    Args:
        endpoint: An endpoint that matched its pattern.

    Returns:
        The region.
    """
    return endpoint.split(".")[3]


class RobotKitConfig(ProtocolModel):
    """Non-secret configuration a robot reads from its kit. It never contains a credential.

    Cross-field rules: the thing name is the robot's, the channel is the thing, the ARN names
    that channel,
    and every endpoint and the ARN are in the one region the kit declares. JSON Schema cannot
    state them,
    so the fixture parity test records that difference.
    """

    robot_id: RobotId
    site_id: SiteId
    thing_name: ThingName
    simulated: bool
    region: Region
    iot_endpoint: Annotated[str, Field(pattern=_IOT_ENDPOINT)]
    credentials_endpoint: Annotated[str, Field(pattern=_CREDENTIALS_ENDPOINT)]
    role_alias: Literal["mfc-demo-robot-kvs-master"]
    kvs_channel_name: ThingName
    kvs_channel_arn: Annotated[str, Field(pattern=KVS_CHANNEL_ARN_PATTERN)]

    @model_validator(mode="after")
    def _names_and_region_agree(self) -> Self:
        """Refuses a kit whose names or region disagree with each other.

        Returns:
            The validated configuration.

        Raises:
            ValueError: If a name or the region is inconsistent.
        """
        if self.thing_name != f"{THING_NAME_PREFIX}{self.robot_id}":
            raise ValueError("thing name must be the robot's")
        if self.kvs_channel_name != self.thing_name:
            raise ValueError("channel must be the thing")
        if channel_name_of_arn(self.kvs_channel_arn) != self.kvs_channel_name:
            raise ValueError("ARN must name the channel")
        region = self.region
        if (
            region_of_arn(self.kvs_channel_arn) != region
            or iot_endpoint_region(self.iot_endpoint) != region
            or credentials_endpoint_region(self.credentials_endpoint) != region
        ):
            raise ValueError("every endpoint must be in the region")
        return self


class RobotKit(ProtocolModel):
    """The kit delivered once by the registration. The private key is the only copy."""

    certificate_pem: Annotated[str, Field(max_length=_PEM_MAX_LENGTH, pattern=_PEM_CERTIFICATE)]
    private_key_pem: Annotated[str, Field(max_length=_PEM_MAX_LENGTH, pattern=_PEM_PRIVATE_KEY)]
    root_ca_pem: Annotated[str, Field(max_length=_PEM_MAX_LENGTH, pattern=_PEM_CERTIFICATE)]
    config: RobotKitConfig


class RegisterRobotResponse(ProtocolModel):
    """Result of a successful registration: the registry entry and the kit."""

    robot: RobotSummary
    kit: RobotKit


class RetireRobotRequest(ProtocolModel):
    """Request to retire a robot. Retirement is idempotent."""

    robot_id: RobotId
    site_id: SiteId


class RetireRobotResponse(ProtocolModel):
    """Result of a retirement. `already_retired` tells a repeated request from the first one."""

    robot: RobotSummary
    already_retired: bool


class _AdminInvokeBase(ProtocolModel):
    """Fields shared by every admin invocation event."""

    source: Literal["mfc.admin"]
    actor: Annotated[str, Field(pattern=_ACTOR)]
    correlation_id: CorrelationId | None = None


class RegisterInvokeEvent(_AdminInvokeBase):
    """Direct invocation that registers a robot."""

    action: Literal["robots.register"]
    body: RegisterRobotRequest


class RetireInvokeEvent(_AdminInvokeBase):
    """Direct invocation that retires a robot."""

    action: Literal["robots.retire"]
    body: RetireRobotRequest


AdminInvokeEvent = Annotated[
    RegisterInvokeEvent | RetireInvokeEvent,
    Field(discriminator="action"),
]
"""Any admin invocation, discriminated on `action`."""


class RegisterInvokeOk(ProtocolModel):
    """A registration that succeeded: the robot exists and the kit was issued."""

    ok: Literal[True]
    status: Literal[200, 201]
    body: RegisterRobotResponse


class RetireInvokeOk(ProtocolModel):
    """A retirement that succeeded, first time or repeated."""

    ok: Literal[True]
    status: Literal[200]
    body: RetireRobotResponse


class InvokeFailed(ProtocolModel):
    """A refused invocation, with its problem."""

    ok: Literal[False]
    status: Annotated[int, Field(ge=400, le=599)]
    problem: Problem


RegisterInvokeResult = Annotated[RegisterInvokeOk | InvokeFailed, Field(discriminator="ok")]
"""Result of a registration invocation, discriminated on `ok`."""

RetireInvokeResult = Annotated[RetireInvokeOk | InvokeFailed, Field(discriminator="ok")]
"""Result of a retirement invocation, discriminated on `ok`."""

AdminInvokeResult = RegisterInvokeResult | RetireInvokeResult
"""Result of any admin invocation: one of the two action results."""
