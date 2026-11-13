"""Verdict parity: every fixture gets the same verdict from pydantic and from the JSON Schema.

Each fixture is valid or invalid by its directory. Both implementations must agree with that label
and with each other. The one exception is a cross-field case (its file name carries
`cross-field-`): JSON Schema cannot state that two fields are equal, so only pydantic refuses it.
The test asserts that difference explicitly, so it is recorded instead of hidden.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter, ValidationError

from fleet_agent.protocol.acks import Ack
from fleet_agent.protocol.commands import Command
from fleet_agent.protocol.events import RobotEvent
from fleet_agent.protocol.problem import Problem
from fleet_agent.protocol.robot_video import VideoClaimResponse, VideoSession, VideoStatus
from fleet_agent.protocol.robots import (
    AdminInvokeEvent,
    AdminInvokeResult,
    RegisterRobotRequest,
    RegisterRobotResponse,
    RetireRobotRequest,
    RetireRobotResponse,
    RobotKitConfig,
    RobotSummary,
)
from fleet_agent.protocol.telemetry import IngestedTelemetry, Telemetry

from .conftest import FIXTURES_DIR, read_fixture, read_generated

CROSS_FIELD_MARK = "cross-field-"
"""File-name marker of a case that only pydantic can refuse (see the module docstring)."""

ADAPTERS: dict[str, TypeAdapter[object]] = {
    "ack": TypeAdapter(Ack),
    "admin-invoke-event": TypeAdapter(AdminInvokeEvent),
    "admin-invoke-result": TypeAdapter(AdminInvokeResult),
    "command": TypeAdapter(Command),
    "ingested-telemetry": TypeAdapter(IngestedTelemetry),
    "problem": TypeAdapter(Problem),
    "register-robot-request": TypeAdapter(RegisterRobotRequest),
    "register-robot-response": TypeAdapter(RegisterRobotResponse),
    "retire-robot-request": TypeAdapter(RetireRobotRequest),
    "retire-robot-response": TypeAdapter(RetireRobotResponse),
    "robot-event": TypeAdapter(RobotEvent),
    "robot-kit-config": TypeAdapter(RobotKitConfig),
    "robot-summary": TypeAdapter(RobotSummary),
    "telemetry": TypeAdapter(Telemetry),
    "video-claim-response": TypeAdapter(VideoClaimResponse),
    "video-session": TypeAdapter(VideoSession),
    "video-status": TypeAdapter(VideoStatus),
}
"""Pydantic model of each fixture directory, by name."""


def _cases() -> list[tuple[str, str, Path]]:
    """Lists every fixture as (schema name, kind, path), in a stable order.

    Returns:
        The cases of the corpus.
    """
    cases: list[tuple[str, str, Path]] = []
    for schema_dir in sorted(FIXTURES_DIR.iterdir()):
        for kind in ("valid", "invalid"):
            for path in sorted((schema_dir / kind).glob("*.json")):
                cases.append((schema_dir.name, kind, path))
    return cases


def test_every_fixture_directory_has_a_pydantic_model() -> None:
    """No schema of the corpus is left without a pydantic model to check it."""
    directories = {path.name for path in FIXTURES_DIR.iterdir()}
    assert directories == set(ADAPTERS)


@pytest.mark.parametrize(("schema_name", "kind", "path"), _cases(), ids=lambda value: str(value))
def test_fixture_verdict_matches_pydantic_jsonschema_and_label(
    schema_name: str, kind: str, path: Path
) -> None:
    """Pydantic and the JSON Schema both agree with the fixture's directory."""
    instance = read_fixture(path)
    expected = kind == "valid"

    try:
        ADAPTERS[schema_name].validate_python(instance)
        pydantic_verdict = True
    except ValidationError:
        pydantic_verdict = False

    schema = read_generated(f"{schema_name}.schema.json")
    validator = Draft202012Validator(schema)
    jsonschema_verdict = validator.is_valid(instance)

    if CROSS_FIELD_MARK in path.name:
        # Known limitation of JSON Schema 2020-12: equality between two fields is not expressible.
        assert kind == "invalid", "a cross-field case must be an invalid fixture"
        assert pydantic_verdict is False, "pydantic must refuse the cross-field case"
        assert jsonschema_verdict is True, "JSON Schema cannot refuse a cross-field case"
        return

    assert pydantic_verdict == jsonschema_verdict, "pydantic and JSON Schema disagree"
    assert pydantic_verdict == expected, "the verdict does not match the fixture directory"
