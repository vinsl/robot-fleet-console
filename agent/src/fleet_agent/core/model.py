"""The robot's model: where it is, what it carries and which conditions hold for its transitions.

The model is the only mutable state of the core. Transition effects change most of it, in
`fleet_agent.core.effects`. The agent writes the rest directly: the motion step sets the position,
heading and speed, the battery step sets the charge and `battery_low_active`, a reconnection clears
`link_loss_active`, and a halt zeroes the speed and clears the destination. The guards computed here
are the exclusive conditions that the state machine reads, so the transition table never sees two
rival rows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from fleet_agent.core.state_machine import Guard
from fleet_agent.protocol.primitives import FaultCode, ReportedState


@dataclass(frozen=True, slots=True)
class Point:
    """A position on the site plane, in metres.

    Attributes:
        x: Position on the x axis.
        y: Position on the y axis.
    """

    x: float
    y: float


@dataclass(frozen=True, slots=True)
class Destination:
    """Where the robot is heading: its charger, or the next station of its mission.

    Attributes:
        kind: The destination family, which the state machine's guards read.
        point: The position to reach.
    """

    kind: Literal["CHARGER", "STATION"]
    point: Point


@dataclass(frozen=True, slots=True)
class SiteGeometry:
    """The fixed layout of the site the robot works in, from its configuration.

    Attributes:
        charger: The position of the charger.
        start: The position the robot starts from when it boots.
        start_heading: The heading the robot starts with, in radians.
        speed_mps: The cruise speed while moving, in metres per second.
    """

    charger: Point
    start: Point
    start_heading: float
    speed_mps: float


@dataclass(slots=True)
class RobotModel:
    """The mutable state of the robot that the transitions act on.

    Attributes:
        state: The reported state.
        resume_target: The state a resuming row returns to. None when nothing is stored.
        x: Position on the x axis, in metres.
        y: Position on the y axis, in metres.
        heading: Heading in radians.
        speed: Current speed in metres per second. Zero unless the robot is moving.
        battery: Charge in percent.
        destination: The point being driven to, if any.
        mission_id: The mission in progress, if any.
        mission_stations: The stations still to visit, in order.
        charge_requested: Whether a charge was asked for during the mission.
        cause_pending: Whether a fault currently blocks the robot.
        fault: The fault that blocks the robot, when one does.
        cause_clear_at_ms: The monotonic time at which a simulated fault clears, if timed.
        battery_low_active: Whether the battery-low fault has been raised and not yet cleared.
        link_loss_active: Whether a simulated link loss is in progress.
        estop_from_idle: Whether the robot was IDLE when the e-stop hit. Kept in memory only, so a
            reboot while latched forgets it and the release fails safe to PAUSED.
    """

    state: ReportedState
    resume_target: ReportedState | None
    x: float
    y: float
    heading: float
    speed: float
    battery: float
    destination: Destination | None = None
    mission_id: str | None = None
    mission_stations: list[Point] = field(default_factory=list)
    charge_requested: bool = False
    cause_pending: bool = False
    fault: FaultCode | None = None
    cause_clear_at_ms: int | None = None
    battery_low_active: bool = False
    link_loss_active: bool = False
    estop_from_idle: bool = False


def guards_for(model: RobotModel) -> frozenset[Guard]:
    """Computes the exclusive conditions that hold for the model, for the state machine.

    Each family yields exactly one guard, so no transition row can match twice: the cause family
    is pending or cleared, the destination family is charger or station (or none), and the
    work-done family is charge requested, stations remaining or mission complete, in that priority.
    The e-stop family is from-idle or other, and other covers an unknown origin. Latch guards are
    not computed here; the boot passes them.

    Args:
        model: The robot's current model.

    Returns:
        The guards that hold.
    """
    guards: set[Guard] = {"CAUSE_PENDING" if model.cause_pending else "CAUSE_CLEARED"}
    if model.destination is not None:
        guards.add("DEST_CHARGER" if model.destination.kind == "CHARGER" else "DEST_STATION")
    if model.charge_requested:
        guards.add("CHARGE_REQUESTED")
    elif model.mission_stations:
        guards.add("MISSION_REMAINING")
    else:
        guards.add("MISSION_COMPLETE")
    guards.add(
        "ESTOP_FROM_IDLE"
        if model.estop_from_idle and model.state == "ESTOP"
        else "ESTOP_FROM_OTHER"
    )
    return frozenset(guards)
