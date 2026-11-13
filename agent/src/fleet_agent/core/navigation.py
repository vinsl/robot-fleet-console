"""The default navigator: the robot drives in a straight line to its destination.

A real robot keeps this navigator unless it is given a site map. It needs no map and no
planner, and it has no waypoint of its own: the destination is the only one, and it is final.
"""

from __future__ import annotations

from fleet_agent.core.model import Destination
from fleet_agent.core.ports import Waypoint


class StraightLineNavigator:
    """Drives straight at the destination, with no obstacle awareness.

    It implements `Navigator`. The destination is the only waypoint, so `reached` is never called.
    """

    def next_waypoint(self, x: float, y: float, destination: Destination) -> Waypoint | None:
        """Returns the destination itself as the final waypoint.

        Args:
            x: The robot's position on the x axis, in metres. Unused: the line is always open.
            y: The robot's position on the y axis, in metres. Unused: the line is always open.
            destination: The destination the robot is heading to.

        Returns:
            The destination as the final waypoint. Never None.
        """
        del x, y
        return Waypoint(destination.point, final=True)

    def reached(self, waypoint: Waypoint) -> None:
        """Does nothing: a straight line has no intermediate waypoint to report.

        Args:
            waypoint: The waypoint that was reached. Unused.
        """
        del waypoint
