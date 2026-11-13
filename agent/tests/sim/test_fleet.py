"""Tests of the simulated fleet: refusals before connecting, the run, the stops and exit codes.

The fleet runs the production agent with fake transports, on a small map so that the route book is
quick to plan. The runner's goodbye wait is shortened: the fake transport never completes it.
"""

from __future__ import annotations

import asyncio
import copy
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, cast

import pytest

from fleet_agent.core.model import Point
from fleet_agent.runtime import runner
from fleet_agent.runtime.runner import (
    EXIT_CONFIG,
    EXIT_FORCED,
    EXIT_OK,
    EXIT_SOFTWARE,
    RunControls,
)
from fleet_agent.sim import fleet
from fleet_agent.sim.fleet import (
    EXIT_BUSY,
    SimConfig,
    SimSetupError,
    _controls_for,
    _exit_code,
    _parameter_refusal,
    _prepare,
    _RobotPlan,
    _run_robot,
    _start_points,
    _StopRequests,
    _stops_of,
    _supervise,
    run_fleet,
)
from fleet_agent.sim.grid import OccupancyGrid
from fleet_agent.sim.lock import InstanceLock, default_lock_path
from fleet_agent.sim.navigator import GridNavigator
from fleet_agent.sim.site_map import SiteMap, Station
from fleet_agent.sim.stations import StationRegistry
from fleet_agent.sim.traffic import AvoidingNavigator, TrafficBoard
from tests.core.fakes import FakeTransport
from tests.sim.support import SAMPLE_MAP_PATH, write_kit, write_map

_SMALL_MAP: dict[str, object] = {
    "type": "FeatureCollection",
    "fleet": {"crs": "local-metric", "version": 1},
    "features": [
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            },
            "properties": {"kind": "wall"},
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [2, 2]},
            "properties": {"kind": "charger"},
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [8, 2]},
            "properties": {"kind": "workstation", "name": "pick"},
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [8, 8]},
            "properties": {"kind": "workstation", "name": "drop"},
        },
    ],
}


def _with_feature(feature: dict[str, object]) -> dict[str, object]:
    """Returns a copy of the small map with one more feature.

    Args:
        feature: The feature to add.

    Returns:
        The new document.
    """
    document = copy.deepcopy(_SMALL_MAP)
    features = document["features"]
    assert isinstance(features, list)
    features.append(feature)
    return document


@pytest.fixture(autouse=True)
def _private_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Points the lock at a private state directory and shortens the runner's goodbye wait.

    Args:
        monkeypatch: The fixture that restores the patched values.
        tmp_path: The test's private directory.
    """
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setattr(runner, "GOODBYE_WAIT_S", 0.01)


@pytest.fixture
def small_map(tmp_path: Path) -> Path:
    """Writes the small two-station map of the fleet tests.

    Args:
        tmp_path: The test's private directory.

    Returns:
        The map file.
    """
    return write_map(tmp_path / "small.geojson", _SMALL_MAP)


def _config(tmp_path: Path, map_path: Path, **overrides: object) -> SimConfig:
    """Builds the configuration of a run over the test's kit root.

    Args:
        tmp_path: The test's private directory, which holds the kit root.
        map_path: The map file.
        **overrides: Fields to change from the defaults.

    Returns:
        The configuration.
    """
    values: dict[str, Any] = {
        "count": 2,
        "site_id": "paris-01",
        "prefix": "sim",
        "map_path": map_path,
        "kit_root": tmp_path / "kits",
        "seed": 1,
        "fault_rate_per_hour": 0.0,
        "max_runtime_s": 1,
        "stagger_ms": 0,
        "speed_mps": 1.0,
    }
    values.update(overrides)
    return SimConfig(**values)


class _RecordingFactory:
    """A transport factory that hands out fake transports and remembers which robots it built
    for."""

    def __init__(self) -> None:
        """Starts with no transport built."""
        self.robots: list[str] = []

    def __call__(self, kit: Any, port: int, loop: object) -> FakeTransport:  # noqa: ANN401
        """Builds a fake transport for a kit.

        Args:
            kit: The loaded kit. Its identifier is recorded.
            port: The broker port. Unused.
            loop: The event loop. Unused.

        Returns:
            A fresh fake transport.
        """
        del port, loop
        self.robots.append(kit.config.robot_id)
        return FakeTransport()


class _RefusingLock:
    """A lock that refuses to be taken, as the lock of a state directory another user owns does."""

    def __init__(self, path: Path) -> None:
        """Ignores the path.

        Args:
            path: The lock file. Unused.
        """
        del path

    def __enter__(self) -> None:
        """Refuses the lock.

        Raises:
            PermissionError: Always.
        """
        raise PermissionError

    def __exit__(self, *exc: object) -> None:
        """Does nothing: the lock was never taken.

        Args:
            *exc: The exception of the block. Unused.
        """
        del exc


class _FakeRuntime:
    """A runtime stand-in that counts the stop requests it receives."""

    def __init__(self) -> None:
        """Starts with no request."""
        self.stops = 0

    def request_stop(self) -> None:
        """Counts one stop request."""
        self.stops += 1


def _controls_with(runtime: _FakeRuntime | None) -> RunControls:
    """Builds the hooks of a robot whose runtime is the given one, for the supervisor tests.

    Args:
        runtime: The runtime the hooks expose, or None before it is built.

    Returns:
        The hooks.
    """
    controls = RunControls(install_signals=False)
    controls.runtime = cast(Any, runtime)
    return controls


def _supervisor_config(max_runtime_s: int) -> SimConfig:
    """Builds a configuration for the supervisor tests, with the given deadline.

    Args:
        max_runtime_s: The deadline, in seconds.

    Returns:
        The configuration.
    """
    return SimConfig(
        count=1,
        site_id="paris-01",
        prefix="sim",
        map_path=Path("/unused.geojson"),
        kit_root=Path("/unused"),
        max_runtime_s=max_runtime_s,
    )


# Refusals before anything connects ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"count": 0}, "COUNT_OR_PREFIX"),
        ({"count": 21}, "COUNT_OR_PREFIX"),
        ({"fault_rate_per_hour": -1.0}, "FAULT_RATE"),
        ({"fault_rate_per_hour": 1001.0}, "FAULT_RATE"),
        ({"max_runtime_s": 0}, "MAX_RUNTIME"),
        ({"max_runtime_s": 14401}, "MAX_RUNTIME_CAP"),
        ({"stagger_ms": -5}, "STAGGER"),
        ({"stagger_ms": 10_001}, "STAGGER"),
    ],
)
def test_out_of_range_parameters_are_refused(overrides: dict[str, Any], reason: str) -> None:
    """Given a parameter out of range, when checked, then the reason names that parameter."""
    values: dict[str, Any] = {
        "count": 2,
        "site_id": "paris-01",
        "prefix": "sim",
        "map_path": Path("/unused.geojson"),
        "kit_root": Path("/unused"),
        "fault_rate_per_hour": 6.0,
        "max_runtime_s": 7200,
        "stagger_ms": 250,
    }
    values.update(overrides)

    assert _parameter_refusal(SimConfig(**values)) == reason


def test_usable_parameters_pass_the_check() -> None:
    """Given the default parameters for twenty robots, when checked, then no refusal is returned."""
    config = _supervisor_config(7200)
    config = SimConfig(
        count=20,
        site_id=config.site_id,
        prefix=config.prefix,
        map_path=config.map_path,
        kit_root=config.kit_root,
    )

    assert _parameter_refusal(config) is None


def test_the_four_hour_cap_itself_is_usable() -> None:
    """Given a runtime of exactly the four-hour cap, when checked, then it is accepted."""
    assert _parameter_refusal(_supervisor_config(14400)) is None


def test_an_out_of_range_count_exits_78_before_the_lock_is_taken(
    tmp_path: Path, small_map: Path
) -> None:
    """Given a count of zero, when the fleet runs, then it exits 78 and no transport is built."""
    factory = _RecordingFactory()

    code = asyncio.run(run_fleet(_config(tmp_path, small_map, count=0), transport_factory=factory))

    assert code == EXIT_CONFIG
    assert factory.robots == []


def test_a_second_simulator_on_this_host_exits_75_and_connects_nothing(
    tmp_path: Path, small_map: Path
) -> None:
    """Given another simulator holds the lock, when the fleet runs,
    then it exits 75 without connecting."""
    factory = _RecordingFactory()
    write_kit(tmp_path / "kits", "sim-01", site_id="paris-01")
    with InstanceLock(default_lock_path()):
        code = asyncio.run(
            run_fleet(_config(tmp_path, small_map, count=1), transport_factory=factory)
        )

    assert code == EXIT_BUSY
    assert factory.robots == []


def test_a_state_directory_refused_by_the_lock_exits_78(
    tmp_path: Path,
    small_map: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given a state directory another user owns, when the fleet runs,
    then it exits 78 with the reason logged."""
    monkeypatch.setattr(fleet, "InstanceLock", _RefusingLock)

    with caplog.at_level(logging.ERROR, logger="fleet_agent.sim"):
        code = asyncio.run(
            run_fleet(_config(tmp_path, small_map, count=1), transport_factory=_RecordingFactory())
        )

    assert code == EXIT_CONFIG
    assert any(getattr(r, "reason", None) == "STATE_DIRECTORY" for r in caplog.records)


@pytest.mark.parametrize(
    ("kits", "reason"),
    [
        ([("sim-01", {})], "KIT_REFUSED"),  # sim-02 is missing
        ([("sim-01", {"simulated": False}), ("sim-02", {})], "KIT_NOT_SIMULATED"),
        ([("sim-01", {"site_id": "lyon-02"}), ("sim-02", {})], "KIT_SITE"),
    ],
)
def test_a_kit_that_is_missing_real_or_for_another_site_exits_78_before_connecting(
    tmp_path: Path,
    small_map: Path,
    kits: list[tuple[str, dict[str, Any]]],
    reason: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given a kit that is missing, real or for another site, when the fleet runs,
    then it exits 78 with that reason."""
    for robot_id, options in kits:
        write_kit(tmp_path / "kits", robot_id, **options)
    factory = _RecordingFactory()

    with caplog.at_level(logging.ERROR, logger="fleet_agent.sim"):
        code = asyncio.run(
            run_fleet(_config(tmp_path, small_map, count=2), transport_factory=factory)
        )

    assert code == EXIT_CONFIG
    assert factory.robots == []
    assert any(getattr(r, "reason", None) == reason for r in caplog.records)


def test_a_map_that_cannot_be_read_exits_78(tmp_path: Path) -> None:
    """Given a map file that does not exist, when the fleet runs, then it exits 78."""
    code = asyncio.run(
        run_fleet(
            _config(tmp_path, tmp_path / "absent.geojson"),
            transport_factory=_RecordingFactory(),
        )
    )

    assert code == EXIT_CONFIG


def test_a_station_inside_an_obstacle_is_refused_before_connecting(tmp_path: Path) -> None:
    """Given a station that an obstacle covers, when the fleet runs,
    then it exits 78 and connects nothing."""
    blocking = {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[7.5, 1.5], [8.5, 1.5], [8.5, 2.5], [7.5, 2.5], [7.5, 1.5]]],
        },
        "properties": {"kind": "obstacle"},
    }
    factory = _RecordingFactory()
    map_path = write_map(tmp_path / "blocked.geojson", _with_feature(blocking))

    code = asyncio.run(run_fleet(_config(tmp_path, map_path), transport_factory=factory))

    assert code == EXIT_CONFIG
    assert factory.robots == []


def test_a_station_sealed_inside_walls_is_refused_as_unreachable(tmp_path: Path) -> None:
    """Given a station inside a closed wall ring, when the fleet runs,
    then it exits 78 because no route reaches it."""
    ring = {
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": [[6.5, 6.5], [9.5, 6.5], [9.5, 9.5], [6.5, 9.5], [6.5, 6.5]],
        },
        "properties": {"kind": "wall"},
    }
    factory = _RecordingFactory()
    map_path = write_map(tmp_path / "sealed.geojson", _with_feature(ring))

    code = asyncio.run(run_fleet(_config(tmp_path, map_path), transport_factory=factory))

    assert code == EXIT_CONFIG
    assert factory.robots == []


def test_the_sample_map_loads_and_only_the_missing_kit_refuses_the_run(tmp_path: Path) -> None:
    """Given the protocol's sample map and no kit, when the fleet runs,
    then the map is accepted and the kit refuses it."""
    factory = _RecordingFactory()

    code = asyncio.run(
        run_fleet(_config(tmp_path, SAMPLE_MAP_PATH, count=1), transport_factory=factory)
    )

    assert code == EXIT_CONFIG
    assert factory.robots == []


# The run ------------------------------------------------------------------------------------------


async def _stop_during_stagger(
    robot: _RobotPlan,
    config: SimConfig,
    factory: _RecordingFactory,
    registry: StationRegistry,
) -> int:
    """Starts a robot with a long stagger, requests a stop while it waits, and returns its code.

    Args:
        robot: The plan of the robot.
        config: The run's configuration, whose stagger is long.
        factory: The transport factory, which must not be called.
        registry: The workstation reservations of the run.

    Returns:
        The exit code of the robot.
    """
    requests = _StopRequests()
    task = asyncio.create_task(
        _run_robot(
            robot,
            RunControls(install_signals=False),
            1,
            config,
            factory,
            requests,
            registry,
            _empty_board(),
        )
    )
    await asyncio.sleep(0.05)
    requests.signal_received()
    return await asyncio.wait_for(task, timeout=2.0)


def test_a_robot_still_in_its_stagger_exits_ok_and_never_connects(
    tmp_path: Path, small_map: Path
) -> None:
    """Given a robot whose stagger is ten seconds, when a stop arrives after 50 ms,
    then it returns EXIT_OK at once and no transport is built for it."""
    write_kit(tmp_path / "kits", "sim-01")
    write_kit(tmp_path / "kits", "sim-02")
    config = _config(tmp_path, small_map, count=2, stagger_ms=10_000)
    robot = _prepare(config, ["sim-01", "sim-02"]).robots[1]
    registry = StationRegistry(["pick", "drop"])
    registry.try_reserve("sim-02", ["pick", "drop"])
    factory = _RecordingFactory()

    code = asyncio.run(_stop_during_stagger(robot, config, factory, registry))
    assert registry.free_ids() == ("pick", "drop")

    assert code == EXIT_OK
    assert factory.robots == []


def test_two_robots_run_until_the_deadline_and_exit_cleanly(
    tmp_path: Path, small_map: Path
) -> None:
    """Given two simulated kits, when the fleet runs to its one-second deadline,
    then both connect and the run exits 0."""
    write_kit(tmp_path / "kits", "sim-01")
    write_kit(tmp_path / "kits", "sim-02")
    factory = _RecordingFactory()

    code = asyncio.run(run_fleet(_config(tmp_path, small_map, count=2), transport_factory=factory))

    assert code == EXIT_OK
    assert sorted(factory.robots) == ["sim-01", "sim-02"]


def test_a_run_with_faults_and_a_stagger_still_exits_cleanly(
    tmp_path: Path, small_map: Path
) -> None:
    """Given faults enabled and a stagger between the robots, when the fleet runs,
    then it stops on its deadline."""
    write_kit(tmp_path / "kits", "sim-01")
    write_kit(tmp_path / "kits", "sim-02")

    code = asyncio.run(
        run_fleet(
            _config(
                tmp_path,
                small_map,
                count=2,
                fault_rate_per_hour=600.0,
                stagger_ms=100,
            ),
            transport_factory=_RecordingFactory(),
        )
    )

    assert code == EXIT_OK


def test_a_robot_whose_agent_raises_is_a_software_failure_and_the_error_type_is_logged(
    monkeypatch: pytest.MonkeyPatch,
    small_map: Path,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given an agent that raises, when the fleet runs,
    then the run exits 70 and the log names the error type only."""

    async def raising(*args: object, **kwargs: object) -> int:
        """Stands in for the agent and raises.

        Args:
            *args: The positional arguments. Unused.
            **kwargs: The keyword arguments. Unused.

        Raises:
            ValueError: Always.
        """
        del args, kwargs
        raise ValueError("boom")

    monkeypatch.setattr(fleet, "run_agent", raising)
    write_kit(tmp_path / "kits", "sim-01")
    write_kit(tmp_path / "kits", "sim-02")

    with caplog.at_level(logging.ERROR, logger="fleet_agent.sim"):
        code = asyncio.run(
            run_fleet(_config(tmp_path, small_map, count=2), transport_factory=_RecordingFactory())
        )

    assert code == EXIT_SOFTWARE
    failures = [r for r in caplog.records if r.getMessage() == "sim.robot_failed"]
    assert len(failures) == 2
    assert all(getattr(r, "errorName", None) == "ValueError" for r in failures)
    assert all("boom" not in r.getMessage() for r in caplog.records)


def test_a_halted_robot_is_logged_and_not_restarted(
    monkeypatch: pytest.MonkeyPatch,
    small_map: Path,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Given an agent that halts with 70, when the fleet runs, then each robot runs once,
    is logged, and the run exits 70."""
    calls: list[str] = []

    async def halting(settings: Any, **kwargs: object) -> int:  # noqa: ANN401
        """Stands in for the agent: records the robot and reports a halt.

        Args:
            settings: The robot's settings, whose identifier is recorded.
            **kwargs: The hooks. Unused.

        Returns:
            The software exit code.
        """
        del kwargs
        calls.append(settings.robot_id)
        return EXIT_SOFTWARE

    monkeypatch.setattr(fleet, "run_agent", halting)
    write_kit(tmp_path / "kits", "sim-01")
    write_kit(tmp_path / "kits", "sim-02")

    with caplog.at_level(logging.ERROR, logger="fleet_agent.sim"):
        code = asyncio.run(
            run_fleet(_config(tmp_path, small_map, count=2), transport_factory=_RecordingFactory())
        )

    assert code == EXIT_SOFTWARE
    assert sorted(calls) == ["sim-01", "sim-02"]
    assert sum(1 for r in caplog.records if r.getMessage() == "sim.robot_halted") == 2


# Stops and exit codes -----------------------------------------------------------------------------


def test_the_exit_code_is_zero_when_every_robot_ended_cleanly_or_forced() -> None:
    """Given robots that ended with 0 or 130, when combined, then the run exits 0."""
    assert _exit_code([EXIT_OK, EXIT_FORCED]) == EXIT_OK


def test_the_exit_code_is_the_highest_other_code_when_a_robot_failed() -> None:
    """Given robots that exited 70 and 78, when combined, then the run exits with the highest,
    78."""
    assert _exit_code([EXIT_SOFTWARE, EXIT_CONFIG, EXIT_OK]) == EXIT_CONFIG


def test_a_first_signal_is_graceful_and_a_second_one_is_a_forced_request() -> None:
    """Given stop signals, when counted, then the first is one request and the second makes two."""
    requests = _StopRequests()

    requests.signal_received()
    assert requests.requests == 1
    requests.signal_received()
    assert requests.requests == 2


def test_the_deadline_counts_as_one_graceful_request_only() -> None:
    """Given a run at its deadline, when counted, then it is one graceful request,
    and a later signal is the second."""
    requests = _StopRequests()

    requests.deadline_reached()
    requests.deadline_reached()
    assert requests.requests == 1
    requests.signal_received()
    assert requests.requests == 2


def test_the_supervisor_forwards_each_request_to_a_robot_once_per_count() -> None:
    """Given a robot whose runtime is built, when one then a second request arrives,
    then it gets one then a second stop."""

    async def scenario() -> tuple[int, int]:
        """Runs the supervisor between two requests.

        Returns:
            The stops the runtime received after the first request and after the second.
        """
        runtime = _FakeRuntime()
        requests = _StopRequests()
        task = asyncio.create_task(
            _supervise([_controls_with(runtime)], requests, _supervisor_config(7200))
        )
        requests.signal_received()
        await asyncio.sleep(0.25)
        first = runtime.stops
        requests.signal_received()
        await asyncio.sleep(0.25)
        task.cancel()
        return first, runtime.stops

    assert asyncio.run(scenario()) == (1, 2)


def test_a_robot_whose_runtime_appears_after_the_request_still_receives_it() -> None:
    """Given a request before a robot's runtime exists, when the runtime appears,
    then the robot is stopped."""

    async def scenario() -> int:
        """Requests a stop, then builds the runtime while the supervisor runs.

        Returns:
            The stops the late runtime received.
        """
        controls = _controls_with(None)
        requests = _StopRequests()
        requests.signal_received()
        task = asyncio.create_task(_supervise([controls], requests, _supervisor_config(7200)))
        await asyncio.sleep(0.05)
        late = _FakeRuntime()
        controls.runtime = cast(Any, late)
        await asyncio.sleep(0.25)
        task.cancel()
        return late.stops

    assert asyncio.run(scenario()) == 1


def test_the_supervisor_warns_before_the_deadline_and_then_stops_gracefully(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Given a deadline inside the warning window, when the supervisor runs,
    then it warns and requests one stop."""
    monkeypatch.setattr(fleet, "WARN_BEFORE_DEADLINE_S", 0.2)

    async def scenario() -> int:
        """Runs the supervisor until the one-second deadline passes.

        Returns:
            The stops the runtime received.
        """
        runtime = _FakeRuntime()
        task = asyncio.create_task(
            _supervise([_controls_with(runtime)], _StopRequests(), _supervisor_config(1))
        )
        await asyncio.sleep(1.3)
        task.cancel()
        return runtime.stops

    with caplog.at_level(logging.WARNING, logger="fleet_agent.sim"):
        stops = asyncio.run(scenario())

    assert stops == 1
    assert any(r.getMessage() == "sim.deadline_soon" for r in caplog.records)


# Plan helpers -------------------------------------------------------------------------------------


def test_a_station_named_charger_cannot_take_the_charger_key() -> None:
    """Given a station named charger, when the stops are keyed,
    then the charger keeps its own key."""
    site_map = SiteMap(
        charger=Point(1.0, 1.0),
        stations=(Station("charger", Point(5.0, 5.0)), Station("pick", Point(7.0, 7.0))),
        walls=(),
        obstacles=(),
        nogos=(),
        bounds=(0.0, 0.0, 10.0, 10.0),
    )

    stops = _stops_of(site_map)

    assert stops["charger"] == Point(1.0, 1.0)
    assert stops["station/charger"] == Point(5.0, 5.0)
    assert len(stops) == 3


def test_start_points_fail_when_no_free_cell_is_near_the_charger() -> None:
    """Given a grid with no free cell, when start points are asked for, then the setup fails."""
    grid = OccupancyGrid(0.25, 8, 8, 0.0, 0.0, bytes([1]) * 64)

    with pytest.raises(SimSetupError) as refused:
        _start_points(grid, Point(1.0, 1.0), 1)

    assert refused.value.code == "NO_START_POSITION"


def test_start_points_are_free_distinct_and_nearest_ring_first() -> None:
    """Given an open grid, when start points are asked for,
    then ten free and distinct points come from the nearest rings."""
    grid = OccupancyGrid(0.25, 80, 80, 0.0, 0.0, bytes(80 * 80))

    points = _start_points(grid, Point(10.0, 10.0), 10)

    assert len(points) == 10
    assert len(set(points)) == 10
    assert all(grid.point_free(point) for point in points)
    assert all(abs(p.x - 10.0) <= 0.6 + 1e-9 and abs(p.y - 10.0) <= 0.6 + 1e-9 for p in points[:8])


# Workstation reservations of a robot that ends ---------------------------------------------------


def _empty_board() -> TrafficBoard:
    """Builds a traffic board with no robot on it, for the tests that do not drive one.

    Returns:
        A board whose parking area is a point, so no robot is parked by accident.
    """
    return TrafficBoard(parking_centre=Point(0.0, 0.0), parking_radius_m=0.0)


def _reserved_robot(
    tmp_path: Path, small_map: Path
) -> tuple[_RobotPlan, SimConfig, StationRegistry]:
    """Plans one robot that already holds both workstations of the small map.

    Args:
        tmp_path: The test's directory, which holds the kit.
        small_map: The small map, whose workstations are "pick" and "drop".

    Returns:
        The robot's plan, the run's configuration, and the registry holding its reservation.
    """
    write_kit(tmp_path / "kits", "sim-01")
    config = _config(tmp_path, small_map, count=1)
    robot = _prepare(config, ["sim-01"]).robots[0]
    registry = StationRegistry(["pick", "drop"])
    assert registry.try_reserve("sim-01", ["pick", "drop"])
    return robot, config, registry


def _agent_that_ends_with(monkeypatch: pytest.MonkeyPatch, outcome: int | Exception) -> None:
    """Replaces the agent with one that returns the exit code, or raises the exception.

    Args:
        monkeypatch: The fixture that swaps the agent.
        outcome: The exit code the agent returns, or the exception it raises.
    """

    async def agent(*args: object, **kwargs: object) -> int:
        """Stands in for the agent: returns or raises the outcome the test chose.

        Args:
            *args: The positional arguments. Unused.
            **kwargs: The keyword arguments. Unused.

        Returns:
            The exit code the test chose.

        Raises:
            Exception: The exception the test chose.
        """
        del args, kwargs
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(fleet, "run_agent", agent)


@pytest.mark.parametrize(
    "outcome",
    [EXIT_SOFTWARE, EXIT_OK, ValueError("boom")],
    ids=["halted", "stopped", "failed"],
)
def test_a_robot_that_ends_releases_its_workstations(
    monkeypatch: pytest.MonkeyPatch,
    small_map: Path,
    tmp_path: Path,
    outcome: int | Exception,
) -> None:
    """Given a robot holding both workstations, when its agent halts, stops or fails,
    then both workstations are free again, so no reservation outlives its robot."""
    _agent_that_ends_with(monkeypatch, outcome)
    robot, config, registry = _reserved_robot(tmp_path, small_map)

    asyncio.run(
        _run_robot(
            robot,
            RunControls(install_signals=False),
            0,
            config,
            _RecordingFactory(),
            _StopRequests(),
            registry,
            _empty_board(),
        )
    )

    assert registry.free_ids() == ("pick", "drop")


# Traffic between simulated robots ----------------------------------------------------------------


def test_a_robot_navigates_through_the_traffic_board_over_the_grid_planner(
    tmp_path: Path, small_map: Path
) -> None:
    """Given a planned robot and the fleet's board, when its controls are built, then its
    navigator is the traffic wrapper over the grid planner, so no route bypasses the board."""
    write_kit(tmp_path / "kits", "sim-01")
    config = _config(tmp_path, small_map, count=1)
    plan = _prepare(config, ["sim-01"])
    registry = StationRegistry(["pick", "drop"])
    board = TrafficBoard(parking_centre=plan.charger, parking_radius_m=1.0)
    with ThreadPoolExecutor(max_workers=1) as executor:
        controls = _controls_for(plan.robots[0], plan, config, executor, registry, board)

    navigator = controls.navigator
    assert isinstance(navigator, AvoidingNavigator)
    assert isinstance(navigator._inner, GridNavigator)


def test_a_robot_that_ends_leaves_the_traffic_board(
    monkeypatch: pytest.MonkeyPatch, small_map: Path, tmp_path: Path
) -> None:
    """Given a robot on the traffic board, when its agent ends, then it is no longer on the board,
    so the others no longer yield to a position it does not hold."""
    _agent_that_ends_with(monkeypatch, EXIT_OK)
    robot, config, registry = _reserved_robot(tmp_path, small_map)
    board = TrafficBoard(parking_centre=Point(0.0, 0.0), parking_radius_m=0.0)
    board.place("sim-01", Point(5.0, 5.0))

    asyncio.run(
        _run_robot(
            robot,
            RunControls(install_signals=False),
            0,
            config,
            _RecordingFactory(),
            _StopRequests(),
            registry,
            board,
        )
    )

    with pytest.raises(ValueError, match="not on the traffic board"):
        board.is_waiting("sim-01")
