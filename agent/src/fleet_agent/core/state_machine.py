"""Robot state machine: the transition table and the pure functions that read it.

Mirrors `packages/protocol/src/state-machine.ts` row for row. The TypeScript table is the source;
the parity tests compare this table with the generated `state-machine.json`, and fail on any
difference.

The table is written in set notation and expanded into one row per origin, trigger and guard. A
command pair with no row is refused with `INVALID_STATE`; an internal trigger with no row is
ignored.
Functions here are pure: the caller applies the returned effects to its own model.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal, cast

from fleet_agent.protocol.acks import AckReason
from fleet_agent.protocol.primitives import ReportedState
from fleet_agent.protocol.triggers import CLOUD_TRIGGERS, CloudTrigger, Trigger, command_triggers

RobotState = ReportedState | Literal["OFFLINE"]
"""Every state the cloud can hold for a robot, including the cloud-only `OFFLINE`."""

Origin = ReportedState | Literal["START"]
"""Where a row starts: a reported state, or the boot origin."""

Target = ReportedState | Literal["SAME", "RESUME_TARGET"]
"""Where a row ends: a state, the same state, or the stored resume target."""

Guard = Literal[
    "ALWAYS",
    "CAUSE_CLEARED",
    "CAUSE_PENDING",
    "DEST_CHARGER",
    "DEST_STATION",
    "CHARGE_REQUESTED",
    "MISSION_REMAINING",
    "MISSION_COMPLETE",
    "LATCH_SET",
    "LATCH_NOT_SET",
    "ESTOP_FROM_IDLE",
    "ESTOP_FROM_OTHER",
]
"""Conditions a row may depend on. `ALWAYS` holds unconditionally and is never passed."""

Effect = Literal[
    "STOP_MOTION",
    "ABORT_MISSION",
    "END_MISSION",
    "SET_DEST_CHARGER",
    "SET_DEST_STATION",
    "RESUME_TARGET_FROM",
    "RESUME_TARGET_IDLE",
    "MARK_CAUSE",
    "CLEAR_CAUSE",
    "REQUEST_CHARGE",
    "SET_BATTERY_LOW",
    "DROP_LINK",
    "ACQUIRE_LOCK",
    "RELEASE_LOCK",
    "LATCH_ESTOP",
    "CLEAR_ESTOP_LATCH",
    "RECORD_ESTOP_ORIGIN",
]
"""Side effects the caller applies to its model."""

Reply = Literal["ACK", "REJECT", "NONE"]
"""What the robot answers: `ACK`, `REJECT` with a reason, or `NONE`.

`NONE` is for internal triggers and for HEARTBEAT.
"""

CloudTarget = Literal["OFFLINE", "REPORTED"]
"""Target of a cloud row. `REPORTED` is the state the robot reports, resolved from the message."""

_ALL_REPORTED: tuple[ReportedState, ...] = (
    "IDLE",
    "WORKING",
    "MOVING",
    "CHARGING",
    "BLOCKED",
    "PAUSED",
    "TELEOP",
    "ESTOP",
)
_ACTIVE: tuple[ReportedState, ...] = ("IDLE", "WORKING", "MOVING", "CHARGING", "TELEOP")
MOTION_STATES: tuple[ReportedState, ...] = ("TELEOP", "MOVING", "WORKING")
"""States in which the robot moves or is teleoperated. The deadman and the lock apply to them."""

_BLOCK_EFFECTS: tuple[Effect, ...] = ("STOP_MOTION", "RESUME_TARGET_FROM", "MARK_CAUSE")


@dataclass(frozen=True, slots=True)
class TransitionRow:
    """One row of the robot table after expansion."""

    origin: Origin
    trigger: Trigger
    guard: Guard
    target: Target
    effects: tuple[Effect, ...]
    reply: Reply
    reason: AckReason | None


@dataclass(frozen=True, slots=True)
class CloudRow:
    """One row of the cloud table."""

    origin: RobotState
    trigger: CloudTrigger
    target: CloudTarget


@dataclass(frozen=True, slots=True)
class TransitionResult:
    """Outcome of a robot transition."""

    to: ReportedState
    reply: Reply
    reason: AckReason | None
    effects: tuple[Effect, ...]
    changed: bool


@dataclass(frozen=True, slots=True)
class CloudResult:
    """Outcome of a cloud transition."""

    to: RobotState
    changed: bool


@dataclass(frozen=True, slots=True)
class _Spec:
    """One line of the specification, in set notation, before expansion."""

    origins: tuple[Origin, ...]
    trigger: Trigger
    target: Target
    guard: Guard = "ALWAYS"
    effects: tuple[Effect, ...] = ()
    reply: Reply | None = None
    reason: AckReason | None = None


def _without(
    states: tuple[ReportedState, ...], *excluded: ReportedState
) -> tuple[ReportedState, ...]:
    r"""Removes states from a set, for the `ALL8 \ X` notation of the specification.

    Args:
        states: The set to narrow.
        *excluded: The states to remove.

    Returns:
        The remaining states, in their original order.
    """
    return tuple(state for state in states if state not in excluded)


_SPECS: tuple[_Spec, ...] = (
    # Command rows. A valid command is acknowledged unless the row says otherwise.
    _Spec(
        _without(_ALL_REPORTED, "ESTOP"),
        "ESTOP",
        "ESTOP",
        effects=("STOP_MOTION", "ABORT_MISSION", "LATCH_ESTOP", "RECORD_ESTOP_ORIGIN"),
    ),
    _Spec(("ESTOP",), "ESTOP", "SAME"),
    # The release goes back to IDLE only when the robot was IDLE at the e-stop. Any other
    # origin, and an origin lost in a reboot, goes to PAUSED: never into motion.
    _Spec(
        ("ESTOP",),
        "ESTOP_RELEASE",
        "IDLE",
        guard="ESTOP_FROM_IDLE",
        effects=("CLEAR_ESTOP_LATCH", "RESUME_TARGET_IDLE"),
    ),
    _Spec(
        ("ESTOP",),
        "ESTOP_RELEASE",
        "PAUSED",
        guard="ESTOP_FROM_OTHER",
        effects=("CLEAR_ESTOP_LATCH", "RESUME_TARGET_IDLE"),
    ),
    _Spec(_ACTIVE, "PAUSE", "PAUSED", effects=("STOP_MOTION", "RESUME_TARGET_FROM")),
    _Spec(("PAUSED",), "PAUSE", "SAME"),
    _Spec(("PAUSED",), "RESUME", "RESUME_TARGET"),
    _Spec(("BLOCKED",), "RESUME", "RESUME_TARGET", guard="CAUSE_CLEARED", effects=("CLEAR_CAUSE",)),
    _Spec(
        ("BLOCKED",),
        "RESUME",
        "SAME",
        guard="CAUSE_PENDING",
        reply="REJECT",
        reason="INVALID_STATE",
    ),
    _Spec(
        ("IDLE", "WORKING", "PAUSED", "BLOCKED", "TELEOP"),
        "RETURN_TO_BASE",
        "MOVING",
        effects=("ABORT_MISSION", "SET_DEST_CHARGER", "CLEAR_CAUSE"),
    ),
    _Spec(
        ("MOVING",),
        "RETURN_TO_BASE",
        "MOVING",
        guard="DEST_STATION",
        effects=("ABORT_MISSION", "SET_DEST_CHARGER"),
    ),
    _Spec(("MOVING",), "RETURN_TO_BASE", "SAME", guard="DEST_CHARGER"),
    _Spec(("CHARGING",), "RETURN_TO_BASE", "SAME"),
    _Spec(
        ("IDLE", "WORKING", "MOVING", "CHARGING", "PAUSED"),
        "TAKE_CONTROL",
        "TELEOP",
        effects=("ACQUIRE_LOCK", "STOP_MOTION", "ABORT_MISSION"),
    ),
    _Spec(("TELEOP",), "TAKE_CONTROL", "SAME", effects=("ACQUIRE_LOCK",)),
    _Spec(("BLOCKED", "ESTOP"), "TAKE_CONTROL", "SAME", effects=("ACQUIRE_LOCK",)),
    _Spec(
        ("TELEOP",),
        "RELEASE_CONTROL",
        "PAUSED",
        effects=("RELEASE_LOCK", "STOP_MOTION", "RESUME_TARGET_IDLE"),
    ),
    _Spec(_without(_ALL_REPORTED, "TELEOP"), "RELEASE_CONTROL", "SAME", effects=("RELEASE_LOCK",)),
    _Spec(_ALL_REPORTED, "HEARTBEAT", "SAME", reply="NONE"),
    _Spec(
        ("MOVING", "WORKING", "TELEOP"),
        "SIMULATE_FAULT:OBSTACLE",
        "BLOCKED",
        effects=_BLOCK_EFFECTS,
    ),
    _Spec(
        ("IDLE", "WORKING", "MOVING", "CHARGING", "PAUSED", "TELEOP"),
        "SIMULATE_FAULT:SENSOR_FAULT",
        "BLOCKED",
        effects=_BLOCK_EFFECTS,
    ),
    _Spec(
        _without(_ALL_REPORTED, "ESTOP"),
        "SIMULATE_FAULT:BATTERY_LOW",
        "SAME",
        effects=("SET_BATTERY_LOW",),
    ),
    _Spec(
        _without(_ALL_REPORTED, "ESTOP"), "SIMULATE_FAULT:LINK_LOSS", "SAME", effects=("DROP_LINK",)
    ),
    # Boot rows. The only rows whose origin is START; the latch chooses between ESTOP and IDLE.
    _Spec(("START",), "BOOT", "ESTOP", guard="LATCH_SET", reply="NONE"),
    _Spec(("START",), "BOOT", "IDLE", guard="LATCH_NOT_SET", reply="NONE"),
    # Internal rows. Raised by the robot and never acknowledged.
    _Spec(("IDLE",), "MISSION_ASSIGNED", "MOVING", effects=("SET_DEST_STATION",)),
    _Spec(("MOVING",), "ARRIVED", "WORKING", guard="DEST_STATION"),
    _Spec(("MOVING",), "ARRIVED", "CHARGING", guard="DEST_CHARGER"),
    _Spec(
        ("WORKING",),
        "WORK_DONE",
        "MOVING",
        guard="CHARGE_REQUESTED",
        effects=("END_MISSION", "SET_DEST_CHARGER"),
    ),
    _Spec(
        ("WORKING",),
        "WORK_DONE",
        "MOVING",
        guard="MISSION_REMAINING",
        effects=("SET_DEST_STATION",),
    ),
    _Spec(("WORKING",), "WORK_DONE", "IDLE", guard="MISSION_COMPLETE", effects=("END_MISSION",)),
    _Spec(("CHARGING",), "CHARGED", "IDLE"),
    _Spec(("MOVING", "TELEOP"), "OBSTACLE_DETECTED", "BLOCKED", effects=_BLOCK_EFFECTS),
    _Spec(
        ("IDLE", "WORKING", "MOVING", "CHARGING", "PAUSED", "TELEOP"),
        "SENSOR_FAULT",
        "BLOCKED",
        effects=_BLOCK_EFFECTS,
    ),
    _Spec(("BLOCKED",), "CAUSE_CLEARED", "SAME", effects=("CLEAR_CAUSE",)),
    _Spec(("IDLE",), "BATTERY_LOW", "MOVING", effects=("SET_DEST_CHARGER",)),
    _Spec(
        _without(_ALL_REPORTED, "IDLE", "CHARGING"),
        "BATTERY_LOW",
        "SAME",
        effects=("REQUEST_CHARGE",),
    ),
    _Spec(
        ("TELEOP", "MOVING", "WORKING"),
        "DEADMAN_EXPIRED",
        "PAUSED",
        effects=("STOP_MOTION", "RESUME_TARGET_FROM"),
    ),
    _Spec(
        ("TELEOP",),
        "LOCK_EXPIRED",
        "PAUSED",
        effects=("RELEASE_LOCK", "STOP_MOTION", "RESUME_TARGET_IDLE"),
    ),
    _Spec(_without(_ALL_REPORTED, "TELEOP"), "LOCK_EXPIRED", "SAME", effects=("RELEASE_LOCK",)),
)


def _expand(spec: _Spec) -> list[TransitionRow]:
    """Expands one specification line into one row per origin.

    A command defaults to `ACK` and an internal trigger to `NONE`. Only a `REJECT` row carries a
    reason.

    Args:
        spec: The line to expand.

    Returns:
        One row per origin in the line.
    """
    default_reply: Reply = "ACK" if spec.trigger in command_triggers() else "NONE"
    reply = spec.reply if spec.reply is not None else default_reply
    return [
        TransitionRow(
            origin=origin,
            trigger=spec.trigger,
            guard=spec.guard,
            target=spec.target,
            effects=spec.effects,
            reply=reply,
            reason=spec.reason,
        )
        for origin in spec.origins
    ]


TRANSITIONS: tuple[TransitionRow, ...] = tuple(row for spec in _SPECS for row in _expand(spec))
"""Every robot transition row, expanded. Treat as read-only."""

CLOUD_TRANSITIONS: tuple[CloudRow, ...] = (
    *(
        CloudRow(origin=state, trigger=trigger, target="OFFLINE")
        for state in _ALL_REPORTED
        for trigger in ("CLOUD_DISCONNECTED", "CLOUD_SILENCE_15S")
    ),
    CloudRow(origin="OFFLINE", trigger="ROBOT_REPORTED", target="REPORTED"),
)
"""Cloud rows.

Every reported state goes `OFFLINE` on a disconnect; `OFFLINE` returns to what the robot reports.
"""


def _matching_rows(
    origin: Origin, trigger: Trigger, guards: frozenset[Guard]
) -> list[TransitionRow]:
    """Lists every row for an origin and a trigger whose guard holds.

    Args:
        origin: The reported state, or START for a boot.
        trigger: The trigger that arrived.
        guards: The guards that hold; ALWAYS is implicit.

    Returns:
        The matching rows, in table order. The table makes this one row in every legal call.
    """
    return [
        row
        for row in TRANSITIONS
        if row.origin == origin
        and row.trigger == trigger
        and (row.guard == "ALWAYS" or row.guard in guards)
    ]


def _refusal(state: ReportedState) -> TransitionResult:
    """Outcome of a command the robot refuses without changing state.

    Args:
        state: The state the robot stays in.

    Returns:
        A `REJECT` with `INVALID_STATE`.
    """
    return TransitionResult(
        to=state, reply="REJECT", reason="INVALID_STATE", effects=(), changed=False
    )


def _ignored(state: ReportedState) -> TransitionResult:
    """Outcome of an internal trigger that no row handles: nothing happens and nothing is answered.

    Args:
        state: The state the robot stays in.

    Returns:
        A `NONE` reply without change.
    """
    return TransitionResult(to=state, reply="NONE", reason=None, effects=(), changed=False)


def _boot(trigger: Trigger, guards: frozenset[Guard]) -> TransitionResult:
    """Transition of the boot: the only rows whose origin is START. Exactly one latch must hold.

    Args:
        trigger: The trigger that arrived. Only BOOT has a boot row.
        guards: The guards that hold.

    Returns:
        The boot outcome; a boot always changes the state.

    Raises:
        TypeError: If zero or two boot rows match.
    """
    matches = _matching_rows("START", trigger, guards)
    if len(matches) != 1:
        raise TypeError("a boot needs exactly one of LATCH_SET or LATCH_NOT_SET")
    row = matches[0]
    # Every START row targets a reported state (a test checks it), so the target is narrowed by the
    # table rather than by a run-time branch.
    return TransitionResult(
        to=cast("ReportedState", row.target),
        reply=row.reply,
        reason=row.reason,
        effects=row.effects,
        changed=True,
    )


def _reported(
    origin: ReportedState,
    trigger: Trigger,
    guards: frozenset[Guard],
    resume_target: ReportedState | None,
) -> TransitionResult:
    """Transition of a robot that has reported a state. Fails closed when two rows match.

    Args:
        origin: The reported state the robot is in.
        trigger: The trigger that arrived.
        guards: The guards that hold.
        resume_target: The stored resume target, used by rows that resume.

    Returns:
        The outcome of the transition.

    Raises:
        TypeError: If an internal trigger matches two rows, or a resuming row has no target.
    """
    is_command = trigger in command_triggers()
    matches = _matching_rows(origin, trigger, guards)
    if len(matches) > 1:
        # Rival rows mean the guards are not exclusive. A command is refused; an internal trigger
        # has no
        # safe answer and must not be guessed.
        if is_command:
            return _refusal(origin)
        raise TypeError("two rows match an internal trigger: the guards must be exclusive")
    if not matches:
        return _refusal(origin) if is_command else _ignored(origin)
    row = matches[0]
    to: ReportedState
    if row.target == "SAME":
        to = origin
    elif row.target == "RESUME_TARGET":
        if resume_target is None:
            raise TypeError("this transition resumes and needs the stored resume target")
        to = resume_target
    else:
        to = row.target
    return TransitionResult(
        to=to,
        reply=row.reply,
        reason=row.reason,
        effects=row.effects,
        changed=to != origin,
    )


def transition(
    origin: RobotState | Literal["START"],
    trigger: Trigger,
    guards: Iterable[Guard] = (),
    resume_target: ReportedState | None = None,
) -> TransitionResult:
    """Computes the outcome of a robot trigger. It is pure: the caller applies the returned effects.

    The guards passed must be exclusive: the caller evaluates the conditions of its model and passes
    the ones that hold. If two rival rows match anyway, a command is refused with `INVALID_STATE`
    and an
    internal trigger raises, so an inconsistent model fails closed. A pair with no row is refused
    when it
    is a command and ignored otherwise. The `OFFLINE` origin is never consulted: the robot cannot
    act
    while the cloud holds it offline.

    Args:
        origin: The current reported state, or START for a boot.
        trigger: The trigger that arrived.
        guards: The guards that hold; ALWAYS is implicit.
        resume_target: The stored resume target. Required only by rows that resume; never ESTOP.

    Returns:
        The target, the reply, its reason, the effects and whether the state changed.

    Raises:
        TypeError: If the origin is OFFLINE, the resume target is ESTOP or missing when needed, a
        boot has
            no single latch guard, or an internal trigger matches two rows.
    """
    if origin == "OFFLINE":
        raise TypeError("a robot cannot act while the cloud holds it OFFLINE")
    if resume_target == "ESTOP":
        raise TypeError("ESTOP is never a resume target")
    guard_set = frozenset(guards)
    if origin == "START":
        return _boot(trigger, guard_set)
    return _reported(origin, trigger, guard_set, resume_target)


def transition_cloud(
    state: RobotState,
    trigger: CloudTrigger,
    reported: ReportedState | None = None,
) -> CloudResult:
    """Computes the cloud view of a robot.

    It is `OFFLINE` on disconnect or silence, and the reported state again once the robot speaks.

    Args:
        state: The state the cloud currently holds for the robot.
        trigger: The cloud trigger. Checked again at run time, because it may come from outside.
        reported: The state the robot reported. Required only by ROBOT_REPORTED from OFFLINE.

    Returns:
        The new state and whether it changed. A pair with no row returns the state unchanged.

    Raises:
        TypeError: If the trigger is unknown, or the row needs the reported state and it was not
        given.
    """
    if trigger not in CLOUD_TRIGGERS:
        raise TypeError("unknown cloud trigger")
    for row in CLOUD_TRANSITIONS:
        if row.origin == state and row.trigger == trigger:
            if row.target == "REPORTED":
                if reported is None:
                    raise TypeError("ROBOT_REPORTED needs the state the robot reported")
                return CloudResult(to=reported, changed=reported != state)
            return CloudResult(to="OFFLINE", changed=state != "OFFLINE")
    return CloudResult(to=state, changed=False)
