"""The route book: every path between the charger and the workstations, planned once at start.

A robot that starts a trip from a stop takes its route from the book, so the planner does not run
on the simulator's hot path. A robot away from every stop plans on demand instead (see
`navigator.py`). The book is built once per run, from the stops of the map.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Final

from fleet_agent.core.model import Point
from fleet_agent.sim.astar import plan_path
from fleet_agent.sim.grid import OccupancyGrid

STOP_TOLERANCE_M: Final = 0.5
"""How close a robot must be to a stop to count as being at it, in metres."""


class RouteBook:
    """The planned routes between every ordered pair of stops, and the pairs with no route.

    Attributes:
        stops: The stops, by key, with their positions.
    """

    def __init__(
        self,
        stops: Mapping[str, Point],
        routes: Mapping[tuple[str, str], tuple[Point, ...]],
        unreachable: tuple[tuple[str, str], ...],
    ) -> None:
        """Creates the book from already planned routes. Use `build` to plan them.

        Args:
            stops: The stops, by key.
            routes: The planned route of each reachable ordered pair of stops.
            unreachable: The ordered pairs with no route.
        """
        self.stops: Mapping[str, Point] = dict(stops)
        self._routes: Mapping[tuple[str, str], tuple[Point, ...]] = dict(routes)
        self.unreachable: tuple[tuple[str, str], ...] = unreachable

    @classmethod
    def build(cls, grid: OccupancyGrid, stops: Mapping[str, Point]) -> RouteBook:
        """Plans every ordered pair of distinct stops. Blocking: run it in a worker thread.

        Args:
            grid: The inflated occupancy grid.
            stops: The stops, by key.

        Returns:
            The book, with every pair either planned or listed as unreachable.
        """
        routes: dict[tuple[str, str], tuple[Point, ...]] = {}
        unreachable: list[tuple[str, str]] = []
        for origin, origin_point in stops.items():
            for target, target_point in stops.items():
                if origin == target:
                    continue
                path = plan_path(grid, origin_point, target_point)
                if path is None:
                    unreachable.append((origin, target))
                else:
                    routes[(origin, target)] = tuple(path)
        return cls(stops, routes, tuple(unreachable))

    def route(self, origin: str, target: str) -> tuple[Point, ...] | None:
        """Returns the planned route between two stops.

        Args:
            origin: The key of the stop the trip starts from.
            target: The key of the stop the trip ends at.

        Returns:
            The waypoints, from the origin stop to the target stop, or None when the pair has no
            route or is not a pair of distinct stops of the book.
        """
        return self._routes.get((origin, target))

    def stop_key_of(self, point: Point, tolerance_m: float = STOP_TOLERANCE_M) -> str | None:
        """Returns the key of the stop nearest to a point, when it lies within the tolerance.

        Args:
            point: The point, in metres.
            tolerance_m: The largest distance counted as being at the stop, in metres.

        Returns:
            The key of the nearest stop within the tolerance, or None when there is none.
        """
        best_key: str | None = None
        best_distance = tolerance_m
        for key, stop in self.stops.items():
            distance = math.hypot(point.x - stop.x, point.y - stop.y)
            if distance <= best_distance:
                best_key, best_distance = key, distance
        return best_key
