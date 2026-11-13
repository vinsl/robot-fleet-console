"""The simulated fleet: several real robot agents in one process, each with its kit and identity.

Each simulated robot runs the production agent (`run_agent`) with its own transport and kit. The
simulator adds three hooks through `RunControls`: a grid navigator, a mission driver and a fault
injector, all of which use only the simulator-only calls of the core. The fleet owns the signals,
the deadline and the single-instance lock. A robot that halts is not restarted: a halted core must
stay halted, and the others carry on.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import signal
import time
import zlib
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from fleet_agent.adapters.mqtt_crt import build_crt_transport
from fleet_agent.config.kit_file import KitError, load_kit, log_kit_refusal
from fleet_agent.config.settings import AgentSettings
from fleet_agent.core.agent import AgentCore
from fleet_agent.core.model import Point
from fleet_agent.core.ports import TransportFactory
from fleet_agent.runtime.runner import (
    EXIT_CONFIG,
    EXIT_FORCED,
    EXIT_OK,
    EXIT_SOFTWARE,
    RunControls,
    run_agent,
)
from fleet_agent.sim.faults import FaultInjector
from fleet_agent.sim.grid import OccupancyGrid, build_grid
from fleet_agent.sim.ids import sim_robot_ids
from fleet_agent.sim.lock import InstanceLock, SimLockedError, default_lock_path
from fleet_agent.sim.missions import MissionDriver
from fleet_agent.sim.navigator import GridNavigator
from fleet_agent.sim.routes import RouteBook
from fleet_agent.sim.site_map import SiteMap, SiteMapError, Station, load_site_map
from fleet_agent.sim.stations import StationRegistry
from fleet_agent.sim.traffic import AvoidingNavigator, TrafficBoard

EXIT_BUSY: Final = 75
"""Another simulator already runs on this host. It is the BSD `EX_TEMPFAIL` code."""

RUNTIME_LIMIT_S: Final = 7200
"""The default auto-stop of a run, in seconds: two hours, so a forgotten run costs little."""

RUNTIME_CAP_S: Final = 14400
"""The longest auto-stop a run can ask for, in seconds: four hours. No option raises it."""

WARN_BEFORE_DEADLINE_S: Final = 300
"""How long before the deadline the operator is warned, in seconds."""

PLAN_WORKERS: Final = 2
"""Worker threads for the on-demand plans of the whole fleet."""

SUPERVISE_PERIOD_S: Final = 0.1
"""How often the supervisor checks whether a stop must reach a robot that has just started."""

_MAX_FAULT_RATE_PER_HOUR: Final = 1000.0
_MAX_STAGGER_MS: Final = 10_000
_START_RING_STEP_M: Final = 0.6
"""Spacing of the start positions around the charger, in metres."""

_MAX_START_RING: Final = 40
_START_HEADING_RAD: Final = 0.0
_BATTERY_RANGE: Final[tuple[float, float]] = (55.0, 100.0)
_SPEED_JITTER: Final[tuple[float, float]] = (0.9, 1.1)
_SPEED_MAX_MPS: Final = 2.0
_SIM_MQTT_PORT: Final = 8883

_LOG: Final = logging.getLogger("fleet_agent.sim")


@dataclass(frozen=True, slots=True)
class SimConfig:
    """The parameters of one simulator run, from the command line.

    Attributes:
        count: The number of robots, from 1 to 20.
        site_id: The site the robots belong to. Each kit must name it.
        prefix: The prefix of the robot identifiers.
        map_path: The site map the robots drive on.
        kit_root: The directory holding one kit per robot.
        seed: The seed of the run. The same seed gives the same missions and faults.
        fault_rate_per_hour: The mean random faults per robot per hour; zero disables them.
        max_runtime_s: The auto-stop of the run, in seconds, from 1 to RUNTIME_CAP_S.
        stagger_ms: The gap between two robot starts, in milliseconds, so the broker is not flooded.
        speed_mps: The cruise speed of a robot, before its own variation, in metres per second.
    """

    count: int
    site_id: str
    prefix: str
    map_path: Path
    kit_root: Path
    seed: int = 1
    fault_rate_per_hour: float = 6.0
    max_runtime_s: int = RUNTIME_LIMIT_S
    stagger_ms: int = 250
    speed_mps: float = 1.0


class SimSetupError(Exception):
    """The run cannot start: nothing has connected yet. Its string form is the code alone.

    Attributes:
        code: The failed check, a fixed word.
        detail: The robot or field the check failed on, when it had one. Never a value.
    """

    def __init__(self, code: str, detail: str | None = None) -> None:
        """Creates the error.

        Args:
            code: The failed check.
            detail: The robot identifier or field, if any.
        """
        super().__init__(code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True, slots=True)
class _RobotPlan:
    """What one simulated robot needs, decided before it connects.

    Attributes:
        robot_id: The robot's identifier.
        settings: The agent settings of the robot.
        rng: The random source of the robot's missions and faults.
        stations: The workstations the robot's missions use.
        start: Where the robot starts, in metres, which is inside the parking area.
    """

    robot_id: str
    settings: AgentSettings
    rng: random.Random
    stations: tuple[Station, ...]
    start: Point


@dataclass(frozen=True, slots=True)
class _Plan:
    """The shared part of the run, built before any robot connects.

    Attributes:
        grid: The inflated occupancy grid of the map.
        book: The planned routes between the charger and the stations.
        robots: One plan per robot, in order.
        stations: The workstations of the map, which the fleet's reservations cover.
        charger: The charger, in metres, which is the centre of the parking area.
    """

    grid: OccupancyGrid
    book: RouteBook
    robots: tuple[_RobotPlan, ...]
    stations: tuple[Station, ...]
    charger: Point


class _StopRequests:
    """Counts the stop requests of the run: a first request is graceful, a second one forces.

    A signal counts one request each. The deadline counts as one request, and never as a second
    one, so a run that reaches its deadline still stops gracefully.
    """

    def __init__(self) -> None:
        """Creates the counter with no request."""
        self.requests = 0

    def signal_received(self) -> None:
        """Counts one stop signal."""
        self.requests += 1
        _LOG.info("sim.stop_requested", extra={"requests": self.requests})

    def deadline_reached(self) -> None:
        """Counts the deadline as a graceful request, once."""
        if self.requests == 0:
            self.requests = 1
            _LOG.info("sim.stop_requested", extra={"requests": 1})


async def run_fleet(
    config: SimConfig,
    *,
    transport_factory: TransportFactory = build_crt_transport,
) -> int:
    """Runs the fleet until every robot has stopped, the deadline passes, or a signal stops it.

    The run refuses before anything connects when the count, the map, a station, a kit or the
    start positions are unusable. It returns 75 without connecting when another simulator holds the
    lock on this host.

    Args:
        config: The parameters of the run.
        transport_factory: Builds the transport of each robot. Tests pass a fake.

    Returns:
        0 when every robot exited cleanly or after a forced stop, otherwise the highest other exit
        code of a robot; 75 when another simulator runs; 78 when the run cannot start.
    """
    refusal = _parameter_refusal(config)
    if refusal is not None:
        _LOG.error("sim.refused", extra={"reason": refusal})
        return EXIT_CONFIG
    identifiers = sim_robot_ids(config.prefix, config.count)
    try:
        with InstanceLock(default_lock_path()):
            return await _run_locked(config, identifiers, transport_factory)
    except SimLockedError:
        _LOG.error("sim.already_running")
        return EXIT_BUSY
    except PermissionError:
        _LOG.error("sim.refused", extra={"reason": "STATE_DIRECTORY"})
        return EXIT_CONFIG


def _parameter_refusal(config: SimConfig) -> str | None:
    """Checks the parameters of a run that the lock and the robots would otherwise trip over.

    Args:
        config: The parameters of the run.

    Returns:
        The reason of the first refused parameter, a fixed word, or None when all are usable.
    """
    try:
        sim_robot_ids(config.prefix, config.count)
    except ValueError:
        return "COUNT_OR_PREFIX"
    if not 0.0 <= config.fault_rate_per_hour <= _MAX_FAULT_RATE_PER_HOUR:
        return "FAULT_RATE"
    if config.max_runtime_s <= 0:
        return "MAX_RUNTIME"
    if config.max_runtime_s > RUNTIME_CAP_S:
        return "MAX_RUNTIME_CAP"
    if not 0 <= config.stagger_ms <= _MAX_STAGGER_MS:
        return "STAGGER"
    return None


async def _run_locked(
    config: SimConfig,
    identifiers: list[str],
    transport_factory: TransportFactory,
) -> int:
    """Prepares the plan, then runs the robots under the lock the caller holds.

    Args:
        config: The parameters of the run.
        identifiers: The robot identifiers, in order.
        transport_factory: Builds the transport of each robot.

    Returns:
        The exit code of the run.
    """
    try:
        plan = await asyncio.to_thread(_prepare, config, identifiers)
    except SimSetupError as err:
        _LOG.error("sim.refused", extra={"reason": err.code, "label": err.detail})
        return EXIT_CONFIG
    executor = ThreadPoolExecutor(max_workers=PLAN_WORKERS, thread_name_prefix="sim-plan")
    try:
        return await _serve(config, plan, executor, transport_factory)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _prepare(config: SimConfig, identifiers: list[str]) -> _Plan:
    """Loads the map, plans the routes, checks the kits and places the robots. Blocking.

    Args:
        config: The parameters of the run.
        identifiers: The robot identifiers, in order.

    Returns:
        The plan of the run.

    Raises:
        SimSetupError: When a check fails. Nothing has connected yet.
    """
    try:
        site_map = load_site_map(config.map_path)
    except SiteMapError as err:
        raise SimSetupError("MAP", err.code) from None
    grid = build_grid(site_map)
    stops = _stops_of(site_map)
    for key, point in stops.items():
        if not grid.point_free(point):
            raise SimSetupError("STOP_BLOCKED", key)
    book = RouteBook.build(grid, stops)
    if book.unreachable:
        raise SimSetupError("UNREACHABLE_STOP", "/".join(book.unreachable[0]))
    if config.speed_mps <= 0.0 or config.speed_mps * _SPEED_JITTER[1] > _SPEED_MAX_MPS:
        raise SimSetupError("SPEED")
    starts = _start_points(grid, site_map.charger, len(identifiers))
    robots = tuple(
        _plan_robot(config, identifier, start, site_map)
        for identifier, start in zip(identifiers, starts, strict=True)
    )
    return _Plan(
        grid=grid, book=book, robots=robots, stations=site_map.stations, charger=site_map.charger
    )


def _stops_of(site_map: SiteMap) -> dict[str, Point]:
    """Names the stops of the map: the charger, and each station under its own key.

    The keys cannot collide: a station's key carries a slash that a station name never can.

    Args:
        site_map: The validated map.

    Returns:
        The stops, by key.
    """
    stops: dict[str, Point] = {"charger": site_map.charger}
    for station in site_map.stations:
        stops[f"station/{station.name}"] = station.point
    return stops


def _plan_robot(
    config: SimConfig,
    identifier: str,
    start: Point,
    site_map: SiteMap,
) -> _RobotPlan:
    """Checks the kit of one robot and builds its settings and random source.

    Args:
        config: The parameters of the run.
        identifier: The robot identifier.
        start: Where the robot starts, in metres.
        site_map: The validated map, which gives the charger and the stations.

    Returns:
        The plan of the robot.

    Raises:
        SimSetupError: When the kit is refused, is not a simulated robot's, or names another site.
    """
    try:
        kit = load_kit(config.kit_root, identifier)
    except KitError as err:
        log_kit_refusal(err)
        raise SimSetupError("KIT_REFUSED", identifier) from None
    if not kit.config.simulated:
        raise SimSetupError("KIT_NOT_SIMULATED", identifier)
    if kit.config.site_id != config.site_id:
        raise SimSetupError("KIT_SITE", identifier)
    # The draws are seeded simulation inputs that make a run reproducible, not secrets.
    rng = random.Random(config.seed ^ zlib.crc32(identifier.encode("ascii")))  # noqa: S311
    speed = config.speed_mps * rng.uniform(*_SPEED_JITTER)
    battery = rng.uniform(*_BATTERY_RANGE)
    settings = AgentSettings(
        robot_id=identifier,
        kit_root=config.kit_root,
        mqtt_port=_SIM_MQTT_PORT,
        start_x=start.x,
        start_y=start.y,
        start_heading=_START_HEADING_RAD,
        charger_x=site_map.charger.x,
        charger_y=site_map.charger.y,
        speed_mps=speed,
        battery_start=battery,
        video_enabled=False,
    )
    return _RobotPlan(
        robot_id=identifier,
        settings=settings,
        rng=rng,
        stations=site_map.stations,
        start=start,
    )


def _start_points(grid: OccupancyGrid, charger: Point, count: int) -> list[Point]:
    """Places the robots on free cells in rings around the charger, nearest ring first.

    Args:
        grid: The inflated grid, which tells the free cells.
        charger: The charger, in metres.
        count: The number of robots to place.

    Returns:
        One free start point per robot, in order.

    Raises:
        SimSetupError: When there are not enough free cells near the charger.
    """
    points: list[Point] = []
    for ring in range(1, _MAX_START_RING + 1):
        radius = _START_RING_STEP_M * ring
        slots = 8 * ring
        for slot in range(slots):
            angle = 2.0 * math.pi * slot / slots
            candidate = Point(
                charger.x + radius * math.cos(angle), charger.y + radius * math.sin(angle)
            )
            if grid.point_free(candidate):
                points.append(candidate)
                if len(points) == count:
                    return points
    raise SimSetupError("NO_START_POSITION")


async def _serve(
    config: SimConfig,
    plan: _Plan,
    executor: Executor,
    transport_factory: TransportFactory,
) -> int:
    """Starts the robots staggered, supervises the stops, and waits for every robot to end.

    Args:
        config: The parameters of the run.
        plan: The plan of the run.
        executor: Runs the on-demand plans of the navigators.
        transport_factory: Builds the transport of each robot.

    Returns:
        The exit code of the run.
    """
    loop = asyncio.get_running_loop()
    requests = _StopRequests()
    registry = StationRegistry(station.name for station in plan.stations)
    # The parking area must hold every start position, plus one ring step of margin, so that no
    # robot starts outside it and holds up the others before it has moved.
    parking_radius = (
        max(
            math.hypot(robot.start.x - plan.charger.x, robot.start.y - plan.charger.y)
            for robot in plan.robots
        )
        + _START_RING_STEP_M
    )
    board = TrafficBoard(parking_centre=plan.charger, parking_radius_m=parking_radius)
    for robot in plan.robots:
        board.place(robot.robot_id, robot.start)
    controls = [
        _controls_for(robot, plan, config, executor, registry, board) for robot in plan.robots
    ]
    tasks = [
        asyncio.create_task(
            _run_robot(robot, ctl, index, config, transport_factory, requests, registry, board)
        )
        for index, (robot, ctl) in enumerate(zip(plan.robots, controls, strict=True))
    ]
    supervisor = asyncio.create_task(_supervise(controls, requests, config))
    _LOG.info(
        "sim.started", extra={"count": config.count, "siteId": config.site_id, "seed": config.seed}
    )
    loop.add_signal_handler(signal.SIGTERM, requests.signal_received)
    loop.add_signal_handler(signal.SIGINT, requests.signal_received)
    try:
        codes = await asyncio.gather(*tasks)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)
        loop.remove_signal_handler(signal.SIGINT)
        supervisor.cancel()
    return _exit_code(codes)


def _controls_for(
    robot: _RobotPlan,
    plan: _Plan,
    config: SimConfig,
    executor: Executor,
    registry: StationRegistry,
    board: TrafficBoard,
) -> RunControls:
    """Builds the hooks of one robot: its navigator, mission driver and fault injector.

    Args:
        robot: The plan of the robot.
        plan: The shared plan, for the grid and the route book.
        config: The parameters of the run, for the fault rate.
        executor: Runs the on-demand plans.
        registry: The workstation reservations of the whole run, shared by every robot.
        board: The traffic board of the run, on which the robot yields to the others.

    Returns:
        The controls to pass to `run_agent`.
    """
    missions = MissionDriver(robot.robot_id, robot.rng, robot.stations, registry=registry)
    faults = FaultInjector(robot.rng, config.fault_rate_per_hour)

    def on_tick(core: AgentCore, _index: int) -> None:
        """Runs the mission driver and the fault injector once per tick of the robot.

        Args:
            core: The robot's core.
            _index: The index of the tick. Unused.
        """
        now_ms = time.monotonic_ns() // 1_000_000
        missions.tick(core, now_ms)
        faults.tick(core, now_ms)

    return RunControls(
        install_signals=False,
        on_tick=on_tick,
        navigator=AvoidingNavigator(
            GridNavigator(plan.book, plan.grid, executor), board, robot.robot_id
        ),
    )


async def _wait_for_stagger(delay_s: float, requests: _StopRequests) -> None:
    """Sleeps out the stagger of a robot, but returns at once when a stop is requested.

    A robot still waiting has no connection to close, so a stop must not wait for the gap to end.
    The caller checks the requests after this returns.

    Args:
        delay_s: The stagger of the robot, in seconds.
        requests: The stop requests of the run.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + delay_s
    while requests.requests == 0:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return
        await asyncio.sleep(min(remaining, SUPERVISE_PERIOD_S))


async def _run_robot(
    robot: _RobotPlan,
    controls: RunControls,
    index: int,
    config: SimConfig,
    transport_factory: TransportFactory,
    requests: _StopRequests,
    registry: StationRegistry,
    board: TrafficBoard,
) -> int:
    """Runs one robot's agent after its stagger, and reports how it ended. It is never restarted.

    A stop that arrives during the stagger means the robot never connects: it ends with EXIT_OK,
    so the run does not report a failure for a robot the operator stopped before it started.

    However the robot ends, stopped, halted, failed or cancelled, its workstations are released
    here. The mission driver is not ticked after a halt, so this is the only release that covers
    it; a stuck reservation would otherwise keep a workstation out of the fleet for good. The
    robot also leaves the traffic board, so the others stop yielding to a position it no longer
    holds.

    Args:
        robot: The plan of the robot.
        controls: The hooks of the robot.
        index: The position of the robot in the run, which sets its stagger.
        config: The parameters of the run, for the stagger.
        transport_factory: Builds the robot's transport.
        requests: The stop requests of the run, checked after the stagger.
        registry: The workstation reservations of the run, released for this robot on exit.
        board: The traffic board of the run, from which this robot is removed on exit.

    Returns:
        The exit code of the robot's agent, or EXIT_OK when a stop came before it connected.
    """
    try:
        await _wait_for_stagger(index * config.stagger_ms / 1000, requests)
        if requests.requests > 0:
            _LOG.info("sim.robot_not_started", extra={"robotId": robot.robot_id})
            return EXIT_OK
        try:
            code = await run_agent(
                robot.settings, transport_factory=transport_factory, controls=controls
            )
        except Exception as err:
            _LOG.error(
                "sim.robot_failed",
                extra={"robotId": robot.robot_id, "errorName": type(err).__name__},
            )
            return EXIT_SOFTWARE
        if code not in (EXIT_OK, EXIT_FORCED):
            _LOG.error("sim.robot_halted", extra={"robotId": robot.robot_id, "exitCode": code})
        return code
    finally:
        registry.release(robot.robot_id)
        board.remove(robot.robot_id)


async def _supervise(
    controls: list[RunControls],
    requests: _StopRequests,
    config: SimConfig,
) -> None:
    """Forwards the stop requests to every robot's runtime, and enforces the deadline.

    A robot whose runtime is not built yet receives its requests as soon as it is. Each robot gets
    one request per count of the run, so a second signal forces its exit.

    Args:
        controls: The hooks of every robot, whose runtime is set once it is built.
        requests: The stop requests of the run.
        config: The parameters of the run, for the deadline.
    """
    asked = [0] * len(controls)
    started = time.monotonic()
    warned = False
    while True:
        elapsed = time.monotonic() - started
        warn_at = config.max_runtime_s - WARN_BEFORE_DEADLINE_S
        if not warned and config.max_runtime_s > WARN_BEFORE_DEADLINE_S and elapsed >= warn_at:
            warned = True
            _LOG.warning("sim.deadline_soon", extra={"secondsLeft": WARN_BEFORE_DEADLINE_S})
        if elapsed >= config.max_runtime_s:
            requests.deadline_reached()
        target = min(requests.requests, 2)
        for position, ctl in enumerate(controls):
            runtime = ctl.runtime
            while runtime is not None and asked[position] < target:
                runtime.request_stop()
                asked[position] += 1
        await asyncio.sleep(SUPERVISE_PERIOD_S)


def _exit_code(codes: list[int]) -> int:
    """Combines the robots' exit codes: a clean or forced end is 0, else the highest other code.

    Args:
        codes: The exit code of each robot.

    Returns:
        The exit code of the run.
    """
    failed = [code for code in codes if code not in (EXIT_OK, EXIT_FORCED)]
    return max(failed) if failed else EXIT_OK
