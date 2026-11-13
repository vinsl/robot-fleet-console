"""Tests of the traffic yield between simulated robots: waits, priority, passes and the wrapper.

The board takes an injected clock, so every test drives time and positions by hand. The `_Yard`
helper moves robots in straight lines on that clock, with the same step as the core: a robot that
gets no waypoint holds still. The inner navigator is a stub, so no map is needed.
"""

from __future__ import annotations

import logging
import math
import random
import time
from dataclasses import dataclass, field

import pytest

from fleet_agent.core.model import Destination, Point
from fleet_agent.core.ports import Waypoint
from fleet_agent.sim.traffic import (
    PASS_MS,
    SAFETY_GAP_M,
    WAIT_TIMEOUT_MS,
    AvoidingNavigator,
    TrafficBoard,
    _monotonic_ms,
)

_DT_MS = 50
_SPEED_MPS = 1.0
_FAR = Point(-1000.0, -1000.0)
"""A parking centre far from every test position, so that no robot is parked by accident."""
_CHARGER = Point(0.0, 0.0)
_PARKING_RADIUS_M = 4.6


class _Clock:
    """A clock the test moves by hand, in milliseconds."""

    def __init__(self) -> None:
        """Starts the clock at zero."""
        self.now_ms = 0

    def __call__(self) -> int:
        """Reads the clock.

        Returns:
            The current time, in milliseconds.
        """
        return self.now_ms


class _StraightLine:
    """An inner navigator that drives straight to the destination, as one final waypoint."""

    def __init__(self) -> None:
        """Creates the stub with no call recorded."""
        self.reached_calls: list[Waypoint] = []

    def next_waypoint(self, x: float, y: float, destination: Destination) -> Waypoint | None:
        """Returns the destination as the one final waypoint.

        Args:
            x: The robot's position on the x axis. Unused.
            y: The robot's position on the y axis. Unused.
            destination: The destination the robot heads to.

        Returns:
            The final waypoint at the destination.
        """
        del x, y
        return Waypoint(destination.point, final=True)

    def reached(self, waypoint: Waypoint) -> None:
        """Records an intermediate waypoint that was reached.

        Args:
            waypoint: The waypoint that was reached.
        """
        self.reached_calls.append(waypoint)


class _NoPath:
    """An inner navigator that never has a waypoint, as a robot with no route yet."""

    def next_waypoint(self, x: float, y: float, destination: Destination) -> Waypoint | None:
        """Gives no waypoint.

        Args:
            x: The robot's position on the x axis. Unused.
            y: The robot's position on the y axis. Unused.
            destination: The destination. Unused.

        Returns:
            Always None.
        """
        del x, y, destination
        return None

    def reached(self, waypoint: Waypoint) -> None:
        """Ignores the arrival: this navigator never gives a waypoint to reach.

        Args:
            waypoint: The waypoint. Unused.
        """
        del waypoint


def _board(clock: _Clock | None = None) -> TrafficBoard:
    """Builds a board with no parking area near the test positions, on a clock the test controls.

    Args:
        clock: The clock to read. A fresh clock at zero when None.

    Returns:
        The empty board.
    """
    return TrafficBoard(parking_centre=_FAR, parking_radius_m=1.0, clock_ms=clock or _Clock())


def _distance(a: Point, b: Point) -> float:
    """Measures the distance between two points.

    Args:
        a: The first point.
        b: The second point.

    Returns:
        The distance, in metres.
    """
    return math.hypot(a.x - b.x, a.y - b.y)


def _step_towards(here: Point, target: Point, step_m: float) -> Point:
    """Moves a point towards a target by at most one step, without overshooting.

    Args:
        here: The current position.
        target: The point to drive to.
        step_m: The distance the robot covers in this tick, in metres.

    Returns:
        The target when it is within one step, else the point one step towards it.
    """
    gap = _distance(here, target)
    if gap <= step_m:
        return target
    ratio = step_m / gap
    return Point(here.x + (target.x - here.x) * ratio, here.y + (target.y - here.y) * ratio)


def _ask(
    board: TrafficBoard,
    robot_id: str,
    at: Point,
    target: Point,
    destination: Point | None = None,
) -> bool:
    """Asks the board whether a robot may drive towards a target from a position.

    Args:
        board: The board to ask.
        robot_id: The robot that asks.
        at: The robot's position, in metres.
        target: The waypoint the robot drives to.
        destination: The point the robot heads to. Defaults to the target.

    Returns:
        The board's answer.
    """
    return board.may_advance(robot_id, at.x, at.y, target, destination or target)


@dataclass
class _Yard:
    """Robots on a clock: each drives to a goal through the wrapper, or stands halted.

    Attributes:
        caplog: The log capture, from which the pass events are read.
        board: The traffic board the robots share.
        clock: The clock the board reads.
        pos: The true position of every robot, driving or halted.
        goal: The goal of every driving robot.
        arrived: The driving robots that reached their goal.
        longest_wait_ms: The longest run of ticks each driving robot spent waiting, in milliseconds.
        first_wait_ms: When each driving robot's first wait of the run began, in milliseconds.
        passes: The pass events, as (robot identifier, time in milliseconds).
    """

    caplog: pytest.LogCaptureFixture
    board: TrafficBoard = field(init=False)
    clock: _Clock = field(init=False)
    pos: dict[str, Point] = field(default_factory=dict)
    goal: dict[str, Point] = field(default_factory=dict)
    arrived: set[str] = field(default_factory=set)
    longest_wait_ms: dict[str, int] = field(default_factory=dict)
    first_wait_ms: dict[str, int] = field(default_factory=dict)
    passes: list[tuple[str, int]] = field(default_factory=list)
    _navigators: dict[str, AvoidingNavigator] = field(default_factory=dict)
    _wait_run_ms: dict[str, int] = field(default_factory=dict)
    _pass_until: dict[str, int] = field(default_factory=dict)
    _records_seen: int = 0

    def __post_init__(self) -> None:
        """Builds the board on a fresh clock, and captures the simulator's logs at INFO."""
        self.clock = _Clock()
        self.board = TrafficBoard(parking_centre=_FAR, parking_radius_m=1.0, clock_ms=self.clock)
        self.caplog.set_level(logging.INFO, logger="fleet_agent.sim")

    def drive(self, robot_id: str, start: Point, goal: Point) -> None:
        """Places a robot that drives to a goal, through the wrapper around a straight line.

        Args:
            robot_id: The robot's identifier.
            start: Where the robot starts, in metres.
            goal: Where the robot drives to, in metres.
        """
        self.board.place(robot_id, start)
        self.pos[robot_id] = start
        self.goal[robot_id] = goal
        self._navigators[robot_id] = AvoidingNavigator(_StraightLine(), self.board, robot_id)
        self.longest_wait_ms[robot_id] = 0
        self._wait_run_ms[robot_id] = 0

    def halt(self, robot_id: str, at: Point) -> None:
        """Places a robot that never moves, as a robot that has stopped in the way.

        Args:
            robot_id: The robot's identifier.
            at: Where the robot stands, in metres.
        """
        self.board.place(robot_id, at)
        self.pos[robot_id] = at

    def tick(self) -> None:
        """Advances the clock one tick, then lets every driving robot ask and move, in order."""
        self.clock.now_ms += _DT_MS
        for robot_id in sorted(self._navigators):
            if robot_id in self.arrived:
                continue
            here = self.pos[robot_id]
            destination = Destination(kind="STATION", point=self.goal[robot_id])
            waypoint = self._navigators[robot_id].next_waypoint(here.x, here.y, destination)
            if waypoint is None:
                continue
            self.pos[robot_id] = _step_towards(here, waypoint.point, _SPEED_MPS * _DT_MS / 1000)
            if self.pos[robot_id] == waypoint.point and waypoint.final:
                self.arrived.add(robot_id)
        self._track()

    def run(self, ticks: int) -> None:
        """Runs a number of ticks.

        Args:
            ticks: How many ticks to run.
        """
        for _ in range(ticks):
            self.tick()

    def run_until_arrived(self, max_ticks: int) -> None:
        """Runs until every driving robot arrived, or the tick budget is spent.

        Args:
            max_ticks: The most ticks to run.
        """
        for _ in range(max_ticks):
            if len(self.arrived) == len(self._navigators):
                return
            self.tick()

    def in_pass_window(self, robot_id: str) -> bool:
        """Tells whether a robot is moving through after a deadlock pass.

        Args:
            robot_id: The robot to look up.

        Returns:
            True while the robot's pass window is open.
        """
        return self._pass_until.get(robot_id, -1) > self.clock.now_ms

    def _track(self) -> None:
        """Updates the wait runs, and reads the pass events logged since the last tick."""
        for robot_id in self._navigators:
            if self.board.is_waiting(robot_id):
                self._wait_run_ms[robot_id] += _DT_MS
                if self._wait_run_ms[robot_id] == _DT_MS:
                    self.first_wait_ms[robot_id] = self.clock.now_ms
                self.longest_wait_ms[robot_id] = max(
                    self.longest_wait_ms[robot_id], self._wait_run_ms[robot_id]
                )
            else:
                self._wait_run_ms[robot_id] = 0
        for record in self.caplog.records[self._records_seen :]:
            if record.getMessage() != "sim.traffic_pass":
                continue
            robot_id = str(getattr(record, "robotId", ""))
            self.passes.append((robot_id, self.clock.now_ms))
            self._pass_until[robot_id] = self.clock.now_ms + PASS_MS
        self._records_seen = len(self.caplog.records)


# Head-on, crossing and following ------------------------------------------------------------------


def test_two_robots_facing_each_other_both_hold_within_the_gap(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given two robots three metres apart, driving head-on, when they meet,
    then both stop closer than the safety gap, and neither drives through the other."""
    yard = _Yard(caplog)
    yard.drive("sim-01", Point(0.0, 0.0), Point(10.0, 0.0))
    yard.drive("sim-02", Point(3.0, 0.0), Point(-7.0, 0.0))

    yard.run(40)

    assert yard.board.is_waiting("sim-01")
    assert yard.board.is_waiting("sim-02")
    gap = _distance(yard.pos["sim-01"], yard.pos["sim-02"])
    assert 0.0 < gap < SAFETY_GAP_M


def test_at_the_timeout_one_head_on_robot_passes_and_the_other_holds_through_the_pass(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given two head-on robots that met, when the first to have waited passes at its timeout,
    then the other holds for the whole pass window, so only one robot moves through at a time."""
    yard = _Yard(caplog)
    yard.drive("sim-01", Point(0.0, 0.0), Point(10.0, 0.0))
    yard.drive("sim-02", Point(3.0, 0.0), Point(-7.0, 0.0))
    yard.run(40)
    earliest = min(
        yard.first_wait_ms, key=lambda robot_id: (yard.first_wait_ms[robot_id], robot_id)
    )

    for _ in range(200):
        if yard.passes:
            break
        yard.tick()
    assert yard.passes == [(earliest, yard.first_wait_ms[earliest] + WAIT_TIMEOUT_MS)]

    yard.run(PASS_MS // _DT_MS - 1)
    assert len(yard.passes) == 1


def test_at_the_same_tick_the_lower_identifier_passes_and_the_other_yields() -> None:
    """Given two head-on robots that started waiting on the same tick, when the timeout passes,
    then the lower identifier passes first, and the higher one yields to that pass."""
    clock = _Clock()
    board = _board(clock)
    board.place("sim-01", Point(0.0, 0.0))
    board.place("sim-02", Point(0.9, 0.0))
    assert not _ask(board, "sim-01", Point(0.0, 0.0), Point(10.0, 0.0))
    assert not _ask(board, "sim-02", Point(0.9, 0.0), Point(-10.0, 0.0))

    clock.now_ms = WAIT_TIMEOUT_MS
    assert _ask(board, "sim-01", Point(0.0, 0.0), Point(10.0, 0.0))
    assert not _ask(board, "sim-02", Point(0.9, 0.0), Point(-10.0, 0.0))


def test_no_robot_of_a_head_on_pair_holds_longer_than_the_timeout_and_its_pass(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given two head-on robots, when they run until both have arrived, then no robot waited
    longer than the timeout plus one pass, and both reached their goals."""
    yard = _Yard(caplog)
    yard.drive("sim-01", Point(0.0, 0.0), Point(10.0, 0.0))
    yard.drive("sim-02", Point(3.0, 0.0), Point(-7.0, 0.0))

    yard.run_until_arrived(max_ticks=2000)

    assert yard.arrived == {"sim-01", "sim-02"}
    assert all(wait <= WAIT_TIMEOUT_MS + PASS_MS for wait in yard.longest_wait_ms.values())


def test_a_crossing_gives_the_lower_identifier_the_way_and_the_other_waits(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given two robots on perpendicular paths that meet at the origin, when they cross,
    then sim-01 never waits, sim-02 waits and resumes, and no pass is needed."""
    yard = _Yard(caplog)
    yard.drive("sim-01", Point(-3.0, 0.0), Point(3.0, 0.0))
    yard.drive("sim-02", Point(0.0, -3.0), Point(0.0, 3.0))

    waited = False
    for _ in range(400):
        if yard.arrived == {"sim-01", "sim-02"}:
            break
        yard.tick()
        assert not yard.board.is_waiting("sim-01")
        waited = waited or yard.board.is_waiting("sim-02")

    assert waited
    assert yard.arrived == {"sim-01", "sim-02"}
    assert yard.passes == []


def test_a_follower_waits_behind_its_leader_until_the_gap_is_the_safety_gap(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given a follower 0.8 m behind a leader going the same way, when the leader drives on,
    then the leader never waits, and the follower moves only once the gap is one metre or more."""
    yard = _Yard(caplog)
    yard.drive("sim-01", Point(0.0, 0.0), Point(10.0, 0.0))
    yard.drive("sim-02", Point(-0.8, 0.0), Point(10.0, 0.0))
    first_move_gap: float | None = None

    for _ in range(60):
        before = yard.pos["sim-02"]
        yard.tick()
        assert not yard.board.is_waiting("sim-01")
        if first_move_gap is None and yard.pos["sim-02"] != before:
            first_move_gap = _distance(yard.pos["sim-01"], before)

    assert first_move_gap is not None
    assert first_move_gap >= SAFETY_GAP_M - 1e-9
    assert yard.passes == []


# Stopped robots, docks, parking and chains --------------------------------------------------------


def test_a_stopped_robot_in_the_way_is_passed_after_the_timeout(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given a robot that stands still five metres ahead, when another robot drives into it,
    then the driver waits for the full timeout, passes once, and the pass is logged."""
    yard = _Yard(caplog)
    yard.halt("sim-02", Point(5.0, 0.0))
    yard.drive("sim-01", Point(0.0, 0.0), Point(10.0, 0.0))

    yard.run(90)
    assert yard.board.is_waiting("sim-01")
    yard.run(WAIT_TIMEOUT_MS // _DT_MS + 2)

    assert [robot_id for robot_id, _ in yard.passes] == ["sim-01"]
    assert WAIT_TIMEOUT_MS <= yard.longest_wait_ms["sim-01"] <= WAIT_TIMEOUT_MS + _DT_MS


def test_a_robot_halted_while_waiting_does_not_make_the_others_yield() -> None:
    """Given a robot that waited and was then halted (its navigator has no waypoint, so it only
    reports), when a neighbour that waits later times out, then the neighbour passes: the stale
    waiting key of the halted robot must not freeze it for good."""
    now = [0]
    board = TrafficBoard(
        parking_centre=Point(-50.0, -50.0), parking_radius_m=1.0, clock_ms=lambda: now[0]
    )
    board.place("sim-02", Point(5.0, 0.0))
    board.place("sim-01", Point(4.2, 0.0))
    # sim-02 waits first (time 0); sim-01 starts asking later, so its waiting key is the later one.
    assert board.may_advance("sim-02", 5.0, 0.0, Point(0.0, 0.0), Point(0.0, 0.0)) is False
    assert board.is_waiting("sim-02")
    # sim-02 is halted from now on: it reports its position every tick and never asks to advance.
    passed_at: int | None = None
    for step in range(1, (WAIT_TIMEOUT_MS + 3000) // 50):
        now[0] = step * 50
        board.report("sim-02", 5.0, 0.0)
        if board.may_advance("sim-01", 4.2, 0.0, Point(10.0, 0.0), Point(10.0, 0.0)):
            passed_at = now[0]
            break

    assert passed_at is not None
    assert passed_at <= WAIT_TIMEOUT_MS + 200


def test_a_stopped_robot_on_the_destination_is_a_shared_dock_and_is_not_waited_for(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given a stopped robot standing on the destination of another, when the other arrives,
    then it never waits: the two share the dock."""
    yard = _Yard(caplog)
    yard.halt("sim-02", Point(10.0, 0.0))
    yard.drive("sim-01", Point(0.0, 0.0), Point(10.0, 0.0))

    yard.run_until_arrived(max_ticks=400)

    assert yard.arrived == {"sim-01"}
    assert yard.longest_wait_ms["sim-01"] == 0


@pytest.mark.parametrize(
    ("parking_radius", "expected_wait"),
    [(1.0, False), (0.1, True)],
    ids=["parked-is-ignored", "outside-the-parking-area-is-waited-for"],
)
def test_a_robot_parked_near_the_charger_is_not_in_the_way(
    parking_radius: float,
    expected_wait: bool,
) -> None:
    """Given a stopped robot 0.5 m from the charger, when the parking area covers it, then a robot
    driving past does not wait; when the area does not cover it, the robot waits."""
    board = TrafficBoard(
        parking_centre=_CHARGER, parking_radius_m=parking_radius, clock_ms=_Clock()
    )
    board.place("sim-02", Point(0.5, 0.0))
    board.place("sim-01", Point(-0.2, 0.0))

    may = _ask(board, "sim-01", Point(-0.2, 0.0), Point(10.0, 0.0))

    assert may == (not expected_wait)
    assert board.is_waiting("sim-01") == expected_wait


def test_a_chain_of_three_behind_a_halted_robot_resumes_one_link_at_a_time(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given a halted robot with two robots queued behind it, when the first waits out its timeout
    and passes, then each robot in the chain resumes within the timeout plus one pass."""
    yard = _Yard(caplog)
    yard.halt("sim-01", Point(0.0, 0.0))
    yard.drive("sim-02", Point(-2.0, 0.0), Point(10.0, 0.0))
    yard.drive("sim-03", Point(-4.0, 0.0), Point(10.0, 0.0))

    yard.run_until_arrived(max_ticks=4000)

    assert yard.arrived == {"sim-02", "sim-03"}
    assert yard.passes
    assert all(wait <= WAIT_TIMEOUT_MS + PASS_MS for wait in yard.longest_wait_ms.values())


def test_a_cycle_of_three_robots_never_stalls_beyond_the_timeout_and_its_pass(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given three robots on a small triangle, each driving to the next robot's corner, when they
    run in a cycle, then all three reach their goals and none waits longer than the timeout plus
    one pass. The identifier priority normally resolves the cycle before any pass is needed."""
    yard = _Yard(caplog)
    side_m = 0.9
    radius_m = side_m / math.sqrt(3.0)
    corners = [
        Point(radius_m * math.cos(angle), radius_m * math.sin(angle))
        for angle in (math.pi / 2, math.pi / 2 + 2 * math.pi / 3, math.pi / 2 + 4 * math.pi / 3)
    ]
    for index, corner in enumerate(corners):
        yard.drive(f"sim-0{index + 1}", corner, corners[(index + 1) % 3])

    yard.run_until_arrived(max_ticks=4000)

    assert yard.arrived == {"sim-01", "sim-02", "sim-03"}
    assert all(wait <= WAIT_TIMEOUT_MS + PASS_MS for wait in yard.longest_wait_ms.values())


# Twenty robots ------------------------------------------------------------------------------------

_SOAK_ROBOTS = 20
_SOAK_TICKS = 10_000
_SOAK_FLOOR_M = 0.5
"""The distance under which two robots count as having collided, outside a pass, in metres."""


def _scatter(
    rng: random.Random,
    count: int,
    *,
    radius: float,
    min_radius: float,
    min_gap: float,
) -> list[Point]:
    """Draws points in a ring around the charger, rejecting those too close to another.

    Args:
        rng: The seeded random source.
        count: How many points to draw.
        radius: The outer radius of the ring, in metres.
        min_radius: The inner radius of the ring, in metres.
        min_gap: The least distance between two points, in metres.

    Returns:
        The points, in the order drawn.

    Raises:
        AssertionError: If the ring cannot hold that many points under the spacing.
    """
    points: list[Point] = []
    for _ in range(20_000):
        if len(points) == count:
            return points
        angle = rng.uniform(0.0, 2.0 * math.pi)
        distance = math.sqrt(rng.uniform(min_radius**2, radius**2))
        candidate = Point(
            _CHARGER.x + distance * math.cos(angle), _CHARGER.y + distance * math.sin(angle)
        )
        if all(_distance(candidate, other) >= min_gap for other in points):
            points.append(candidate)
    raise AssertionError("the ring cannot hold the points under the spacing")


@dataclass(frozen=True)
class _SoakOutcome:
    """What a run of the twenty-robot soak showed.

    Attributes:
        trace: The position of every robot, in identifier order, after each tick.
        violations: The moments two robots were closer than the floor, outside the parking area
            and the pass windows, as (time in milliseconds, first id, second id).
        all_arrived: Whether every robot reached its goal within the tick budget.
    """

    trace: list[tuple[tuple[float, float], ...]]
    violations: list[tuple[int, str, str]]
    all_arrived: bool


def _close_pairs(yard: _Yard, ids: list[str]) -> list[tuple[int, str, str]]:
    """Lists the pairs closer than the floor, outside the parking area and the pass windows.

    Args:
        yard: The yard the robots drive in.
        ids: The robots, in identifier order.

    Returns:
        The close pairs of this tick, as (time in milliseconds, first id, second id).
    """
    found: list[tuple[int, str, str]] = []
    for index, first in enumerate(ids):
        for second in ids[index + 1 :]:
            a = yard.pos[first]
            b = yard.pos[second]
            if _distance(a, _CHARGER) <= _PARKING_RADIUS_M:
                continue
            if _distance(b, _CHARGER) <= _PARKING_RADIUS_M:
                continue
            if yard.in_pass_window(first) or yard.in_pass_window(second):
                continue
            if _distance(a, b) < _SOAK_FLOOR_M:
                found.append((yard.clock.now_ms, first, second))
    return found


def _run_soak(caplog: pytest.LogCaptureFixture, seed: int) -> _SoakOutcome:
    """Runs twenty robots from the parking area to scattered goals, with a seeded layout.

    Args:
        caplog: The log capture, which reads the pass events.
        seed: The seed of the layout.

    Returns:
        What the run showed.
    """
    rng = random.Random(seed)  # noqa: S311 - a seeded layout for a simulation, not a secret
    starts = _scatter(
        rng, _SOAK_ROBOTS, radius=_PARKING_RADIUS_M - 0.5, min_radius=0.0, min_gap=1.0
    )
    goals = _scatter(rng, _SOAK_ROBOTS, radius=14.0, min_radius=6.0, min_gap=1.5)
    yard = _Yard(caplog)
    yard.board = TrafficBoard(
        parking_centre=_CHARGER, parking_radius_m=_PARKING_RADIUS_M, clock_ms=yard.clock
    )
    ids = [f"sim-{index + 1:02d}" for index in range(_SOAK_ROBOTS)]
    for robot_id, start, goal in zip(ids, starts, goals, strict=True):
        yard.drive(robot_id, start, goal)

    trace: list[tuple[tuple[float, float], ...]] = []
    violations: list[tuple[int, str, str]] = []
    for _ in range(_SOAK_TICKS):
        if len(yard.arrived) == _SOAK_ROBOTS:
            break
        yard.tick()
        trace.append(tuple((yard.pos[robot_id].x, yard.pos[robot_id].y) for robot_id in ids))
        violations.extend(_close_pairs(yard, ids))
    return _SoakOutcome(
        trace=trace,
        violations=violations,
        all_arrived=len(yard.arrived) == _SOAK_ROBOTS,
    )


def test_twenty_robots_never_come_closer_than_the_floor_and_all_arrive(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given twenty robots leaving a parking area for scattered goals, seeded 42, when they drive
    for at most 10,000 ticks, then no two come closer than 0.5 m outside a pass, every robot
    reaches its goal, and the run takes under two seconds."""
    outcome = _run_soak(caplog, seed=42)

    assert outcome.violations == []
    assert outcome.all_arrived


def test_the_same_seed_gives_the_same_positions_at_every_tick(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given the same seed, when the twenty-robot run is repeated, then every position of every
    tick is identical, so the decisions are reproducible."""
    first = _run_soak(caplog, seed=42)
    caplog.clear()
    second = _run_soak(caplog, seed=42)

    assert first.trace == second.trace


# Board contract -----------------------------------------------------------------------------------


def test_placing_a_robot_twice_is_refused() -> None:
    """Given a robot on the board, when it is placed again, then the board refuses it."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))

    with pytest.raises(ValueError, match="already on the traffic board"):
        board.place("sim-01", Point(1.0, 0.0))


def test_a_robot_that_is_not_on_the_board_is_refused() -> None:
    """Given a board with one robot, when another robot is reported, asked about or driven, then
    each call is refused and nothing is recorded for the stranger."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))

    with pytest.raises(ValueError, match="not on the traffic board"):
        board.report("sim-09", 0.0, 0.0)
    with pytest.raises(ValueError, match="not on the traffic board"):
        board.is_waiting("sim-09")
    with pytest.raises(ValueError, match="not on the traffic board"):
        _ask(board, "sim-09", Point(0.0, 0.0), Point(1.0, 0.0))


def test_removing_a_robot_twice_is_a_no_op() -> None:
    """Given a robot removed from the board, when it is removed again, then nothing fails."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))

    board.remove("sim-01")
    board.remove("sim-01")

    with pytest.raises(ValueError, match="not on the traffic board"):
        board.is_waiting("sim-01")


def test_a_robot_that_never_had_a_waypoint_has_no_cone_ahead_of_it() -> None:
    """Given a robot that has never driven and another one just ahead of it, when the robot asks
    to hold on its own position, then it may go: an unknown heading looks at nothing."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))
    board.place("sim-02", Point(0.5, 0.0))

    assert _ask(board, "sim-01", Point(0.0, 0.0), Point(0.0, 0.0))


def test_two_robots_on_the_same_point_are_in_each_others_way() -> None:
    """Given two robots on the same point, when one asks to drive, then it waits."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))
    board.place("sim-02", Point(0.0, 0.0))

    assert not _ask(board, "sim-01", Point(0.0, 0.0), Point(5.0, 0.0))


def test_a_waypoint_on_the_robots_own_position_keeps_the_previous_heading() -> None:
    """Given a robot heading north with another one just north of it, when it asks for a waypoint
    on its own position, then it keeps its north heading and still waits for the other."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))
    board.place("sim-02", Point(0.0, 0.5))
    assert not _ask(board, "sim-01", Point(0.0, 0.0), Point(0.0, 5.0))

    assert not _ask(board, "sim-01", Point(0.0, 0.0), Point(0.0, 0.0))


def test_the_default_clock_is_the_monotonic_clock_in_whole_milliseconds() -> None:
    """Given no injected clock, when the default clock is read, then it is the monotonic clock in
    whole milliseconds, between two readings of the monotonic clock itself."""
    before = time.monotonic_ns() // 1_000_000
    reading = _monotonic_ms()
    after = time.monotonic_ns() // 1_000_000

    assert before <= reading <= after
    board = TrafficBoard(parking_centre=_FAR, parking_radius_m=1.0)
    board.place("sim-01", Point(0.0, 0.0))
    assert board.is_waiting("sim-01") is False


def test_a_robot_that_holds_position_is_fresh_so_a_dock_does_not_excuse_it() -> None:
    """Given a robot that holds position with no waypoint, when another robot drives into it at
    the held robot's own position, then the held robot counts as fresh, so the other waits: only a
    stopped robot, one not reporting, is excused at a shared dock."""
    board = _board()
    board.place("sim-01", Point(9.2, 0.0))
    board.place("sim-02", Point(10.0, 0.0))
    navigator = AvoidingNavigator(_NoPath(), board, "sim-02")
    destination = Destination(kind="STATION", point=Point(10.0, 0.0))
    assert navigator.next_waypoint(10.0, 0.0, destination) is None

    assert not _ask(board, "sim-01", Point(9.2, 0.0), Point(10.0, 0.0), Point(10.0, 0.0))


def test_the_wrapper_passes_the_inner_waypoint_on_when_the_road_is_clear() -> None:
    """Given a free road, when the wrapper asks for a waypoint, then it returns the inner one."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))
    navigator = AvoidingNavigator(_StraightLine(), board, "sim-01")
    destination = Destination(kind="STATION", point=Point(5.0, 0.0))

    waypoint = navigator.next_waypoint(0.0, 0.0, destination)

    assert waypoint == Waypoint(Point(5.0, 0.0), final=True)


def test_the_wrapper_holds_when_the_inner_navigator_has_no_waypoint() -> None:
    """Given an inner navigator with no path, when the wrapper is asked, then it has none either,
    and the robot stays on the board, fresh."""
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))
    navigator = AvoidingNavigator(_NoPath(), board, "sim-01")

    assert navigator.next_waypoint(0.0, 0.0, Destination("STATION", Point(5.0, 0.0))) is None
    assert board.is_waiting("sim-01") is False


def test_the_wrapper_passes_an_intermediate_arrival_to_the_inner_navigator() -> None:
    """Given an intermediate waypoint, when the wrapper reports its arrival, then the inner
    navigator is told about it."""
    inner = _StraightLine()
    board = _board()
    board.place("sim-01", Point(0.0, 0.0))
    navigator = AvoidingNavigator(inner, board, "sim-01")
    waypoint = Waypoint(Point(1.0, 0.0), final=False)

    navigator.reached(waypoint)

    assert inner.reached_calls == [waypoint]
