"""Command parity: the lock lists partition the command types, and the types equal the schema's.

The command names are read from the generated `command.schema.json`, not from the Python literal,
so a
command added on the TypeScript side is visible here even before the mirror knows about it.
"""

from __future__ import annotations

from typing import get_args

from fleet_agent.protocol.commands import CommandType
from fleet_agent.protocol.constants import (
    LOCK_FREE_COMMANDS,
    LOCK_REQUIRED_COMMANDS,
    UNSUPPORTED_COMMANDS,
)

from .conftest import read_generated


def _schema_command_types() -> set[str]:
    """Reads the command types from the generated command schema.

    Returns:
        The `type` constant of each variant of the discriminated union.
    """
    schema = read_generated("command.schema.json")
    assert isinstance(schema, dict)
    variants = schema["oneOf"]
    assert isinstance(variants, list)
    names: set[str] = set()
    for variant in variants:
        assert isinstance(variant, dict)
        names.add(variant["properties"]["type"]["const"])
    return names


def test_the_lock_lists_partition_every_command_type() -> None:
    """Each command type is lock-required or lock-free, never both and never neither."""
    required = set(LOCK_REQUIRED_COMMANDS)
    free = set(LOCK_FREE_COMMANDS)
    assert required.isdisjoint(free)
    assert required | free == set(get_args(CommandType))


def test_the_command_types_equal_the_generated_schema() -> None:
    """The mirror names exactly the command types of the generated command schema."""
    assert set(get_args(CommandType)) == _schema_command_types()


def test_the_unsupported_commands_are_known_command_types() -> None:
    """Every unsupported command is a real command type."""
    assert set(UNSUPPORTED_COMMANDS) <= set(get_args(CommandType))
