"""Tests of the simulator hooks of the core: the navigator, the speed ramp and the four hooks.

The hooks are driven the way the simulator drives them, through the public methods between two
ticks. The existing core tests are not changed; this file covers what the hooks add. A real robot
must refuse every simulator-only method before anything changes.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from typing import Literal

import pytest

from fleet_agent.core import agent as agent_module
from fleet_agent.core.agent import AgentCore, AgentIdentity
from fleet_agent.core.constants import ACCEL_MPS2, MIN_CREEP_MPS
from fleet_agent.core.model import Destination, Point
from fleet_agent.core.motion import next_speed
from fleet_agent.core.navigation import StraightLineNavigator
from fleet_agent.core.ports import Navigator, Waypoint
from fleet_agent.core.state_machine import Guard, RobotState, TransitionResult
from fleet_agent.protocol.constants import BATTERY_LOW_PERCENT
from fleet_agent.protocol.primitives import ReportedState
from fleet_agent.protocol.triggers import Trigger

from .fakes import (
    ROBOT_ID,
    SITE,
    SITE_ID,
    FakeClock,
    FakeTransport,
    MemoryLatchStore,
    body_of,
    deliver,
    labels,
    make_core,
    model_of,
)

TICK_MS = 50
STATION_A = Point(4.0, 0.0)
STATION_C = Point(7.0, 0.0)
MISSION_ID = "m-sim-01-0001"


class ScriptedNavigator:
    """A navigator that serves a fixed route and records what the core asked of it.

    Attributes:
        asked: Every destination the core asked a waypoint for, in order.
        reached_waypoints: Every intermediate waypoint the core reported as reached.
    """

    def __init__(self, route: Sequence[Waypoint], *, hold: bool = False) -> None:
        """Creates a navigator over a route.

        Args:
            route: The waypoints to serve, first to last. The first one is served until reached.
            hold: When True, no waypoint is ever known, so the robot holds position.
        """
        self._route = list(route)
        self._hold = hold
        self.asked: list[Destination] = []
        self.reached_waypoints: list[Waypoint] = []

    def next_waypoint(self, x: float, y: float, destination: Destination) -> Waypoint | None:
        """Serves the first waypoint of the route, or None when holding.

        Args:
            x: The robot's x position. Unused by the script.
            y: The robot's y position. Unused by the script.
            destination: The destination the core is heading to.

        Returns:
            The first waypoint of the route, or None.
        """
        del x, y
        self.asked.append(destination)
        if self._hold or not self._route:
            return None
        return self._route[0]

    def reached(self, waypoint: Waypoint) -> None:
        """Records the reached waypoint and serves the next one.

        Args:
            waypoint: The intermediate waypoint that was reached.
        """
        self.reached_waypoints.append(waypoint)
        self._route.pop(0)


def _sim_core(navigator: Navigator | None) -> tuple[AgentCore, FakeClock, FakeTransport]:
    """Builds a booted simulated core with the given navigator.

    Args:
        navigator: The path planner, or None for the default straight line.

    Returns:
        The core, its clock and its transport.
    """
    clock = FakeClock()
    transport = FakeTransport()
    identity = AgentIdentity(
        robot_id=ROBOT_ID,
        site_id=SITE_ID,
        thing_name=f"mfc-demo-{ROBOT_ID}",
        simulated=True,
        agent_version="0.1.0",
    )
    core = AgentCore(
        identity=identity,
        geometry=SITE,
        battery_start=80.0,
        clock=clock,
        transport=transport,
        latch=MemoryLatchStore(),
        rand=lambda: 0.5,
        navigator=navigator,
    )
    transport.set_listener(core)
    core.boot()
    return core, clock, transport


def _tick_for(core: AgentCore, clock: FakeClock, duration_ms: int) -> None:
    """Ticks the core for a duration, one tick at a time.

    Args:
        core: The core to tick.
        clock: The clock to advance before each tick.
        duration_ms: The time to simulate, in milliseconds.
    """
    for _ in range(duration_ms // TICK_MS):
        clock.advance(TICK_MS)
        core.tick()


def _tick_until_working(core: AgentCore, clock: FakeClock) -> None:
    """Ticks the core until the robot is WORKING at its station.

    Args:
        core: The core to tick.
        clock: The clock to advance before each tick.

    Raises:
        AssertionError: If the robot does not reach the station within 200 simulated seconds.
    """
    for _ in range(4000):
        if core.snapshot().state == "WORKING":
            return
        clock.advance(TICK_MS)
        core.tick()
    raise AssertionError("the robot did not reach its station")


def _break_the_table_for(monkeypatch: pytest.MonkeyPatch, trigger: Trigger) -> None:
    """Makes the state table fail with a TypeError for one trigger, as a broken row would.

    Args:
        monkeypatch: The fixture that patches the table lookup of the core for this test only.
        trigger: The trigger whose row is broken. Every other trigger is looked up as usual.
    """
    real = agent_module.transition

    def broken(
        origin: RobotState | Literal["START"],
        current: Trigger,
        guards: Iterable[Guard] = (),
        resume_target: ReportedState | None = None,
    ) -> TransitionResult:
        """Raises for the broken trigger, and looks up every other one in the real table.

        Args:
            origin: The state the robot is in.
            current: The trigger looked up.
            guards: The guards that hold.
            resume_target: The state a resume returns to, if any.

        Returns:
            The real transition, for any trigger but the broken one.

        Raises:
            TypeError: For the broken trigger, as a table with an ambiguous row would.
        """
        if current == trigger:
            raise TypeError("the table has no single row for this trigger")
        return real(origin, current, guards, resume_target)

    monkeypatch.setattr(agent_module, "transition", broken)


def _state_changes(transport: FakeTransport) -> list[tuple[str, str, str]]:
    """Lists every state change the robot published, as (from, to, cause).

    Args:
        transport: The fake that recorded the publishes.

    Returns:
        One tuple per STATE_CHANGED event, in order.
    """
    changes: list[tuple[str, str, str]] = []
    for index, label in enumerate(labels(transport)):
        if label == "STATE_CHANGED":
            body = body_of(transport, index)
            changes.append((str(body["from"]), str(body["to"]), str(body["cause"])))
    return changes


# Navigator


def test_the_default_navigator_drives_straight_at_the_destination() -> None:
    """Given a destination, the straight-line navigator serves it as the final waypoint."""
    destination = Destination("STATION", STATION_A)

    waypoint = StraightLineNavigator().next_waypoint(10.0, 0.0, destination)

    assert waypoint == Waypoint(STATION_A, final=True)


def test_a_robot_without_a_navigator_keeps_the_straight_line_path() -> None:
    """Given no navigator, a mission drives in a straight line and arrives on the station."""
    core, clock, transport, _ = make_core(simulated=True)
    assert core.assign_mission(MISSION_ID, [STATION_A])

    _tick_until_working(core, clock)

    assert _state_changes(transport) == [
        ("IDLE", "MOVING", "MISSION_ASSIGNED"),
        ("MOVING", "WORKING", "ARRIVED"),
    ]
    assert model_of(core).x == STATION_A.x
    assert model_of(core).speed == 0.0


def test_an_intermediate_waypoint_is_passed_without_an_arrival() -> None:
    """Given a route with a bend, only the final waypoint makes the robot arrive."""
    bend = Waypoint(STATION_C, final=False)
    final = Waypoint(STATION_A, final=True)
    navigator = ScriptedNavigator([bend, final])
    core, clock, transport = _sim_core(navigator)
    assert core.assign_mission(MISSION_ID, [STATION_A])

    _tick_until_working(core, clock)

    assert navigator.reached_waypoints == [bend]
    assert _state_changes(transport) == [
        ("IDLE", "MOVING", "MISSION_ASSIGNED"),
        ("MOVING", "WORKING", "ARRIVED"),
    ]


def test_the_navigator_is_asked_about_the_destination_of_the_mission() -> None:
    """Given a mission, every waypoint request names the station the robot is driving to."""
    navigator = ScriptedNavigator([Waypoint(STATION_A, final=True)])
    core, clock, _ = _sim_core(navigator)
    assert core.assign_mission(MISSION_ID, [STATION_A])

    _tick_until_working(core, clock)

    assert navigator.asked
    assert all(item == Destination("STATION", STATION_A) for item in navigator.asked)


def test_a_robot_with_no_known_waypoint_holds_position_at_zero_speed() -> None:
    """Given a navigator that knows no path, the robot stays MOVING where it is, at speed 0."""
    navigator = ScriptedNavigator([], hold=True)
    core, clock, transport = _sim_core(navigator)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    start_x = model_of(core).x

    _tick_for(core, clock, 2000)

    model = model_of(core)
    assert model.state == "MOVING"
    assert model.x == start_x
    assert model.speed == 0.0
    assert _state_changes(transport) == [("IDLE", "MOVING", "MISSION_ASSIGNED")]
    assert navigator.reached_waypoints == []


@pytest.mark.parametrize("disturbance", ["ESTOP", "OBSTACLE"])
def test_a_robot_that_stops_or_is_blocked_has_speed_zero_on_the_next_tick(disturbance: str) -> None:
    """Given a moving robot, an e-stop or a blocking fault stops it on the very next tick."""
    core, clock, transport = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    _tick_for(core, clock, 500)
    assert model_of(core).speed > 0

    if disturbance == "ESTOP":
        deliver(transport, clock, "ESTOP")
    else:
        assert core.inject_fault("OBSTACLE")
    position = (model_of(core).x, model_of(core).y)
    clock.advance(TICK_MS)
    core.tick()

    assert model_of(core).speed == 0.0
    assert (model_of(core).x, model_of(core).y) == position


# Speed ramp


def test_the_speed_ramps_up_at_the_acceleration_rate_from_rest() -> None:
    """Given a robot at rest, one second of ramping reaches the acceleration rate in m/s."""
    speed = 0.0
    for _ in range(20):
        speed = next_speed(speed, 1.0, ACCEL_MPS2, 100.0, TICK_MS)

    assert speed == pytest.approx(ACCEL_MPS2)


def test_the_speed_never_exceeds_the_cruise_speed() -> None:
    """Given a cruise speed below the acceleration limit, the speed stops at the cruise speed."""
    assert next_speed(0.49, 0.5, ACCEL_MPS2, 100.0, TICK_MS) == 0.5


def test_the_speed_brakes_in_time_for_the_target() -> None:
    """Given a robot 0.5 m from its target, the speed is the one it can still stop from."""
    expected = math.sqrt(2 * ACCEL_MPS2 * 0.5)

    assert next_speed(1.0, 1.0, ACCEL_MPS2, 0.5, TICK_MS) == pytest.approx(expected)


@pytest.mark.parametrize("remaining", [0.0, -0.2, 0.001])
def test_the_speed_drops_to_the_creep_speed_when_the_target_is_at_hand(remaining: float) -> None:
    """Given a moving robot with the target at hand, it brakes to the creep speed, not to a stop."""
    assert next_speed(0.5, 1.0, ACCEL_MPS2, remaining, TICK_MS) == MIN_CREEP_MPS


def test_a_mission_ramps_up_and_brakes_without_overshooting_the_station() -> None:
    """Given a six-metre drive, the robot reaches cruise speed, slows in time and stops on target.

    At every tick the speed is bounded by what the robot can still stop from, and the robot never
    passes the station.
    """
    core, clock, _, _ = make_core(simulated=True)
    model = model_of(core)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    samples: list[tuple[float, float, float]] = []

    for _ in range(4000):
        if core.snapshot().state == "WORKING":
            break
        remaining = abs(model.x - STATION_A.x)
        clock.advance(TICK_MS)
        core.tick()
        samples.append((remaining, model.speed, model.x))
    else:
        raise AssertionError("the robot did not reach its station")

    assert min(x for _, _, x in samples) >= STATION_A.x - 1e-9
    assert max(speed for _, speed, _ in samples) == pytest.approx(SITE.speed_mps)
    for remaining, speed, _ in samples:
        bound = max(math.sqrt(2 * ACCEL_MPS2 * remaining), MIN_CREEP_MPS)
        assert speed <= bound + 1e-9
    assert model.x == STATION_A.x
    assert model.speed == 0.0


# Hooks: assign_mission


def test_assign_mission_sends_an_idle_robot_to_its_first_station() -> None:
    """Given an idle simulated robot, a mission starts it towards the first station."""
    core, _, transport = _sim_core(None)

    assert core.assign_mission(MISSION_ID, [STATION_A, STATION_C])

    model = model_of(core)
    assert core.snapshot().state == "MOVING"
    assert model.mission_id == MISSION_ID
    assert model.destination == Destination("STATION", STATION_A)
    assert model.mission_stations == [STATION_C]
    assert _state_changes(transport) == [("IDLE", "MOVING", "MISSION_ASSIGNED")]


@pytest.mark.parametrize("refusal", ["already_moving", "no_stations", "stopping", "halted"])
def test_assign_mission_changes_nothing_when_the_robot_cannot_take_a_mission(refusal: str) -> None:
    """Given a robot that is busy, stopping, halted or offered no station, nothing changes."""
    core, clock, transport = _sim_core(None)
    if refusal == "already_moving":
        assert core.assign_mission(MISSION_ID, [STATION_A])
    elif refusal == "stopping":
        core.begin_shutdown()
    elif refusal == "halted":
        core.halt("RuntimeError")
    stations: Sequence[Point] = [] if refusal == "no_stations" else [STATION_C]
    _tick_for(core, clock, TICK_MS)
    state = core.snapshot().state
    changes = _state_changes(transport)

    accepted = core.assign_mission("m-sim-01-0002", stations)

    assert accepted is False
    assert core.snapshot().state == state
    assert _state_changes(transport) == changes
    assert model_of(core).mission_id == (MISSION_ID if refusal == "already_moving" else None)


# Hooks: finish_work


def test_finish_work_is_refused_outside_working() -> None:
    """Given a robot that is idle or still driving, finishing work changes nothing."""
    core, _, transport = _sim_core(None)
    assert core.finish_work() is False
    assert core.assign_mission(MISSION_ID, [STATION_A])
    assert core.finish_work() is False
    assert _state_changes(transport) == [("IDLE", "MOVING", "MISSION_ASSIGNED")]


def test_finish_work_completes_the_mission_and_the_robot_goes_idle() -> None:
    """Given a robot working on its last station, finishing the work ends the mission."""
    core, clock, transport = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    _tick_until_working(core, clock)

    assert core.finish_work() is True

    assert core.snapshot().state == "IDLE"
    assert model_of(core).mission_id is None
    assert _state_changes(transport)[-1] == ("WORKING", "IDLE", "WORK_DONE")


def test_finish_work_sends_the_robot_on_to_the_next_station() -> None:
    """Given a two-station mission, finishing the first station drives on to the second."""
    core, clock, transport = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A, STATION_C])
    _tick_until_working(core, clock)

    assert core.finish_work() is True

    assert core.snapshot().state == "MOVING"
    assert model_of(core).destination == Destination("STATION", STATION_C)
    assert _state_changes(transport)[-1] == ("WORKING", "MOVING", "WORK_DONE")


def test_finish_work_is_refused_while_the_robot_is_stopping() -> None:
    """Given a robot that began a shutdown, the work is not finished."""
    core, clock, _ = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    _tick_until_working(core, clock)
    core.begin_shutdown()

    assert core.finish_work() is False
    assert core.snapshot().state == "WORKING"


# Hooks: inject_fault


@pytest.mark.parametrize("kind", ["OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS"])
def test_no_fault_can_be_injected_into_an_estopped_robot(
    kind: Literal["OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS"],
) -> None:
    """Given an e-stopped robot, the table refuses every injected fault and nothing changes."""
    core, clock, transport = _sim_core(None)
    deliver(transport, clock, "ESTOP")
    before = len(transport.published)

    assert core.inject_fault(kind) is False

    assert core.snapshot().state == "ESTOP"
    assert len(transport.published) == before


def test_an_obstacle_is_refused_for_an_idle_robot_by_the_table() -> None:
    """Given an idle robot, an obstacle has no row in the table, so it is refused."""
    core, _, transport = _sim_core(None)
    before = len(transport.published)

    assert core.inject_fault("OBSTACLE") is False

    assert core.snapshot().state == "IDLE"
    assert len(transport.published) == before


def test_a_sensor_fault_blocks_an_idle_robot_and_says_so() -> None:
    """Given an idle robot, a sensor fault blocks it, as a state change and a fault report."""
    core, _, transport = _sim_core(None)

    assert core.inject_fault("SENSOR_FAULT") is True

    assert core.snapshot().state == "BLOCKED"
    assert _state_changes(transport) == [("IDLE", "BLOCKED", "SIMULATE_FAULT:SENSOR_FAULT")]
    assert "FAULT_RAISED" in labels(transport)


def test_a_moving_robot_hit_by_an_obstacle_is_blocked_with_the_obstacle_cause() -> None:
    """Given a moving robot, an injected obstacle blocks it on the obstacle cause."""
    core, clock, transport = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    _tick_for(core, clock, 200)

    assert core.inject_fault("OBSTACLE") is True

    assert core.snapshot().state == "BLOCKED"
    assert _state_changes(transport)[-1] == ("MOVING", "BLOCKED", "SIMULATE_FAULT:OBSTACLE")


def test_a_low_battery_injection_drops_the_charge_under_the_threshold() -> None:
    """Given an idle robot, injecting low battery puts the charge under the low threshold."""
    core, _, _ = _sim_core(None)

    assert core.inject_fault("BATTERY_LOW") is True

    assert model_of(core).battery < BATTERY_LOW_PERCENT


def test_a_link_loss_drops_the_link_for_the_requested_duration_after_the_grace_period() -> None:
    """Given an idle robot, a link loss drops the link after the grace period, not before."""
    core, clock, transport = _sim_core(None)

    assert core.inject_fault("LINK_LOSS", duration_ms=3000) is True
    assert transport.suspended == []
    _tick_for(core, clock, 1500)

    assert transport.suspended == [3000]
    assert core.snapshot().state == "IDLE"


def test_a_timed_fault_clears_after_its_duration_and_the_robot_can_resume() -> None:
    """Given a one-second obstacle, the cause clears on its own and the robot resumes its move."""
    core, clock, transport = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    _tick_for(core, clock, 200)
    assert core.inject_fault("OBSTACLE", duration_ms=1000) is True
    assert model_of(core).cause_clear_at_ms is not None

    _tick_for(core, clock, 1200)

    assert model_of(core).cause_pending is False
    assert core.snapshot().state == "BLOCKED"
    assert "FAULT_CLEARED" in labels(transport)
    assert core.auto_resume() is True
    assert core.snapshot().state == "MOVING"


def test_an_injection_is_refused_while_the_robot_is_halted() -> None:
    """Given a halted robot, no fault is injected."""
    core, _, transport = _sim_core(None)
    core.halt("RuntimeError")
    before = len(transport.published)

    assert core.inject_fault("SENSOR_FAULT") is False
    assert len(transport.published) == before


# Hooks: auto_resume


def test_auto_resume_is_refused_when_the_robot_is_not_blocked() -> None:
    """Given an idle robot, there is nothing to resume."""
    core, _, transport = _sim_core(None)
    before = len(transport.published)

    assert core.auto_resume() is False
    assert len(transport.published) == before


def test_auto_resume_is_refused_while_the_cause_is_still_present() -> None:
    """Given a blocked robot whose obstacle is still there, it stays blocked."""
    core, _, _ = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    assert core.inject_fault("OBSTACLE") is True

    assert core.auto_resume() is False
    assert core.snapshot().state == "BLOCKED"


def test_auto_resume_is_refused_while_the_robot_is_stopping() -> None:
    """Given a blocked robot that began a shutdown, it does not resume."""
    core, clock, _ = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    assert core.inject_fault("OBSTACLE", duration_ms=500) is True
    _tick_for(core, clock, 800)
    core.begin_shutdown()

    assert core.auto_resume() is False
    assert core.snapshot().state == "BLOCKED"


# Real robot refusal


@pytest.mark.parametrize(
    "call",
    [
        pytest.param(lambda core: core.assign_mission(MISSION_ID, [STATION_A]), id="assign"),
        pytest.param(lambda core: core.finish_work(), id="finish"),
        pytest.param(lambda core: core.inject_fault("OBSTACLE"), id="inject"),
        pytest.param(lambda core: core.auto_resume(), id="resume"),
    ],
)
def test_a_real_robot_refuses_every_simulator_only_hook_before_anything_changes(
    call: Callable[[AgentCore], object],
) -> None:
    """Given a real robot in IDLE, each simulator-only hook raises and publishes nothing."""
    core, _, transport, _ = make_core(simulated=False)
    before = len(transport.published)

    with pytest.raises(ValueError, match="simulated robot only"):
        call(core)

    assert len(transport.published) == before
    assert core.snapshot().state == "IDLE"
    assert model_of(core).mission_id is None


# Review fixes: motion, halts and input bounds


def test_a_bend_on_the_way_does_not_slow_the_robot_to_creep() -> None:
    """Given a bend ahead and a far destination, the robot keeps its cruise speed up to the bend.

    The speed brakes for the destination, not for the waypoint, so the robot does not creep at
    every corner. The samples are taken within half a metre before the bend, where the old braking
    against the waypoint slowed the robot below cruise.
    """
    bend = Waypoint(Point(7.0, 0.0), final=False)
    navigator = ScriptedNavigator([bend, Waypoint(STATION_A, final=True)])
    core, clock, _ = _sim_core(navigator)
    model = model_of(core)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    near_bend: list[float] = []

    for _ in range(4000):
        if navigator.reached_waypoints:
            break
        clock.advance(TICK_MS)
        core.tick()
        if 0.0 < model.x - bend.point.x <= 0.5:
            near_bend.append(model.speed)
    else:
        raise AssertionError("the robot did not reach the bend")

    assert navigator.reached_waypoints == [bend]
    assert near_bend
    assert all(speed == pytest.approx(SITE.speed_mps) for speed in near_bend)


def test_assign_mission_halts_the_robot_when_the_table_has_no_single_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a broken row for the mission, the robot halts, stays idle and is not moved."""
    core, _, transport = _sim_core(None)
    _break_the_table_for(monkeypatch, "MISSION_ASSIGNED")

    assert core.assign_mission(MISSION_ID, [STATION_A]) is False

    assert core.halted is True
    assert core.snapshot().state == "IDLE"
    assert model_of(core).speed == 0.0
    assert _state_changes(transport) == []


def test_finish_work_halts_the_robot_when_the_table_has_no_single_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a broken row for the end of work, the robot halts and stays at its station."""
    core, clock, transport = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    _tick_until_working(core, clock)
    _break_the_table_for(monkeypatch, "WORK_DONE")
    changes = _state_changes(transport)

    assert core.finish_work() is False

    assert core.halted is True
    assert core.snapshot().state == "WORKING"
    assert _state_changes(transport) == changes


def test_auto_resume_halts_the_robot_when_the_table_has_no_single_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a blocked robot whose cause cleared, a broken resume row halts it, still blocked."""
    core, clock, _ = _sim_core(None)
    assert core.assign_mission(MISSION_ID, [STATION_A])
    assert core.inject_fault("OBSTACLE", duration_ms=500) is True
    _tick_for(core, clock, 800)
    _break_the_table_for(monkeypatch, "RESUME")

    assert core.auto_resume() is False

    assert core.halted is True
    assert core.snapshot().state == "BLOCKED"


def test_inject_fault_halts_the_robot_when_the_table_has_no_single_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a broken row for a fault, the injection halts the robot instead of raising."""
    core, _, transport = _sim_core(None)
    _break_the_table_for(monkeypatch, "SIMULATE_FAULT:SENSOR_FAULT")
    before = len(transport.published)

    assert core.inject_fault("SENSOR_FAULT") is False

    assert core.halted is True
    assert core.snapshot().state == "IDLE"
    assert len(transport.published) == before


@pytest.mark.parametrize("duration_ms", [0, -1, 300_001])
def test_inject_fault_refuses_a_duration_outside_the_protocol_bounds(duration_ms: int) -> None:
    """Given a duration of zero, negative or above the protocol maximum, nothing is injected."""
    core, _, transport = _sim_core(None)
    before = len(transport.published)

    assert core.inject_fault("SENSOR_FAULT", duration_ms=duration_ms) is False

    assert core.snapshot().state == "IDLE"
    assert len(transport.published) == before


def test_inject_fault_accepts_the_longest_protocol_duration() -> None:
    """Given the protocol maximum of 300 seconds, the fault is injected."""
    core, _, _ = _sim_core(None)

    assert core.inject_fault("SENSOR_FAULT", duration_ms=300_000) is True
    assert core.snapshot().state == "BLOCKED"


@pytest.mark.parametrize("mission_id", ["", "m" * 65, "Mission-01", "m 01"])
def test_assign_mission_refuses_a_mission_id_outside_the_protocol_pattern(mission_id: str) -> None:
    """Given an empty, too long or malformed mission identifier, the robot takes no mission."""
    core, _, transport = _sim_core(None)
    before = len(transport.published)

    assert core.assign_mission(mission_id, [STATION_A]) is False

    assert core.snapshot().state == "IDLE"
    assert len(transport.published) == before


def test_assign_mission_accepts_the_longest_protocol_mission_id() -> None:
    """Given a mission identifier of the protocol's maximum length, the mission is assigned."""
    core, _, _ = _sim_core(None)

    assert core.assign_mission("m" * 64, [STATION_A]) is True


@pytest.mark.parametrize("station", [Point(math.nan, 0.0), Point(0.0, math.inf)])
def test_assign_mission_refuses_a_station_with_a_non_finite_coordinate(station: Point) -> None:
    """Given a station whose coordinate is NaN or infinite, the robot takes no mission."""
    core, _, transport = _sim_core(None)
    before = len(transport.published)

    assert core.assign_mission(MISSION_ID, [STATION_A, station]) is False

    assert core.snapshot().state == "IDLE"
    assert len(transport.published) == before
