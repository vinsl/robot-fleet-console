"""Identifiers of the simulated robots: one per kit, numbered from one, never more than twenty.

The count is bounded because each simulated robot keeps its own connection and its own kit, and the
demo fleet is sized for twenty. The identifiers follow the robot identifier grammar of the protocol,
so a registered simulated robot is an ordinary robot for the console.
"""

from __future__ import annotations

import re
from typing import Final

from fleet_agent.config.kit_file import is_robot_id

MAX_SIM_ROBOTS: Final = 20
"""Largest number of simulated robots in one run."""

_PREFIX_PATTERN: Final = re.compile(r"^[a-z0-9-]{3,32}$")


def sim_robot_ids(prefix: str, count: int) -> list[str]:
    """Lists the identifiers of the first `count` simulated robots: `<prefix>-01`, `<prefix>-02`...

    Args:
        prefix: The common prefix, three to thirty-two characters of lowercase letters, digits and
            hyphens, which keeps every identifier inside the protocol grammar.
        count: The number of robots, from 1 to `MAX_SIM_ROBOTS`.

    Returns:
        The identifiers, in order.

    Raises:
        ValueError: If the count or the prefix is out of range, or an identifier breaks the grammar.
    """
    if not 1 <= count <= MAX_SIM_ROBOTS:
        raise ValueError("the simulator runs from 1 to 20 robots")
    if _PREFIX_PATTERN.fullmatch(prefix) is None:
        raise ValueError("the prefix is not a robot identifier prefix")
    identifiers = [f"{prefix}-{index:02d}" for index in range(1, count + 1)]
    if not all(is_robot_id(identifier) for identifier in identifiers):
        raise ValueError("the identifiers break the robot identifier grammar")
    return identifiers
