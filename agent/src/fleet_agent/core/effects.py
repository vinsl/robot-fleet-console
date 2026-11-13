"""Effects: the side effects of an accepted transition, on the model, the lock and the latch.

The state machine decides what must happen and returns the effects as names. This module does it.
The preconditions are checked first, and they return the values the lock grant and the latch write
need, so the application never looks at the context again. Every precondition is checked before the
first mutation, so an `EffectError` always leaves the model and the lock as they were. The e-stop
latch is cleared before anything else changes, because that is the only effect that can fail after
the checks. The grant and the latch write come after the model effects: they take their values from
the checks, and no transition that grants or latches also has a model effect that reads the lock or
the latch.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, assert_never

from fleet_agent.core.constants import FAULT_DEFAULT_DURATION_MS
from fleet_agent.core.lock import LockChangeKind, LockHolder, RobotLock
from fleet_agent.core.model import Destination, RobotModel, SiteGeometry
from fleet_agent.core.ports import LatchRecord, LatchStore, LatchWriteError
from fleet_agent.core.state_machine import Effect
from fleet_agent.protocol.constants import BATTERY_LOW_PERCENT
from fleet_agent.protocol.primitives import FaultCode, ReportedState
from fleet_agent.protocol.triggers import Trigger

LatchOutcome = Literal["SET", "SET_FAILED", "CLEARED"]
"""What happened to the e-stop latch during the transition."""

_CAUSE_FAULT: Mapping[Trigger, FaultCode] = {
    "OBSTACLE_DETECTED": "OBSTACLE",
    "SIMULATE_FAULT:OBSTACLE": "OBSTACLE",
    "SENSOR_FAULT": "SENSOR_FAULT",
    "SIMULATE_FAULT:SENSOR_FAULT": "SENSOR_FAULT",
}
"""The fault each trigger that blocks the robot raises."""

_TIMED_CAUSES: frozenset[Trigger] = frozenset(
    {"SIMULATE_FAULT:OBSTACLE", "SIMULATE_FAULT:SENSOR_FAULT"}
)
"""Triggers whose fault clears after a duration. The internal triggers clear on their own event."""


class EffectError(Exception):
    """An accepted transition cannot be applied. Nothing was changed.

    The text is fixed: it never carries the values involved, so it is safe in a log line.
    """


@dataclass(frozen=True, slots=True)
class EffectContext:
    """What the effects need to know about the transition that produced them.

    Attributes:
        trigger: The trigger that was accepted.
        origin: The state the robot was in before the transition, for resume rows.
        now_ms: The current monotonic time, in milliseconds.
        boot_id: The boot the robot is running, recorded in the latch.
        command_id: The command that raised the trigger, None for an internal trigger.
        holder: The lock identity of the command, for a row that acquires the lock.
        fault_duration_ms: The duration a simulated fault asked for, when it gave one.
        wall_iso: The wall time as ISO 8601, recorded in the latch.
    """

    trigger: Trigger
    origin: ReportedState
    now_ms: int
    boot_id: str
    command_id: str | None
    holder: LockHolder | None
    fault_duration_ms: int | None
    wall_iso: str


@dataclass(slots=True)
class EffectOutcome:
    """What the effects changed that the caller must report to the cloud.

    Attributes:
        lock_change: The lock event to publish, if the lock changed in a visible way.
        fault_raised: The fault that appeared, if one did.
        fault_cleared: The fault that went away, if one did.
        drop_link_ms: How long to drop the link, when the transition asked for it.
        latch: What happened to the latch.
    """

    lock_change: LockChangeKind | None = None
    fault_raised: FaultCode | None = None
    fault_cleared: FaultCode | None = None
    drop_link_ms: int | None = None
    latch: LatchOutcome | None = None


@dataclass(frozen=True, slots=True)
class _Checked:
    """The values the preconditions validated. Each is set exactly when its effect is requested.

    Attributes:
        grant: The holder the lock is granted to, when `ACQUIRE_LOCK` is requested.
        latch_command_id: The command that sets the latch, when `LATCH_ESTOP` is requested.
    """

    grant: LockHolder | None
    latch_command_id: str | None


def apply_effects(
    effects: tuple[Effect, ...],
    model: RobotModel,
    lock: RobotLock,
    latch: LatchStore,
    geometry: SiteGeometry,
    ctx: EffectContext,
) -> EffectOutcome:
    """Applies the effects of an accepted transition, and reports what changed.

    Args:
        effects: The effect names the state machine returned.
        model: The robot model to mutate.
        lock: The robot lock to mutate.
        latch: The e-stop latch store.
        geometry: The site layout, for the charger position.
        ctx: The transition's context.

    Returns:
        What changed, for the caller to publish.

    Raises:
        EffectError: If a precondition fails or the latch cannot be cleared. Nothing was changed.
    """
    checked = _check_preconditions(effects, lock, ctx)
    outcome = EffectOutcome()
    if "CLEAR_ESTOP_LATCH" in effects:
        _clear_latch(latch, outcome)
    for effect in effects:
        _apply_one(effect, model, lock, geometry, ctx, outcome)
    if checked.grant is not None:
        outcome.lock_change = lock.acquire(checked.grant, ctx.now_ms)
    if checked.latch_command_id is not None:
        _set_latch(latch, checked.latch_command_id, ctx, outcome)
    return outcome


def _check_preconditions(
    effects: tuple[Effect, ...], lock: RobotLock, ctx: EffectContext
) -> _Checked:
    """Refuses effects that cannot be applied, and returns the values the others need.

    Args:
        effects: The effect names of the transition.
        lock: The robot lock, to check that a holder may take it.
        ctx: The transition's context.

    Returns:
        The validated grant and latch command.

    Raises:
        EffectError: If an effect lacks the context it needs.
    """
    grant: LockHolder | None = None
    if "ACQUIRE_LOCK" in effects:
        holder = ctx.holder
        if holder is None or not lock.can_take(holder):
            raise EffectError("the lock cannot be granted to this holder")
        grant = holder
    if "MARK_CAUSE" in effects and ctx.trigger not in _CAUSE_FAULT:
        raise EffectError("the trigger does not raise a fault")
    latch_command_id: str | None = None
    if "LATCH_ESTOP" in effects:
        command_id = ctx.command_id
        if command_id is None:
            raise EffectError("the latch needs the command that set it")
        latch_command_id = command_id
    return _Checked(grant=grant, latch_command_id=latch_command_id)


def _clear_latch(latch: LatchStore, outcome: EffectOutcome) -> None:
    """Removes the e-stop latch. This is the only failure that refuses a release.

    Args:
        latch: The latch store.
        outcome: Receives the latch outcome.

    Raises:
        EffectError: If the latch cannot be removed. The robot must stay stopped.
    """
    try:
        latch.clear()
    except LatchWriteError as err:
        raise EffectError("the e-stop latch cannot be cleared") from err
    outcome.latch = "CLEARED"


def _apply_one(
    effect: Effect,
    model: RobotModel,
    lock: RobotLock,
    geometry: SiteGeometry,
    ctx: EffectContext,
    outcome: EffectOutcome,
) -> None:
    """Applies one effect. The mapping is exhaustive; a new effect name fails the type check.

    The grant, the latch write and the latch clear are applied by `apply_effects` from the checked
    values, so their names are matched here only to keep the mapping exhaustive.

    Args:
        effect: The effect to apply.
        model: The robot model to mutate.
        lock: The robot lock to mutate.
        geometry: The site layout.
        ctx: The transition's context.
        outcome: Receives what changed.
    """
    match effect:
        case "STOP_MOTION":
            model.speed = 0.0
        case "ABORT_MISSION":
            model.mission_id = None
            model.mission_stations = []
            model.destination = None
        case "END_MISSION":
            model.mission_id = None
            model.mission_stations = []
        case "SET_DEST_CHARGER":
            model.destination = Destination("CHARGER", geometry.charger)
            model.charge_requested = False
        case "SET_DEST_STATION":
            model.destination = (
                Destination("STATION", model.mission_stations.pop(0))
                if model.mission_stations
                else None
            )
        case "RESUME_TARGET_FROM":
            model.resume_target = ctx.origin
        case "RESUME_TARGET_IDLE":
            model.resume_target = "IDLE"
        case "MARK_CAUSE":
            _mark_cause(model, ctx, outcome)
        case "CLEAR_CAUSE":
            _clear_cause(model, outcome)
        case "REQUEST_CHARGE":
            model.charge_requested = True
        case "SET_BATTERY_LOW":
            model.battery = min(model.battery, BATTERY_LOW_PERCENT - 1)
        case "DROP_LINK":
            outcome.drop_link_ms = ctx.fault_duration_ms or FAULT_DEFAULT_DURATION_MS["LINK_LOSS"]
            model.link_loss_active = True
            outcome.fault_raised = "LINK_LOSS"
        case "RELEASE_LOCK":
            if lock.release():
                outcome.lock_change = "RELEASED"
        case "RECORD_ESTOP_ORIGIN":
            model.estop_from_idle = ctx.origin == "IDLE"
        case "CLEAR_ESTOP_LATCH":
            # The latch file is cleared first (`_clear_latch`) and a failed clear never gets
            # here, so the origin is forgotten only once the e-stop is really left.
            model.estop_from_idle = False
        case "ACQUIRE_LOCK" | "LATCH_ESTOP":
            # Applied by `apply_effects` from the checked values.
            pass
        case _:
            assert_never(effect)


def _mark_cause(model: RobotModel, ctx: EffectContext, outcome: EffectOutcome) -> None:
    """Blocks the robot on a cause. A simulated cause also gets a clearing time.

    Args:
        model: The robot model to mutate.
        ctx: The transition's context, whose trigger selects the fault.
        outcome: Receives the fault raised.
    """
    fault = _CAUSE_FAULT[ctx.trigger]
    model.cause_pending = True
    model.fault = fault
    if ctx.trigger in _TIMED_CAUSES:
        duration_ms = ctx.fault_duration_ms or FAULT_DEFAULT_DURATION_MS[fault]
        model.cause_clear_at_ms = ctx.now_ms + duration_ms
    else:
        model.cause_clear_at_ms = None
    outcome.fault_raised = fault


def _clear_cause(model: RobotModel, outcome: EffectOutcome) -> None:
    """Unblocks the robot. A fault is reported as cleared only if one was set.

    Args:
        model: The robot model to mutate.
        outcome: Receives the fault cleared, if any.
    """
    if model.fault is not None:
        outcome.fault_cleared = model.fault
    model.cause_pending = False
    model.fault = None
    model.cause_clear_at_ms = None


def _set_latch(
    latch: LatchStore, command_id: str, ctx: EffectContext, outcome: EffectOutcome
) -> None:
    """Latches an e-stop. A write failure does not stop the robot, so it is reported, not raised.

    The stop is applied in memory whether or not the latch could be written; refusing an e-stop
    because a disk failed would leave the robot moving.

    Args:
        latch: The latch store.
        command_id: The command that sets the latch.
        ctx: The transition's context, which holds the boot identifier and the wall time.
        outcome: Receives the latch outcome.
    """
    record = LatchRecord(command_id=command_id, boot_id=ctx.boot_id, latched_at=ctx.wall_iso)
    try:
        latch.set(record)
    except LatchWriteError:
        outcome.latch = "SET_FAILED"
    else:
        outcome.latch = "SET"
