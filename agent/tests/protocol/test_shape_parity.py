"""Shape parity: the property names and the required names of each top-level model equal the
schema's.

A field renamed on one side only, or a field that became optional on one side only, is reported here
even when no fixture happens to exercise it. The meta test proves that the comparison can fail.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import BaseModel

from fleet_agent.protocol.problem import Problem
from fleet_agent.protocol.robot_video import VideoSession, VideoStatus
from fleet_agent.protocol.robots import (
    RegisterRobotRequest,
    RegisterRobotResponse,
    RetireRobotRequest,
    RetireRobotResponse,
    RobotKitConfig,
    RobotSummary,
)
from fleet_agent.protocol.telemetry import IngestedTelemetry, Telemetry

from .conftest import GENERATED_DIR, read_generated

TOP_LEVEL_MODELS: dict[str, type[BaseModel]] = {
    "telemetry": Telemetry,
    "ingested-telemetry": IngestedTelemetry,
    "problem": Problem,
    "register-robot-request": RegisterRobotRequest,
    "register-robot-response": RegisterRobotResponse,
    "retire-robot-request": RetireRobotRequest,
    "retire-robot-response": RetireRobotResponse,
    "robot-kit-config": RobotKitConfig,
    "robot-summary": RobotSummary,
    "video-session": VideoSession,
    "video-status": VideoStatus,
}
"""Object schemas compared field by field. Unions are covered by the fixture verdicts instead."""


def model_shape(model: type[BaseModel]) -> dict[str, bool]:
    """Maps each wire name of a model to whether it is required.

    Args:
        model: The pydantic model.

    Returns:
        A map from the camelCase wire name to its required flag.
    """
    return {field.alias or name: field.is_required() for name, field in model.model_fields.items()}


def schema_shape(schema: object) -> dict[str, bool]:
    """Maps each property of a JSON Schema object to whether it is required.

    Args:
        schema: The decoded JSON Schema of an object.

    Returns:
        A map from property name to its required flag.
    """
    assert isinstance(schema, dict)
    properties = schema["properties"]
    required = set(schema.get("required", []))
    assert isinstance(properties, dict)
    return {name: name in required for name in properties}


def shape_mismatches(model: type[BaseModel], schema: object) -> list[str]:
    """Lists every difference between a model's wire shape and its schema.

    Args:
        model: The pydantic model.
        schema: The decoded JSON Schema of the same object.

    Returns:
        Human-readable differences; empty when the shapes are equal.
    """
    expected = schema_shape(schema)
    actual = model_shape(model)
    problems: list[str] = []
    for name in sorted(set(expected) | set(actual)):
        if name not in actual:
            problems.append(f"{name}: in the schema, missing from the model")
        elif name not in expected:
            problems.append(f"{name}: in the model, missing from the schema")
        elif actual[name] != expected[name]:
            problems.append(f"{name}: required flag differs")
    return problems


@pytest.mark.parametrize(("schema_name", "model"), sorted(TOP_LEVEL_MODELS.items()))
def test_model_shape_equals_its_schema(schema_name: str, model: type[BaseModel]) -> None:
    """Property names and required flags of each object model equal the generated schema."""
    assert shape_mismatches(model, read_generated(f"{schema_name}.schema.json")) == []


def test_a_renamed_field_is_detected(tmp_path: Path) -> None:
    """Meta test: a schema whose field was renamed fails the shape comparison.

    The corpus of the repository is never edited: the renamed copy lives in a temporary directory
    and is
    read through the same function the parity test uses.
    """
    schema = read_generated("telemetry.schema.json")
    assert isinstance(schema, dict)
    properties = schema["properties"]
    required = schema["required"]
    assert isinstance(properties, dict)
    assert isinstance(required, list)
    properties["xPosition"] = properties.pop("x")
    required[required.index("x")] = "xPosition"
    copy = tmp_path / "telemetry.schema.json"
    copy.write_text(json.dumps(schema), encoding="utf-8")

    renamed = json.loads(copy.read_text(encoding="utf-8"))

    mismatches = shape_mismatches(Telemetry, renamed)
    assert "x: in the model, missing from the schema" in mismatches
    assert "xPosition: in the schema, missing from the model" in mismatches


def test_the_generated_directory_is_where_the_parity_tests_read() -> None:
    """The artifacts the tests read exist, so an empty comparison cannot pass by accident."""
    assert (GENERATED_DIR / "telemetry.schema.json").is_file()
