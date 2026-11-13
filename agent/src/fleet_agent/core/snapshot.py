"""The read-only view of the core that the local video page and the tests read, and its banner.

The banner is what the operator console shows across the top of the video and the map. It is a
function of the reported state only, so the snapshot and the console cannot disagree about it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from fleet_agent.protocol.primitives import ReportedState

Banner = Literal["NONE", "ESTOP", "TELEOP"]
"""What the operator console shows across the top of the video and the map."""


@dataclass(frozen=True, slots=True)
class AgentSnapshot:
    """A read-only view of the core for the local video page and the tests.

    Attributes:
        state: The reported state.
        banner: The banner the console shows for this state.
        lock_held: Whether an operator holds the lock.
        connected: Whether the link to the broker is up.
        simulated: Whether the robot is a simulator.
        boot_id: The identifier of this boot.
        latch_persisted: False only while the last latch write failed and no later latch write
            succeeded. The robot is then stopped in memory, but a reboot could forget it.
        mission_id: The mission in progress, or None. The simulator's mission driver reads it to
            know when a mission has ended, whatever ended it: completion, abort, e-stop.
    """

    state: ReportedState
    banner: Banner
    lock_held: bool
    connected: bool
    simulated: bool
    boot_id: str
    latch_persisted: bool
    mission_id: str | None


def banner_of(state: ReportedState) -> Banner:
    """Chooses the banner the console shows for a state.

    Args:
        state: The reported state.

    Returns:
        `ESTOP` or `TELEOP` for those two states, `NONE` for every other.
    """
    if state == "ESTOP":
        return "ESTOP"
    if state == "TELEOP":
        return "TELEOP"
    return "NONE"
