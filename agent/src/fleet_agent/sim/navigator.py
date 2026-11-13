"""The simulator's navigator: follows the route book between stops, and plans off the stops.

The core asks for the next waypoint on every tick, so the navigator keeps the route of the current
trip and an index into it. A trip that starts at a stop takes its route from the book. A trip that
starts elsewhere plans in a worker thread, and the robot holds position until the plan is ready.
A plan that is not ready within the timeout, or that finds no path, makes the destination
unreachable: the navigator then holds the robot for good, and says so once in the log.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from concurrent.futures import Executor, Future
from typing import Final

from fleet_agent.core.model import Destination, Point
from fleet_agent.core.ports import Waypoint
from fleet_agent.sim.astar import plan_path
from fleet_agent.sim.grid import OccupancyGrid
from fleet_agent.sim.routes import RouteBook

PLAN_TIMEOUT_S: Final = 3.0
"""How long an on-demand plan may take before its destination is given up, in seconds."""

_LOG: Final = logging.getLogger("fleet_agent.sim")


class GridNavigator:
    """Routes a robot around the walls of the map, one trip at a time.

    It implements `Navigator`. It is per robot: the trip state is not shared. The planner runs on
    the executor, and only the core's thread reads and writes the trip state.
    """

    def __init__(
        self,
        route_book: RouteBook,
        grid: OccupancyGrid,
        executor: Executor,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Creates a navigator with no trip under way.

        Args:
            route_book: The planned routes between the stops.
            grid: The inflated grid, which the on-demand plans search.
            executor: Runs the on-demand plans, off the core's thread.
            clock: The time source of the plan timeout, in seconds. Injected for the tests.
        """
        self._book = route_book
        self._grid = grid
        self._executor = executor
        self._clock = clock
        self._destination: Destination | None = None
        self._route: tuple[Point, ...] | None = None
        self._cursor = 0
        self._plan: Future[list[Point] | None] | None = None
        self._plan_started_s = 0.0
        self._unreachable = False

    def next_waypoint(self, x: float, y: float, destination: Destination) -> Waypoint | None:
        """Returns the next point of the trip, or None while the route is not known.

        A destination is the key of a trip: a new destination starts a new trip, and the same one
        keeps walking its route. The core clears the destination on arrival, so a later mission to
        the same station always starts from a different destination in between, or from the stop.

        Args:
            x: The robot's position on the x axis, in metres.
            y: The robot's position on the y axis, in metres.
            destination: The destination the robot is heading to.

        Returns:
            The next waypoint, with `final` set on the last point of the route, or None when the
            route is not known yet or the destination is unreachable.
        """
        if destination != self._destination:
            self._start_trip(x, y, destination)
        if self._unreachable:
            return None
        if self._route is None:
            self._collect_plan()
            if self._route is None:
                return None
        route = self._route
        if route is None or self._cursor >= len(route):
            return None
        return Waypoint(route[self._cursor], final=self._cursor == len(route) - 1)

    def reached(self, waypoint: Waypoint) -> None:
        """Advances along the route when the robot reaches an intermediate waypoint.

        Args:
            waypoint: The intermediate waypoint that was reached. Unused beyond the advance.
        """
        del waypoint
        self._cursor += 1

    def _start_trip(self, x: float, y: float, destination: Destination) -> None:
        """Begins a trip: from the book when the robot is at a stop, otherwise by planning.

        Args:
            x: The robot's position on the x axis, in metres.
            y: The robot's position on the y axis, in metres.
            destination: The new destination.
        """
        self._destination = destination
        self._route = None
        self._cursor = 0
        self._plan = None
        self._unreachable = False
        origin = self._book.stop_key_of(Point(x, y))
        target = self._book.stop_key_of(destination.point)
        if origin is not None and target is not None:
            if origin == target:
                self._route = (Point(x, y), destination.point)
            else:
                planned = self._book.route(origin, target)
                if planned is None:
                    self._mark_unreachable()
                else:
                    self._route = planned
            return
        self._plan = self._executor.submit(plan_path, self._grid, Point(x, y), destination.point)
        self._plan_started_s = self._clock()

    def _collect_plan(self) -> None:
        """Takes the result of the on-demand plan once it is ready, or gives up on it in time."""
        plan = self._plan
        if plan is None:
            return
        if plan.done():
            path = plan.result()
            self._plan = None
            if path is None:
                self._mark_unreachable()
            else:
                self._route = tuple(path)
            return
        if self._clock() - self._plan_started_s > PLAN_TIMEOUT_S:
            plan.cancel()
            self._plan = None
            self._mark_unreachable()

    def _mark_unreachable(self) -> None:
        """Holds the robot for the rest of this destination, and logs the fact once."""
        if not self._unreachable:
            self._unreachable = True
            _LOG.warning("sim.route_unreachable")
