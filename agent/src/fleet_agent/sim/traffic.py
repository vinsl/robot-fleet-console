"""Yield between simulated robots: a robot waits when another robot is directly in its way.

The simulator's robots run the production core unchanged. When a navigator gives no waypoint, the
core holds the robot in place at zero speed and it stays MOVING. Avoidance therefore lives in the
simulator's navigator, not in a robot state: a blocked robot must not raise an obstacle alert,
which would need a manual resume and count against the error-rate and availability KPIs.

The fleet runs every robot on one asyncio loop, so the board takes no lock. It must not be shared
with another thread. Its decisions depend only on the positions, the headings and the injected
clock, never on a random draw, so the same run gives the same decisions.
"""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from fleet_agent.core.model import Destination, Point
from fleet_agent.core.ports import Navigator, Waypoint

SAFETY_GAP_M: Final = 1.0
"""The distance two robots must keep apart, in metres. Closer than this, one of them yields."""

CONE_HALF_ANGLE_RAD: Final = math.radians(60.0)
"""Half the angle of the cone a robot looks into, around its heading, in radians."""

HEAD_ON_RAD: Final = math.radians(150.0)
"""From this angle between two headings on, the two robots are head-on and neither gets priority."""

STALE_MS: Final = 500
"""How old a position may be, in milliseconds, before its robot counts as stationary."""

WAIT_TIMEOUT_MS: Final = 6000
"""How long a robot waits for another before it passes, in milliseconds. It breaks deadlocks."""

PASS_MS: Final = 3000
"""How long a robot that passed a deadlock keeps moving, in milliseconds."""

_COS_CONE: Final = math.cos(CONE_HALF_ANGLE_RAD)
_COS_HEAD_ON: Final = math.cos(HEAD_ON_RAD)

_LOG: Final = logging.getLogger("fleet_agent.sim")


def _monotonic_ms() -> int:
    """Reads the monotonic clock, in whole milliseconds.

    Returns:
        The current monotonic time, in milliseconds.
    """
    return time.monotonic_ns() // 1_000_000


@dataclass(slots=True)
class _Entry:
    """What the board knows about one robot.

    Attributes:
        x: The last reported position on the x axis, in metres.
        y: The last reported position on the y axis, in metres.
        hx: The x component of the unit heading to the current waypoint; zero when unknown.
        hy: The y component of the unit heading to the current waypoint; zero when unknown.
        seen_ms: When the position was last reported, in milliseconds.
        waiting_since_ms: When the robot began to wait, or None when it does not wait.
        pass_until_ms: Until when the robot moves through after a deadlock pass, or None.
    """

    x: float
    y: float
    hx: float
    hy: float
    seen_ms: int
    waiting_since_ms: int | None
    pass_until_ms: int | None


class TrafficBoard:
    """Tracks where every simulated robot is, and decides which one may drive on.

    A robot asks `may_advance` before each step. It may drive when no other robot is within
    SAFETY_GAP_M of it, in the cone ahead of it, outside the parking area and not a shared dock.
    When two robots face each other, or a robot is stopped in its way, both would wait for ever;
    so a robot that has waited WAIT_TIMEOUT_MS passes for PASS_MS, and the others wait for it.
    """

    def __init__(
        self,
        *,
        parking_centre: Point,
        parking_radius_m: float,
        clock_ms: Callable[[], int] = _monotonic_ms,
    ) -> None:
        """Creates an empty board.

        Args:
            parking_centre: The charger, where robots that have not started yet, or are parked,
                do not hold up the others.
            parking_radius_m: The radius of the parking area around the charger, in metres.
            clock_ms: The time source, in milliseconds. Injected for the tests.
        """
        self._centre = parking_centre
        self._radius = parking_radius_m
        self._clock_ms = clock_ms
        self._entries: dict[str, _Entry] = {}

    def place(self, robot_id: str, point: Point) -> None:
        """Registers a robot at its start position, before it drives.

        Args:
            robot_id: The robot to register. It must not be on the board already.
            point: Where the robot starts, in metres.

        Raises:
            ValueError: If the robot is already on the board.
        """
        if robot_id in self._entries:
            raise ValueError("the robot is already on the traffic board")
        self._entries[robot_id] = _Entry(
            x=point.x,
            y=point.y,
            hx=0.0,
            hy=0.0,
            seen_ms=self._clock_ms(),
            waiting_since_ms=None,
            pass_until_ms=None,
        )

    def remove(self, robot_id: str) -> None:
        """Takes a robot off the board when its run ends. A robot not on the board is a no-op.

        Args:
            robot_id: The robot to take off the board.
        """
        self._entries.pop(robot_id, None)

    def report(self, robot_id: str, x: float, y: float) -> None:
        """Records the position of a robot that is not driving towards a waypoint.

        The navigator calls it when it has no waypoint, so the other robots still see the robot
        at its real position, and as fresh: it is held, not stopped for good.

        Args:
            robot_id: The robot whose position is reported.
            x: The robot's position on the x axis, in metres.
            y: The robot's position on the y axis, in metres.

        Raises:
            ValueError: If the robot is not on the board.
        """
        entry = self._entry(robot_id)
        entry.x = x
        entry.y = y
        entry.seen_ms = self._clock_ms()
        # A robot that is held by something other than traffic is not waiting for another robot.
        entry.waiting_since_ms = None

    def is_waiting(self, robot_id: str) -> bool:
        """Tells whether a robot is waiting for another one to clear its way.

        Args:
            robot_id: The robot to look up.

        Returns:
            True while the robot waits, False when it may drive or passes.

        Raises:
            ValueError: If the robot is not on the board.
        """
        return self._entry(robot_id).waiting_since_ms is not None

    def may_advance(
        self,
        robot_id: str,
        x: float,
        y: float,
        target: Point,
        destination: Point,
    ) -> bool:
        """Decides whether a robot may drive towards its next waypoint now.

        The robot's own position and heading are updated first, so the others see where it is
        heading. The other robots are visited in identifier order, so the decision is the same on
        every run.

        Args:
            robot_id: The robot that asks, which must be on the board.
            x: The robot's position on the x axis, in metres.
            y: The robot's position on the y axis, in metres.
            target: The waypoint the robot would drive to.
            destination: The point the robot is heading to, which may be a shared dock.

        Returns:
            True when the robot may drive; False when it must hold its position.

        Raises:
            ValueError: If the robot is not on the board.
        """
        now = self._clock_ms()
        me = self._entry(robot_id)
        self._update(me, x, y, target, now)
        if me.pass_until_ms is not None and me.pass_until_ms > now:
            return True
        blockers = self._conflicts(robot_id, me, destination, now)
        if not blockers:
            me.waiting_since_ms = None
            return True
        if me.waiting_since_ms is None:
            me.waiting_since_ms = now
        if now - me.waiting_since_ms < WAIT_TIMEOUT_MS:
            return False
        if self._must_yield_to_pass(robot_id, me, blockers, now):
            return False
        me.waiting_since_ms = None
        me.pass_until_ms = now + PASS_MS
        _LOG.info("sim.traffic_pass", extra={"robotId": robot_id})
        return True

    def _entry(self, robot_id: str) -> _Entry:
        """Looks up a robot on the board.

        Args:
            robot_id: The robot to look up.

        Returns:
            The robot's entry.

        Raises:
            ValueError: If the robot is not on the board.
        """
        entry = self._entries.get(robot_id)
        if entry is None:
            raise ValueError("the robot is not on the traffic board")
        return entry

    @staticmethod
    def _update(entry: _Entry, x: float, y: float, target: Point, now: int) -> None:
        """Stores the position of a robot and the unit heading to its waypoint.

        A waypoint on the robot's own position keeps the previous heading, so the cone does not
        turn to an arbitrary direction.

        Args:
            entry: The robot's entry, updated in place.
            x: The robot's position on the x axis, in metres.
            y: The robot's position on the y axis, in metres.
            target: The waypoint the robot drives to.
            now: The current time, in milliseconds.
        """
        entry.x = x
        entry.y = y
        entry.seen_ms = now
        dx = target.x - x
        dy = target.y - y
        length = math.hypot(dx, dy)
        if length > 0.0:
            entry.hx = dx / length
            entry.hy = dy / length

    def _conflicts(
        self,
        robot_id: str,
        me: _Entry,
        destination: Point,
        now: int,
    ) -> list[tuple[str, _Entry]]:
        """Lists the robots that block a robot now, in identifier order.

        A robot is ignored when it is parked near the charger, when it is stationary next to the
        robot's own destination (a shared dock), when it is outside the robot's cone, or when the
        two are heading towards each other from the same side and the robot has the lower
        identifier. The last rule gives a crossing one winner, so it does not stall.

        Args:
            robot_id: The robot that asks.
            me: The robot's entry, already updated.
            destination: The point the robot is heading to.
            now: The current time, in milliseconds.

        Returns:
            The blocking robots, as (identifier, entry) pairs.
        """
        blockers: list[tuple[str, _Entry]] = []
        for other_id in sorted(self._entries):
            if other_id == robot_id:
                continue
            other = self._entries[other_id]
            if math.hypot(other.x - me.x, other.y - me.y) >= SAFETY_GAP_M:
                continue
            if self._is_parked(other):
                continue
            stationary = now - other.seen_ms > STALE_MS
            if stationary and math.hypot(other.x - destination.x, other.y - destination.y) < (
                SAFETY_GAP_M
            ):
                continue
            if not _in_cone(me.hx, me.hy, me.x, me.y, other.x, other.y):
                continue
            if self._has_priority(robot_id, me, other_id, other, now):
                continue
            blockers.append((other_id, other))
        return blockers

    def _is_parked(self, entry: _Entry) -> bool:
        """Tells whether a robot is inside the parking area around the charger.

        Args:
            entry: The robot's entry.

        Returns:
            True when the robot is within the parking radius.
        """
        return math.hypot(entry.x - self._centre.x, entry.y - self._centre.y) <= self._radius

    @staticmethod
    def _has_priority(
        robot_id: str,
        me: _Entry,
        other_id: str,
        other: _Entry,
        now: int,
    ) -> bool:
        """Tells whether a robot goes first against another one that is ahead of it.

        Priority applies only when both robots are fresh and heading the same way, or at a crossing
        angle. A head-on pair never gets it, so neither drives through the other.

        Args:
            robot_id: The robot that asks.
            me: The robot's entry.
            other_id: The other robot.
            other: The other robot's entry.
            now: The current time, in milliseconds.

        Returns:
            True when the robot may ignore the other one.
        """
        if now - other.seen_ms > STALE_MS or robot_id > other_id:
            return False
        if not _in_cone(other.hx, other.hy, other.x, other.y, me.x, me.y):
            return False
        if not _heading_known(me) or not _heading_known(other):
            return False
        dot = me.hx * other.hx + me.hy * other.hy
        return dot > _COS_HEAD_ON

    @staticmethod
    def _must_yield_to_pass(
        robot_id: str,
        me: _Entry,
        blockers: list[tuple[str, _Entry]],
        now: int,
    ) -> bool:
        """Tells whether a robot whose wait timed out must still hold back for a pass.

        Only one robot passes at a time, so that the simulator shows one move at a time. A robot
        yields to a blocker that is passing right now, and to a blocker that has waited longer, or
        as long and with a lower identifier. The earliest waiter always passes, so this cannot
        stall the fleet.

        Args:
            robot_id: The robot that asks.
            me: The robot's entry.
            blockers: The robots blocking it, as (identifier, entry) pairs.
            now: The current time, in milliseconds.

        Returns:
            True when the robot must keep waiting.
        """
        my_key = (me.waiting_since_ms, robot_id)
        for other_id, other in blockers:
            if other.pass_until_ms is not None and other.pass_until_ms > now:
                return True
            # A waiter that has stopped asking (halted, e-stopped, held by its navigator) is no
            # longer waiting: only a fresh one makes the others yield, or a stopped robot would
            # freeze them.
            fresh = now - other.seen_ms <= STALE_MS
            if (
                fresh
                and other.waiting_since_ms is not None
                and (other.waiting_since_ms, other_id) < my_key
            ):
                return True
        return False


class AvoidingNavigator:
    """Wraps a navigator so that a robot yields to the others on the board.

    It implements `Navigator`. Each robot has its own wrapper, which shares the board. It asks the
    board before each waypoint, so the inner navigator's trip state only advances when the robot
    really drives on.
    """

    def __init__(self, inner: Navigator, board: TrafficBoard, robot_id: str) -> None:
        """Creates the wrapper of one robot.

        Args:
            inner: The navigator that plans the path.
            board: The board shared by the fleet.
            robot_id: The robot this wrapper drives. It must be on the board.
        """
        self._inner = inner
        self._board = board
        self._robot_id = robot_id

    def next_waypoint(self, x: float, y: float, destination: Destination) -> Waypoint | None:
        """Returns the next waypoint of the inner navigator, unless another robot is in the way.

        Args:
            x: The robot's position on the x axis, in metres.
            y: The robot's position on the y axis, in metres.
            destination: The destination the robot is heading to.

        Returns:
            The waypoint the robot may drive to, or None when the robot must hold its position.
        """
        waypoint = self._inner.next_waypoint(x, y, destination)
        if waypoint is None:
            self._board.report(self._robot_id, x, y)
            return None
        if self._board.may_advance(self._robot_id, x, y, waypoint.point, destination.point):
            return waypoint
        return None

    def reached(self, waypoint: Waypoint) -> None:
        """Passes an intermediate waypoint on to the inner navigator.

        Args:
            waypoint: The intermediate waypoint that was reached.
        """
        self._inner.reached(waypoint)


def _in_cone(hx: float, hy: float, fx: float, fy: float, tx: float, ty: float) -> bool:
    """Tells whether a point lies within the cone ahead of a heading, from a position.

    An unknown heading has no cone, and a point on the position itself is always inside.

    Args:
        hx: The x component of the unit heading; zero when unknown.
        hy: The y component of the unit heading; zero when unknown.
        fx: The x position of the viewer, in metres.
        fy: The y position of the viewer, in metres.
        tx: The x position of the point, in metres.
        ty: The y position of the point, in metres.

    Returns:
        True when the point is within CONE_HALF_ANGLE_RAD of the heading.
    """
    dx = tx - fx
    dy = ty - fy
    length = math.hypot(dx, dy)
    if length == 0.0:
        return True
    if not hx and not hy:
        return False
    return (hx * dx + hy * dy) / length >= _COS_CONE


def _heading_known(entry: _Entry) -> bool:
    """Tells whether a robot has a heading, that is, has been given a waypoint.

    Args:
        entry: The robot's entry.

    Returns:
        False while the robot has never had a waypoint to drive to.
    """
    return bool(entry.hx or entry.hy)
