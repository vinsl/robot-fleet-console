"""RFC 7807 problem details, mirrored from `packages/protocol/src/problem.ts`."""

from __future__ import annotations

from typing import Annotated

from pydantic import Field

from fleet_agent.protocol.primitives import CorrelationId, ProtocolModel


class Problem(ProtocolModel):
    """Error body of the API. It carries no stack trace and no internal identifier."""

    type: Annotated[str, Field(pattern=r"^urn:mfc:problem:[a-z-]+$")]
    title: Annotated[str, Field(min_length=1, max_length=120)]
    status: Annotated[int, Field(ge=400, le=599)]
    detail: Annotated[str, Field(max_length=500)] | None = None
    correlation_id: CorrelationId
