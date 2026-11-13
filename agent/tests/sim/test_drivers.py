"""Tests of the simulator's drivers: the navigator, the mission driver and the fault injector.

The mission and fault tests use a small fake of the core that records the calls it receives. One
integration test runs the real core, with the navigator, from an idle start to a station.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Sequence
from concurrent.futures import Executor, Future
from typing import Any, Literal

import pytest

from fleet_agent.core.agent import AgentCore
from fleet_agent.core.identity import AgentIdentity
from fleet_agent.core.model import Destination, Point
from fleet_agent.core.ports import Waypoint
from fleet_agent.core.snapshot import AgentSnapshot
from fleet_agent.protocol.primitives import ReportedState
from fleet_agent.sim import navigator as navigator_module
from fleet_agent.sim.astar import plan_path
from fleet_agent.sim.faults import LINK_LOSS_MS, RESUME_DELAY_MS, FaultInjector
from fleet_agent.sim.grid import CELL_M, OccupancyGrid, build_grid
from fleet_agent.sim.missions import MISSION_MIN_BATTERY_PERCENT, MissionDriver
from fleet_agent.sim.navigator import GridNavigator
from fleet_agent.sim.routes import RouteBook
from fleet_agent.sim.site_map import SiteMap, Station
from fleet_agent.sim.stations import StationRegistry
from tests.core.fakes import SITE, FakeClock, FakeTransport, MemoryLatchStore

_OPEN_BOUNDS = (0.0, 0.0, 30.0, 30.0)
_STATIONS = (Station("pick", Point(5.0, 5.0)), Station("drop", Point(20.0, 20.0)))
_CHARGER = Point(0.0, 0.0)


class _InlineExecutor(Executor):
    """Runs each submitted call at once, so the on-demand plan is ready when the test asks."""

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:  # noqa: ANN401
        """Runs the call now and returns the completed future.

        Args:
            fn: The callable.
            *args: Its positional arguments.
            **kwargs: Its keyword arguments.

        Returns:
            A future holding the result.
        """
        future: Future[Any] = Future()
        future.set_result(fn(*args, **kwargs))
        return future


class _NeverExecutor(Executor):
    """Accepts every call and never finishes it, to test the plan timeout."""

    def __init__(self) -> None:
        """Creates the executor with no future handed out yet."""
        self.futures: list[Future[Any]] = []

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:  # noqa: ANN401
        """Returns a future that stays pending.

        Args:
            fn: The callable, not run.
            *args: Its positional arguments, unused.
            **kwargs: Its keyword arguments, unused.

        Returns:
            A pending future.
        """
        future: Future[Any] = Future()
        self.futures.append(future)
        return future


class _Clock:
    """A clock the test moves by hand, in seconds."""

    def __init__(self) -> None:
        """Starts at zero."""
        self.now = 0.0

    def __call__(self) -> float:
        """Returns the current time.

        Returns:
            The time, in seconds.
        """
        return self.now


def _open_map() -> SiteMap:
    """Builds an open 30 m square with the charger at its corner and two stations.

    Returns:
        The map.
    """
    return SiteMap(
        charger=_CHARGER,
        stations=_STATIONS,
        walls=(),
        obstacles=(),
        nogos=(),
        bounds=_OPEN_BOUNDS,
    )


def _grid_and_book(site_map: SiteMap) -> tuple[OccupancyGrid, RouteBook]:
    """Builds the inflated grid and the route book of a map, keyed as the fleet keys the stops.

    Args:
        site_map: The map.

    Returns:
        The grid and the book.
    """
    grid = build_grid(site_map)
    stops = {"charger": site_map.charger}
    stops.update({f"station/{s.name}": s.point for s in site_map.stations})
    return grid, RouteBook.build(grid, stops)


class _FakeCore:
    """A core stand-in that records the calls of a driver and reports a state the test sets."""

    def __init__(self, state: ReportedState = "IDLE", battery: float = 80.0) -> None:
        """Creates the fake in a given state.

        Args:
            state: The state reported to the driver.
            battery: The charge reported to the driver, in percent.
        """
        self.state = state
        self.battery = battery
        self.missions: list[tuple[str, list[Point]]] = []
        self.mission_id: str | None = None
        self.accept_missions = True
        self.lock_held = False
        self.finished = 0
        self.faults: list[tuple[str, int | None]] = []
        self.resumes = 0
        self.resume_result = True
        self.fault_result = True
        self.blocked_after_fault = True

    @property
    def battery_percent(self) -> float:
        """The charge, in percent.

        Returns:
            The charge the test set.
        """
        return self.battery

    def snapshot(self) -> AgentSnapshot:
        """Returns the view of the fake.

        Returns:
            A snapshot in the state the test set.
        """
        return AgentSnapshot(
            state=self.state,
            banner="NONE",
            lock_held=self.lock_held,
            connected=True,
            simulated=True,
            boot_id="0190f5a0-0000-7000-8000-000000000001",
            latch_persisted=True,
            mission_id=self.mission_id,
        )

    def end_mission(self, state: ReportedState = "IDLE") -> None:
        """Ends the mission the way the test says: the robot is left in the given state.

        Args:
            state: The state the robot is left in, such as IDLE after a completed mission, or
                MOVING after an abort to the charger.
        """
        self.mission_id = None
        self.state = state

    def assign_mission(self, mission_id: str, stations: Sequence[Point]) -> bool:
        """Records a mission assignment. An accepted mission leaves the robot moving.

        Args:
            mission_id: The mission identifier.
            stations: The stations of the mission.

        Returns:
            The acceptance the test set.
        """
        self.missions.append((mission_id, list(stations)))
        if self.accept_missions:
            self.mission_id = mission_id
            self.state = "MOVING"
        return self.accept_missions

    def finish_work(self) -> bool:
        """Records the end of a work session, which completes the mission.

        Returns:
            True, always.
        """
        self.finished += 1
        self.end_mission("IDLE")
        return True

    def inject_fault(self, kind: str, duration_ms: int | None = None) -> bool:
        """Records an injected fault, and makes the robot blocked when the test says so.

        Args:
            kind: The fault kind.
            duration_ms: The duration asked for, if any.

        Returns:
            The result the test set.
        """
        if self.state == "BLOCKED":
            return False
        self.faults.append((kind, duration_ms))
        if self.fault_result and self.blocked_after_fault:
            self.state = "BLOCKED"
        return self.fault_result

    def auto_resume(self) -> bool:
        """Records a resume request, and resumes the robot when the test says so.

        Returns:
            The result the test set.
        """
        self.resumes += 1
        if self.resume_result:
            self.state = "MOVING"
        return self.resume_result


# Navigator ----------------------------------------------------------------------------------------


def test_a_trip_from_a_stop_follows_the_book_and_marks_only_its_last_point_final() -> None:
    """Given a robot at the charger, when it heads to a station,
    then the book's route is walked and only the last point is final."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    nav = GridNavigator(book, grid, _InlineExecutor())
    destination = Destination("STATION", _STATIONS[0].point)

    first = nav.next_waypoint(0.0, 0.0, destination)

    assert first is not None
    assert first.final is False
    walked = 0
    while first is not None and not first.final:
        nav.reached(first)
        walked += 1
        first = nav.next_waypoint(0.0, 0.0, destination)
    assert walked >= 1
    assert first is not None
    assert first.point == _STATIONS[0].point
    assert first.final is True


def test_a_trip_that_starts_and_ends_at_the_same_stop_is_a_single_step() -> None:
    """Given a robot at a station heading to that same station, when asked,
    then the route is the station itself."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    nav = GridNavigator(book, grid, _InlineExecutor())
    destination = Destination("STATION", _STATIONS[0].point)

    waypoint = nav.next_waypoint(5.0, 5.0, destination)

    assert waypoint == Waypoint(_STATIONS[0].point, final=False)


def test_an_off_stop_start_plans_on_demand_and_holds_until_the_plan_is_ready() -> None:
    """Given a robot away from every stop, when it asks,
    then the plan runs off the core and its answer is used."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    executor = _NeverExecutor()
    clock = _Clock()
    nav = GridNavigator(book, grid, executor, clock=clock)
    destination = Destination("STATION", _STATIONS[1].point)

    assert nav.next_waypoint(12.0, 2.0, destination) is None
    assert len(executor.futures) == 1
    assert nav.next_waypoint(12.0, 2.0, destination) is None


def test_an_on_demand_plan_that_finds_a_path_is_followed() -> None:
    """Given an off-stop start with a plan ready, when asked,
    then the first waypoint is the planned start."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    nav = GridNavigator(book, grid, _InlineExecutor(), clock=_Clock())
    destination = Destination("STATION", _STATIONS[1].point)

    waypoint = nav.next_waypoint(12.0, 2.0, destination)

    assert waypoint is not None
    assert waypoint.point == Point(12.0, 2.0)


def test_a_plan_that_finds_no_path_makes_the_destination_unreachable_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given a plan with no path, when asked,
    then the robot is held for good and the fact is logged once."""
    site_map = _open_map()
    _, book = _grid_and_book(site_map)
    no_free_cell = OccupancyGrid(CELL_M, 4, 4, 0.0, 0.0, bytes([1]) * 16)
    nav = GridNavigator(book, no_free_cell, _InlineExecutor(), clock=_Clock())
    destination = Destination("STATION", _STATIONS[1].point)

    with caplog.at_level(logging.WARNING, logger="fleet_agent.sim"):
        assert nav.next_waypoint(12.0, 2.0, destination) is None
        assert nav.next_waypoint(12.0, 2.0, destination) is None

    unreachable = [r for r in caplog.records if r.getMessage() == "sim.route_unreachable"]
    assert len(unreachable) == 1


def test_a_plan_that_takes_longer_than_the_timeout_is_given_up() -> None:
    """Given a plan that never finishes, when the timeout passes,
    then the destination is unreachable and the plan cancelled."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    executor = _NeverExecutor()
    clock = _Clock()
    nav = GridNavigator(book, grid, executor, clock=clock)
    destination = Destination("STATION", _STATIONS[1].point)
    nav.next_waypoint(12.0, 2.0, destination)

    clock.now = navigator_module.PLAN_TIMEOUT_S + 1.0

    assert nav.next_waypoint(12.0, 2.0, destination) is None
    assert executor.futures[0].cancelled()


def test_a_destination_the_book_cannot_reach_is_unreachable_without_planning() -> None:
    """Given a pair of stops with no route in the book, when a trip between them starts,
    then it is unreachable."""
    site_map = _open_map()
    grid, _ = _grid_and_book(site_map)
    book = RouteBook(
        {"charger": _CHARGER, "station/pick": _STATIONS[0].point},
        {},
        (("charger", "station/pick"),),
    )
    nav = GridNavigator(book, grid, _InlineExecutor(), clock=_Clock())

    assert nav.next_waypoint(0.0, 0.0, Destination("STATION", _STATIONS[0].point)) is None


def test_the_same_destination_keeps_walking_the_same_route() -> None:
    """Given a route under way, when the same destination is asked again,
    then the walk continues from the cursor."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    nav = GridNavigator(book, grid, _InlineExecutor())
    destination = Destination("STATION", _STATIONS[0].point)
    waypoint = nav.next_waypoint(5.0, 5.0, destination)
    assert waypoint is not None
    nav.reached(waypoint)

    again = nav.next_waypoint(5.0, 5.0, destination)

    assert again == Waypoint(_STATIONS[0].point, final=True)


def test_a_stop_key_is_only_matched_within_the_tolerance() -> None:
    """Given a robot 0.9 m from a stop, when it asks, then it plans from its own position,
    not from the book."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    nav = GridNavigator(book, grid, _InlineExecutor(), clock=_Clock())

    waypoint = nav.next_waypoint(5.9, 5.0, Destination("STATION", _STATIONS[1].point))

    assert waypoint is not None
    assert waypoint.point == Point(5.9, 5.0)


def test_the_navigator_uses_the_default_clock_when_none_is_given() -> None:
    """Given no clock, when a navigator is built, then it runs with the monotonic clock."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)

    nav = GridNavigator(book, grid, _InlineExecutor())

    assert nav.next_waypoint(0.0, 0.0, Destination("STATION", _STATIONS[0].point)) is not None


def test_plan_path_is_the_planner_the_navigator_runs_in_the_thread() -> None:
    """Given the planner, when called directly on the open map,
    then it returns the start and the goal."""
    site_map = _open_map()
    grid, _ = _grid_and_book(site_map)

    path = plan_path(grid, Point(12.0, 2.0), Point(20.0, 20.0))

    assert path is not None
    assert path[0] == Point(12.0, 2.0)
    assert path[-1] == Point(20.0, 20.0)


# Mission driver -----------------------------------------------------------------------------------


def test_an_idle_robot_with_charge_gets_a_mission_to_two_distinct_stations() -> None:
    """Given an idle robot with enough charge, when ticked,
    then it is given a mission to two distinct stations."""
    core = _FakeCore("IDLE", battery=80.0)
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS)

    driver.tick(core, 0)

    assert len(core.missions) == 1
    mission_id, stops = core.missions[0]
    assert mission_id == "m-sim-01-0001"
    assert len(stops) == 2
    assert stops[0] != stops[1]


def test_a_robot_below_the_mission_threshold_gets_no_mission() -> None:
    """Given an idle robot just below the threshold, when ticked, then it gets no mission."""
    core = _FakeCore("IDLE", battery=MISSION_MIN_BATTERY_PERCENT - 1.0)
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS)

    driver.tick(core, 0)

    assert core.missions == []


def test_an_idle_robot_under_operator_control_gets_no_mission_until_it_is_released() -> None:
    """Given an idle robot whose lock is held, when ticked, then no mission starts.

    After the release, the next tick gives it one.
    """
    core = _FakeCore("IDLE", battery=80.0)
    core.lock_held = True
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS)

    driver.tick(core, 0)
    assert core.missions == []

    core.lock_held = False
    driver.tick(core, 1000)
    assert len(core.missions) == 1


@pytest.mark.parametrize("state", ["MOVING", "BLOCKED", "ESTOP", "CHARGING"])
def test_a_robot_that_is_not_idle_gets_no_mission(state: ReportedState) -> None:
    """Given a robot in a state other than IDLE or WORKING, when ticked,
    then no mission is assigned."""
    core = _FakeCore(state, battery=90.0)
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS)

    driver.tick(core, 0)

    assert core.missions == []
    assert core.finished == 0


def test_a_working_robot_finishes_its_work_after_the_dwell() -> None:
    """Given a robot that starts working, when the dwell has passed, then its work is finished,
    and not before."""
    core = _FakeCore("WORKING", battery=80.0)
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS, dwell_ms=(1000, 1000))

    driver.tick(core, 0)
    driver.tick(core, 999)
    assert core.finished == 0
    driver.tick(core, 1000)

    assert core.finished == 1


def test_a_robot_that_leaves_work_restarts_the_dwell_on_its_next_session() -> None:
    """Given a robot whose work ended, when it works again,
    then the dwell is timed from the new session."""
    core = _FakeCore("WORKING", battery=80.0)
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS, dwell_ms=(500, 500))
    driver.tick(core, 0)
    driver.tick(core, 500)
    core.state = "MOVING"
    driver.tick(core, 600)
    core.state = "WORKING"

    driver.tick(core, 700)
    driver.tick(core, 1100)

    assert core.finished == 1
    driver.tick(core, 1200)
    assert core.finished == 2


def test_mission_identifiers_keep_counting_and_stay_inside_the_protocol_pattern() -> None:
    """Given an idle robot that takes several missions, when each one ends before the next,
    then the identifiers count up and match the pattern."""
    core = _FakeCore("IDLE", battery=80.0)
    driver = MissionDriver("sim-01", random.Random(7), _STATIONS)

    for index in range(3):
        driver.tick(core, index)
        core.end_mission("IDLE")

    identifiers = [mission_id for mission_id, _ in core.missions]
    assert identifiers == ["m-sim-01-0001", "m-sim-01-0002", "m-sim-01-0003"]


def test_a_refused_mission_does_not_use_up_its_identifier() -> None:
    """Given a core that refuses a mission, when the next one is accepted,
    then it reuses the identifier."""
    core = _FakeCore("IDLE", battery=80.0)
    core.accept_missions = False
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS)
    driver.tick(core, 0)
    core.accept_missions = True

    driver.tick(core, 1)

    assert [mission_id for mission_id, _ in core.missions] == ["m-sim-01-0001", "m-sim-01-0001"]


def test_a_mission_driver_needs_two_stations_and_a_valid_dwell_range() -> None:
    """Given too few stations or an empty dwell range, when a driver is built, then it refuses."""
    with pytest.raises(ValueError, match="two stations"):
        MissionDriver("sim-01", random.Random(1), _STATIONS[:1])
    with pytest.raises(ValueError, match="dwell"):
        MissionDriver("sim-01", random.Random(1), _STATIONS, dwell_ms=(5000, 2000))


def test_the_mission_driver_drives_the_real_core_from_idle_to_a_station() -> None:
    """Given the real simulated core with the navigator, when a mission is given,
    then the robot reaches a station and works."""
    site_map = _open_map()
    grid, book = _grid_and_book(site_map)
    store = MemoryLatchStore()
    clock = FakeClock()
    transport = FakeTransport()
    core = AgentCore(
        identity=AgentIdentity(
            robot_id="sim-01",
            site_id="paris-01",
            thing_name="mfc-demo-sim-01",
            simulated=True,
            agent_version="0.1.0",
        ),
        geometry=SITE,
        battery_start=90.0,
        clock=clock,
        transport=transport,
        latch=store,
        navigator=GridNavigator(book, grid, _InlineExecutor(), clock=_Clock()),
    )
    transport.set_listener(core)
    core.boot()
    driver = MissionDriver("sim-01", random.Random(3), _STATIONS, dwell_ms=(200, 200))

    working = False
    for _ in range(4000):
        driver.tick(core, clock.monotonic_ms())
        core.tick()
        clock.advance(50)
        if core.snapshot().state == "WORKING":
            working = True
            break

    assert working
    assert core.battery_percent < 90.0


# Workstation reservations -------------------------------------------------------------------------

_THREE_STATIONS = (
    Station("pick", Point(5.0, 5.0)),
    Station("drop", Point(20.0, 20.0)),
    Station("pack", Point(10.0, 25.0)),
)


def test_a_mission_reserves_its_two_stations_and_leaves_the_third_free() -> None:
    """Given three free stations, when a robot takes a mission, then two are reserved for it."""
    core = _FakeCore("IDLE", battery=80.0)
    registry = StationRegistry(s.name for s in _THREE_STATIONS)
    driver = MissionDriver("sim-01", random.Random(1), _THREE_STATIONS, registry=registry)

    driver.tick(core, 0)

    assert len(registry.free_ids()) == 1
    assert len(core.missions) == 1


def test_two_robots_never_take_the_same_station() -> None:
    """Given two robots that share two stations, when the first takes a mission,
    then the second gets none while the first holds both stations."""
    registry = StationRegistry(s.name for s in _STATIONS)
    first = _FakeCore("IDLE", battery=80.0)
    second = _FakeCore("IDLE", battery=80.0)
    MissionDriver("sim-01", random.Random(1), _STATIONS, registry=registry).tick(first, 0)
    waiting = MissionDriver("sim-02", random.Random(2), _STATIONS, registry=registry)

    waiting.tick(second, 0)

    assert len(first.missions) == 1
    assert second.missions == []
    assert registry.free_ids() == ()


def test_a_robot_that_waits_proceeds_once_the_other_robot_releases_its_stations() -> None:
    """Given two stations and two robots, when the first mission ends and the first robot is
    off to the charger, then the waiting robot gets the stations on its next tick."""
    registry = StationRegistry(s.name for s in _STATIONS)
    first = _FakeCore("IDLE", battery=80.0)
    second = _FakeCore("IDLE", battery=80.0)
    first_driver = MissionDriver("sim-01", random.Random(1), _STATIONS, registry=registry)
    second_driver = MissionDriver("sim-02", random.Random(2), _STATIONS, registry=registry)
    first_driver.tick(first, 0)
    second_driver.tick(second, 0)
    assert second.missions == []

    first.end_mission("MOVING")
    first_driver.tick(first, 1)
    second_driver.tick(second, 1)

    assert len(first.missions) == 1
    assert len(second.missions) == 1
    assert registry.holder_of("pick") == "sim-02"


@pytest.mark.parametrize("end_state", ["IDLE", "MOVING", "TELEOP", "ESTOP"])
def test_the_stations_are_released_when_the_mission_ends_in_any_state(
    end_state: ReportedState,
) -> None:
    """Given a robot whose mission ended, whether completed, aborted, taken over or stopped by
    an e-stop, when ticked again, then its stations are free."""
    registry = StationRegistry(s.name for s in _STATIONS)
    core = _FakeCore("IDLE", battery=80.0)
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS, registry=registry)
    driver.tick(core, 0)
    core.battery = MISSION_MIN_BATTERY_PERCENT - 1.0

    core.end_mission(end_state)
    driver.tick(core, 1)

    assert registry.free_ids() == ("pick", "drop")


@pytest.mark.parametrize("held_state", ["BLOCKED", "PAUSED"])
def test_a_blocked_or_paused_robot_keeps_its_stations_because_it_resumes(
    held_state: ReportedState,
) -> None:
    """Given a robot with a mission that is blocked or paused, when ticked, then it still holds
    its stations, since the same mission resumes."""
    registry = StationRegistry(s.name for s in _STATIONS)
    core = _FakeCore("IDLE", battery=80.0)
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS, registry=registry)
    driver.tick(core, 0)

    core.state = held_state
    driver.tick(core, 1)

    assert registry.free_ids() == ()


def test_a_refused_mission_gives_its_stations_back_at_once() -> None:
    """Given a core that refuses the mission, when ticked, then the stations are not kept."""
    registry = StationRegistry(s.name for s in _STATIONS)
    core = _FakeCore("IDLE", battery=80.0)
    core.accept_missions = False
    driver = MissionDriver("sim-01", random.Random(1), _STATIONS, registry=registry)

    driver.tick(core, 0)

    assert registry.free_ids() == ("pick", "drop")


def test_a_robot_with_fewer_than_two_free_stations_stays_idle_and_takes_no_mission() -> None:
    """Given one station held by another robot, when an idle robot ticks, then it gets no mission
    and no station, and it draws no random number."""
    registry = StationRegistry(s.name for s in _THREE_STATIONS)
    registry.try_reserve("sim-09", ["pick", "pack"])
    core = _FakeCore("IDLE", battery=80.0)
    rng = random.Random(1)
    driver = MissionDriver("sim-01", rng, _THREE_STATIONS, registry=registry)
    untouched = random.Random(1).getstate()

    driver.tick(core, 0)

    assert core.missions == []
    assert registry.free_ids() == ("drop",)
    assert rng.getstate() == untouched


def test_a_seeded_run_gives_the_same_missions_every_time() -> None:
    """Given the same seed and the same tick order, when two fleets run, then the missions match."""

    def run(seed: int) -> list[tuple[str, list[Point]]]:
        """Runs three robots over the three stations for a fixed tick script.

        Args:
            seed: The seed of the drivers' random source.

        Returns:
            The missions the three robots received, in order.
        """
        registry = StationRegistry(s.name for s in _THREE_STATIONS)
        cores = [_FakeCore("IDLE", battery=80.0) for _ in range(3)]
        drivers = [
            MissionDriver(
                f"sim-0{index}",
                random.Random(seed + index),
                _THREE_STATIONS,
                registry=registry,
            )
            for index in range(3)
        ]
        for step in range(30):
            for core, driver in zip(cores, drivers, strict=True):
                driver.tick(core, step)
                if step % 2 == 1 and core.mission_id is not None:
                    core.end_mission("IDLE")
        return [mission for core in cores for mission in core.missions]

    assert run(11) == run(11)


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_robots_over_stations_never_hold_one_station_twice(seed: int) -> None:
    """Given five robots and four stations under random ticks and mission ends, when the run
    goes on, then no station is held by two active missions and the registry agrees with them."""
    stations = tuple(
        Station(name, Point(float(index) * 7.0, 3.0 * index))
        for index, name in enumerate(["pick", "drop", "pack", "load"])
    )
    by_point = {station.point: station.name for station in stations}
    registry = StationRegistry(station.name for station in stations)
    rng = random.Random(seed)
    cores = [_FakeCore("IDLE", battery=80.0) for _ in range(5)]
    drivers = [
        MissionDriver(
            f"sim-0{index}", random.Random(seed * 10 + index), stations, registry=registry
        )
        for index in range(5)
    ]

    for step in range(400):
        index = rng.randrange(len(cores))
        if rng.random() < 0.4 and cores[index].mission_id is not None:
            cores[index].end_mission(rng.choice(["IDLE", "MOVING"]))
        drivers[index].tick(cores[index], step)

        held: list[str] = []
        for core in cores:
            if core.mission_id is None:
                continue
            _, stops = core.missions[-1]
            names = [by_point[point] for point in stops]
            held.extend(names)
            assert all(registry.holder_of(name) == f"sim-0{cores.index(core)}" for name in names)
        assert len(held) == len(set(held))


# Fault injector -----------------------------------------------------------------------------------


def test_a_zero_rate_never_injects_a_fault() -> None:
    """Given a zero rate, when ticked for an hour, then no fault is injected."""
    core = _FakeCore("MOVING")
    injector = FaultInjector(random.Random(1), 0.0)

    for index in range(3600):
        injector.tick(core, index * 1000)

    assert core.faults == []


def test_a_high_rate_injects_faults_only_in_the_states_that_allow_them() -> None:
    """Given a high rate, when a moving robot is ticked, then obstacles and sensor faults appear,
    and never while charging."""
    core = _FakeCore("MOVING")
    injector = FaultInjector(random.Random(2), 3600.0)

    for index in range(400):
        injector.tick(core, index * 1000)
        if core.state == "BLOCKED":
            core.state = "MOVING"

    kinds = {kind for kind, _ in core.faults}
    assert {"OBSTACLE", "SENSOR_FAULT"} <= kinds

    charging = _FakeCore("CHARGING")
    charging.blocked_after_fault = False
    injector_c = FaultInjector(random.Random(2), 3600.0)
    for index in range(400):
        injector_c.tick(charging, index * 1000)
    assert all(kind != "BATTERY_LOW" for kind, _ in charging.faults)
    assert all(kind not in ("OBSTACLE", "SENSOR_FAULT") for kind, _ in charging.faults)


def test_a_link_loss_is_timed_within_its_range() -> None:
    """Given a robot that can lose its link, when a loss is injected,
    then its duration is in the protocol range."""
    core = _FakeCore("IDLE")
    core.blocked_after_fault = False
    injector = FaultInjector(random.Random(5), 3600.0, weights={"LINK_LOSS": 1.0})

    for index in range(200):
        injector.tick(core, index * 1000)

    durations = [duration for kind, duration in core.faults if kind == "LINK_LOSS"]
    assert durations
    assert all(LINK_LOSS_MS[0] <= d <= LINK_LOSS_MS[1] for d in durations if d is not None)


def test_a_block_the_injector_caused_is_resumed_after_its_delay() -> None:
    """Given a block the injector caused, when the delay has passed and the cause cleared,
    then the robot resumes."""
    core = _FakeCore("MOVING")
    injector = FaultInjector(random.Random(9), 3600.0, weights={"OBSTACLE": 1.0})
    injector.tick(core, 0)
    injector.tick(core, 1000)
    assert core.state == "BLOCKED"

    for now in range(2000, 2000 + RESUME_DELAY_MS[1] + 2000, 500):
        injector.tick(core, now)
        if core.resumes:
            break

    assert core.resumes >= 1
    assert core.state == "MOVING"


def test_a_resume_still_refused_is_retried_later() -> None:
    """Given a cause still present at the resume time, when ticked,
    then the resume is attempted again."""
    core = _FakeCore("BLOCKED")
    core.resume_result = False
    injector = FaultInjector(random.Random(4), 0.0)
    injector._resume_at_ms = 0
    injector.tick(core, 0)
    injector.tick(core, 500)
    assert core.resumes == 1
    injector.tick(core, 1000)

    assert core.resumes == 2


def test_a_robot_that_leaves_the_block_cancels_the_pending_resume() -> None:
    """Given a pending resume, when the robot is no longer blocked, then the resume is dropped."""
    core = _FakeCore("BLOCKED")
    injector = FaultInjector(random.Random(4), 0.0)
    injector._resume_at_ms = 0
    core.state = "IDLE"

    injector.tick(core, 0)

    assert core.resumes == 0
    assert injector._resume_at_ms is None


def test_a_fault_the_table_refuses_arms_no_resume() -> None:
    """Given a fault the state table refuses, when injected, then no resume is scheduled."""
    core = _FakeCore("MOVING")
    core.fault_result = False
    injector = FaultInjector(random.Random(1), 3600.0, weights={"OBSTACLE": 1.0})

    injector.tick(core, 0)
    injector.tick(core, 1000)

    assert core.faults
    assert injector._resume_at_ms is None


def test_a_stalled_clock_does_not_inject_a_burst_of_faults() -> None:
    """Given a very long gap between two ticks, when ticked,
    then the gap counts at most one second."""
    core = _FakeCore("MOVING")
    core.blocked_after_fault = False
    injector = FaultInjector(random.Random(1), 3600.0, weights={"OBSTACLE": 1.0})
    injector.tick(core, 0)

    injector.tick(core, 10_000_000)

    assert len(core.faults) <= 1


def test_a_repeated_tick_at_the_same_instant_injects_nothing() -> None:
    """Given two ticks at the same instant, when the second runs,
    then no time has elapsed and no fault is drawn."""
    core = _FakeCore("MOVING")
    injector = FaultInjector(random.Random(1), 3600.0, weights={"OBSTACLE": 1.0})
    injector.tick(core, 5)

    injector.tick(core, 5)

    assert core.faults == []


@pytest.mark.parametrize(
    ("rate", "weights"),
    [
        (-1.0, None),
        (float("inf"), None),
        (float("nan"), None),
        (1.0, {"OBSTACLE": -1.0}),
        (1.0, {"OBSTACLE": 0.0}),
    ],
)
def test_an_invalid_rate_or_weight_is_refused(
    rate: float, weights: dict[Literal["OBSTACLE"], float] | None
) -> None:
    """Given a rate or weights out of range, when an injector is built, then it refuses."""
    kwargs: dict[str, Any] = {} if weights is None else {"weights": weights}
    with pytest.raises(ValueError, match="fault"):
        FaultInjector(random.Random(1), rate, **kwargs)
