"""Constants parity: every protocol constant of the Python mirror equals the generated
`constants.json`.

Tuples and read-only mappings are compared in their JSON form (lists and objects), because that
is what
the generator writes; a value that differs in content still fails.
"""

from __future__ import annotations

from collections.abc import Mapping

import fleet_agent.protocol.constants as constants

from .conftest import read_generated


def _as_json(value: object) -> object:
    """Renders a Python constant in the form the generator writes.

    Args:
        value: The constant as the mirror defines it.

    Returns:
        The same content as a list or a plain object.
    """
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, Mapping):
        return dict(value)
    return value


def test_the_mirror_defines_exactly_the_generated_constants() -> None:
    """No constant is missing on either side."""
    generated = read_generated("constants.json")
    assert isinstance(generated, dict)
    mirror = {name for name in dir(constants) if name.isupper()}
    assert mirror == set(generated)


def test_every_constant_equals_its_generated_value() -> None:
    """Each value is equal, including the nested rule names and the ordered command lists."""
    generated = read_generated("constants.json")
    assert isinstance(generated, dict)
    for name, value in generated.items():
        assert _as_json(getattr(constants, name)) == value, name
