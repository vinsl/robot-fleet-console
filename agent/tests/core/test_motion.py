"""Motion and battery integration: the target is reached and snapped to, the heading points at it,
the time step is capped, and the charge drains, charges and stays within its bounds."""

from __future__ import annotations

import math

import pytest

from fleet_agent.core.constants import MOTION_STALL_CAP_MS
from fleet_agent.core.model import Point
from fleet_agent.core.motion import battery_after, capped_dt_ms, step_towards


def _walk(start: Point, target: Point, speed_mps: float, dt_ms: int) -> tuple[float, float, int]:
    """Steps the robot until it arrives, and returns the final position and the step count."""
    x, y = start.x, start.y
    steps = 0
    arrived = False
    while not arrived:
        x, y, _heading, arrived = step_towards(x, y, target, speed_mps, dt_ms)
        steps += 1
        assert steps < 10_000, "the robot never arrived"
    return x, y, steps


def test_reaches_the_target_and_snaps_onto_it() -> None:
    target = Point(10.0, 0.0)

    x, y, steps = _walk(Point(0.0, 0.0), target, speed_mps=1.0, dt_ms=200)

    assert (x, y) == (target.x, target.y)
    assert steps == 50


def test_an_overshooting_step_snaps_onto_the_target_in_one_move() -> None:
    x, y, heading, arrived = step_towards(0.0, 0.0, Point(0.1, 0.0), speed_mps=1.0, dt_ms=1000)

    assert arrived is True
    assert (x, y) == (0.1, 0.0)
    assert heading == pytest.approx(0.0)


def test_arrives_when_the_remaining_distance_is_within_tolerance() -> None:
    x, y, _heading, arrived = step_towards(0.0, 0.0, Point(0.04, 0.0), speed_mps=0.0, dt_ms=200)

    assert arrived is True
    assert (x, y) == (0.04, 0.0)


def test_does_not_arrive_while_far_from_the_target() -> None:
    x, y, _heading, arrived = step_towards(0.0, 0.0, Point(10.0, 0.0), speed_mps=1.0, dt_ms=200)

    assert arrived is False
    assert x == pytest.approx(0.2)
    assert y == pytest.approx(0.0)


@pytest.mark.parametrize(
    ("target", "expected_heading"),
    [
        (Point(0.0, 10.0), math.pi / 2),
        (Point(-5.0, 0.0), math.pi),
        (Point(0.0, -5.0), -math.pi / 2),
        (Point(3.0, 3.0), math.pi / 4),
    ],
    ids=["north", "west", "south", "north-east"],
)
def test_the_heading_points_at_the_target(target: Point, expected_heading: float) -> None:
    _x, _y, heading, _arrived = step_towards(0.0, 0.0, target, speed_mps=1.0, dt_ms=10)

    assert heading == pytest.approx(expected_heading)


def test_the_heading_is_zero_when_already_on_the_target() -> None:
    _x, _y, heading, arrived = step_towards(2.0, 2.0, Point(2.0, 2.0), speed_mps=1.0, dt_ms=10)

    assert arrived is True
    assert heading == 0.0


@pytest.mark.parametrize(
    ("elapsed_ms", "expected"),
    [(0, 0), (150, 150), (MOTION_STALL_CAP_MS, MOTION_STALL_CAP_MS), (5000, MOTION_STALL_CAP_MS)],
    ids=["zero", "below-cap", "at-cap", "stall"],
)
def test_a_stall_is_capped_before_integration(elapsed_ms: int, expected: int) -> None:
    assert capped_dt_ms(elapsed_ms) == expected


def test_a_capped_stall_cannot_teleport_the_robot() -> None:
    dt_ms = capped_dt_ms(30_000)

    x, _y, _heading, arrived = step_towards(0.0, 0.0, Point(10.0, 0.0), speed_mps=1.0, dt_ms=dt_ms)

    assert arrived is False
    assert x == pytest.approx(0.2)


def test_an_idle_robot_drains_slowly() -> None:
    assert battery_after(100.0, state="IDLE", moving=False, dt_ms=1000) == pytest.approx(99.995)


def test_a_moving_robot_drains_faster_than_an_idle_one() -> None:
    moving = battery_after(100.0, state="MOVING", moving=True, dt_ms=1000)
    idle = battery_after(100.0, state="MOVING", moving=False, dt_ms=1000)

    assert moving == pytest.approx(99.98)
    assert moving < idle


def test_a_charging_robot_gains_charge() -> None:
    assert battery_after(50.0, state="CHARGING", moving=False, dt_ms=2000) == pytest.approx(51.0)


def test_charge_is_clamped_at_one_hundred() -> None:
    assert battery_after(99.9, state="CHARGING", moving=False, dt_ms=10_000) == 100.0


def test_charge_is_clamped_at_zero() -> None:
    assert battery_after(0.001, state="MOVING", moving=True, dt_ms=10_000) == 0.0
