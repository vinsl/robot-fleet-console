"""Envelopes: the header fields of robot-to-cloud messages and of cloud-to-robot commands.

Mirrors `packages/protocol/src/envelope.ts`. Robot messages carry a sequence and a boot identifier;
commands do not, because the cloud is stateless per command and replay is checked on `commandId`.
"""

from __future__ import annotations

from fleet_agent.protocol.primitives import (
    IsoMs,
    ProtocolModel,
    RobotId,
    SchemaVersion,
    Sequence,
    SiteId,
    Uuidv7,
)


class RobotEnvelope(ProtocolModel):
    """Header of every robot-to-cloud message.

    It carries the version, the identity, the time and the sequencing within a boot.
    """

    schema_version: SchemaVersion
    message_id: Uuidv7
    robot_id: RobotId
    site_id: SiteId
    ts: IsoMs
    seq: Sequence
    boot_id: Uuidv7


class CloudEnvelope(ProtocolModel):
    """Header of every cloud-to-robot command: version, identity and time, with no sequence."""

    schema_version: SchemaVersion
    message_id: Uuidv7
    robot_id: RobotId
    site_id: SiteId
    ts: IsoMs
