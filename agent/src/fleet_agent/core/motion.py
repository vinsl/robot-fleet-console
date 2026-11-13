"""Motion and battery integration: how the robot moves toward a target and how its charge changes.

Both functions are pure and take a time step in milliseconds. The step is capped before it is
integrated, so a pause of the process (a VM stall, a long garbage collection) cannot teleport the
robot or drain its battery in one jump.
"""

from __future__ import annotations

import math

from fleet_agent.core.constants import (
    ARRIVAL_TOLERANCE_M,
    BATTERY_CHARGE_PER_S,
    BATTERY_DRAIN_IDLE_PER_S,
    BATTERY_DRAIN_MOVING_PER_S,
    MIN_CREEP_MPS,
    MOTION_STALL_CAP_MS,
)
from fleet_agent.core.model import Point
from fleet_agent.protocol.primitives import ReportedState

_BATTERY_MIN = 0.0
_BATTERY_MAX = 100.0


def capped_dt_ms(elapsed_ms: int) -> int:
    """Bounds an elapsed time before it is integrated, so a stall cannot jump the model.

    Args:
        elapsed_ms: The time since the previous tick, in milliseconds, non-negative.

    Returns:
        The elapsed time, or `MOTION_STALL_CAP_MS` when it is larger.
    """
    return min(elapsed_ms, MOTION_STALL_CAP_MS)


def next_speed(
    current_mps: float, cruise_mps: float, accel_mps2: float, remaining_m: float, dt_ms: int
) -> float:
    """Computes the speed for the next step: it ramps up, and brakes in time for the target.

    The speed rises at `accel_mps2` from the current speed, up to the cruise speed. It never exceeds
    the speed from which the robot can still stop on the target, so it does not overshoot, and never
    drops below the creep speed while the target is ahead, so it does not stall short of it.

    Args:
        current_mps: The speed at the end of the previous step, in metres per second.
        cruise_mps: The speed the robot may reach, in metres per second.
        accel_mps2: The acceleration and braking rate, in metres per second squared.
        remaining_m: The distance to the target, in metres. Negative values count as zero.
        dt_ms: The time step, in milliseconds, already capped by the caller.

    Returns:
        The speed for the step, in metres per second.
    """
    braking = math.sqrt(2 * accel_mps2 * max(remaining_m, 0.0))
    return min(cruise_mps, current_mps + accel_mps2 * dt_ms / 1000, max(braking, MIN_CREEP_MPS))


def step_towards(
    x: float, y: float, target: Point, speed_mps: float, dt_ms: int
) -> tuple[float, float, float, bool]:
    """Advances the robot one step toward a target, in a straight line.

    The robot counts as arrived when, after the step, the remaining distance is within the arrival
    tolerance, or when the step would overshoot. An arrival snaps the position onto the target, so
    the model never rests a few centimetres short of a station.

    The heading is the direction of the target from the current position. When the robot is
    already on the target the direction is undefined, and it is reported as zero.

    Args:
        x: Current position on the x axis, in metres.
        y: Current position on the y axis, in metres.
        target: The point to reach.
        speed_mps: The speed while moving, in metres per second, non-negative.
        dt_ms: The time step, in milliseconds, already capped by the caller.

    Returns:
        The new x, the new y, the heading in radians, and whether the robot has arrived.
    """
    dx = target.x - x
    dy = target.y - y
    distance = math.hypot(dx, dy)
    heading = math.atan2(dy, dx)
    step = speed_mps * dt_ms / 1000
    if distance - step <= ARRIVAL_TOLERANCE_M:
        return target.x, target.y, heading, True
    ratio = step / distance
    return x + dx * ratio, y + dy * ratio, heading, False


def battery_after(battery: float, *, state: ReportedState, moving: bool, dt_ms: int) -> float:
    """Computes the charge after a time step: it rises while charging and falls otherwise.

    A moving robot drains faster than a stationary one. The result is clamped to [0, 100], so the
    model never reports a charge outside the protocol's bounds.

    Args:
        battery: The current charge, in percent.
        state: The reported state. A charging robot gains charge.
        moving: Whether the robot is moving, which selects the drain rate.
        dt_ms: The time step, in milliseconds, already capped by the caller.

    Returns:
        The new charge, in percent, within [0, 100].
    """
    seconds = dt_ms / 1000
    if state == "CHARGING":
        delta = BATTERY_CHARGE_PER_S * seconds
    elif moving:
        delta = -BATTERY_DRAIN_MOVING_PER_S * seconds
    else:
        delta = -BATTERY_DRAIN_IDLE_PER_S * seconds
    return min(max(battery + delta, _BATTERY_MIN), _BATTERY_MAX)
