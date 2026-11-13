"""Builds a dev e-stop command for one robot, to publish by hand during the live checks.

The command is an ESTOP issued by a local operator. It needs no lock, which is what makes it the
emergency stop. It contains no kit material: only the identifiers that the kit's public
configuration already holds.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Final

from fleet_agent.core.ids import uuid7
from fleet_agent.protocol.commands import EstopCommand
from fleet_agent.protocol.constants import SCHEMA_VERSION
from fleet_agent.protocol.robots import RobotKitConfig
from fleet_agent.timefmt import format_iso_ms

LOCAL_OPERATOR: Final = "local-operator"
"""The issuer recorded on a locally built command. It is not a Cognito subject."""


def build_estop_command(
    config: RobotKitConfig,
    *,
    now_wall_ms: int,
    new_id: Callable[[], str] = uuid7,
) -> str:
    """Builds one ESTOP command for the robot, validated against the protocol before it is returned.

    Args:
        config: The public configuration of the robot, from its kit.
        now_wall_ms: The wall time the command is issued at, in milliseconds since the epoch.
        new_id: The source of the identifiers. Tests pin it.

    Returns:
        The command as one compact JSON line.

    Raises:
        pydantic.ValidationError: If the built command breaks the protocol. This is a bug, since the
            inputs are already validated, so it is not caught here.
    """
    issued = format_iso_ms(now_wall_ms)
    raw: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "messageId": new_id(),
        "robotId": config.robot_id,
        "siteId": config.site_id,
        "ts": issued,
        "commandId": new_id(),
        "issuedAt": issued,
        "issuedBy": LOCAL_OPERATOR,
        "correlationId": new_id(),
        "type": "ESTOP",
        "params": {},
    }
    command = EstopCommand.model_validate(raw)
    return command.model_dump_json(by_alias=True, exclude_none=True)
