r"""Shared primitives of the protocol mirror: patterns, bounded scalars and the strict base model.

Every pattern here is the one zod emits in `packages/protocol/generated`, with `\d` written as
`[0-9]`. JavaScript's `\d` matches ASCII digits only, whereas Python's and Rust's also match other
Unicode digits, so the mirror spells the class out to reach the same verdict as the console.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

MAX_SAFE_INTEGER = 2**53 - 1
"""Largest integer a JavaScript number holds exactly; the upper bound of every sequence number."""

_DATE = (
    r"(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00"
    r"|[13579][26]00)-02-29"
    r"|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])"
    r"|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))"
)
_HMS = r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]"

UUIDV7_PATTERN = r"^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"
"""Lowercase only, as the TypeScript schema: identifiers are compared as strings."""
ISO_MS_PATTERN = rf"^{_DATE}T(?:{_HMS}\.[0-9]{{3}}(?:Z))$"
ISO_DATE_PATTERN = rf"^{_DATE}$"
ISO_OFFSET_PATTERN = rf"^{_DATE}T(?:{_HMS}(?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9]))$"

SchemaVersion = Annotated[str, Field(pattern=r"^1\.[0-9]+\.[0-9]+$")]
Uuidv7 = Annotated[str, Field(pattern=UUIDV7_PATTERN)]
IsoMs = Annotated[str, Field(pattern=ISO_MS_PATTERN)]
IsoDate = Annotated[str, Field(pattern=ISO_DATE_PATTERN)]
Sequence = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]

RobotId = Annotated[str, Field(pattern=r"^[a-z0-9-]{3,32}$")]
SiteId = Annotated[str, Field(pattern=r"^[a-z0-9-]{3,32}$")]
ThingName = Annotated[str, Field(pattern=r"^mfc-demo-[a-z0-9-]{3,32}$")]
LockToken = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{16,128}$")]
UserSub = Annotated[str, Field(pattern=r"^[A-Za-z0-9-]{1,128}$")]
CorrelationId = Annotated[str, Field(pattern=r"^[A-Za-z0-9-]{8,64}$")]
MissionId = Annotated[str, Field(pattern=r"^[a-z0-9-]{1,64}$")]

ReportedState = Literal[
    "IDLE",
    "WORKING",
    "MOVING",
    "CHARGING",
    "BLOCKED",
    "PAUSED",
    "TELEOP",
    "ESTOP",
]
"""States a robot may report. `OFFLINE` is never reported by the robot; the cloud sets it."""

FaultCode = Literal["OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS"]
"""Fault codes a robot can raise."""

Region = Literal["eu-west-3", "eu-west-1"]
"""Regions the demo deploys to."""


class ProtocolModel(BaseModel):
    """Base of every protocol model: strict, frozen, closed to unknown keys, camelCase on the wire.

    Strict mode refuses coercions (a boolean is not an integer, a string is not a number). Unknown
    keys are refused rather than ignored, as the zod `strictObject` schemas do. A `null` is refused
    for every key, because the protocol expresses an absent value by omitting the key.
    """

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        frozen=True,
        alias_generator=to_camel,
        populate_by_name=False,
    )

    @model_validator(mode="before")
    @classmethod
    def _reject_null(cls, data: object) -> object:
        """Refuses an explicit `null`, which zod's optional fields also refuse.

        Args:
            data: The raw input of the model.

        Returns:
            The input unchanged when it has no null value.

        Raises:
            ValueError: If any value is `None`.
        """
        if isinstance(data, Mapping) and any(value is None for value in data.values()):
            raise ValueError("null is not a value of the protocol")
        return data
