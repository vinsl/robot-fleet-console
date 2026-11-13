"""Effects: one case per effect, the latch veto, the failure semantics and the order of application.

A refused effect must leave the model, the lock and the latch as they were. The tests compare the
whole model before and after, so a field changed by mistake is caught even when it is not asserted
by name.
"""

from __future__ import annotations

import copy

import pytest

from fleet_agent.core.constants import FAULT_DEFAULT_DURATION_MS
from fleet_agent.core.effects import EffectContext, EffectError, EffectOutcome, apply_effects
from fleet_agent.core.lock import LockHolder, RobotLock
from fleet_agent.core.model import Destination, Point, RobotModel, guards_for
from fleet_agent.core.ports import LatchRecord
from fleet_agent.core.state_machine import Effect, transition
from fleet_agent.protocol.primitives import ReportedState
from fleet_agent.protocol.triggers import Trigger
from fleet_agent.timefmt import format_iso_ms

from .fakes import LOCK_TOKEN, OPERATOR_SUB, SITE, WALL_ORIGIN_MS, MemoryLatchStore, make_model

COMMAND_ID = "0190f2c4-7b1a-7c3d-8e4f-5a6b7c8d9e0f"
BOOT_ID = "0190f2c4-7b1a-7c3d-8e4f-5a6b7c8d9e01"
NOW_MS = 5000
HOLDER = LockHolder(token=LOCK_TOKEN, sub=OPERATOR_SUB)
OTHER_HOLDER = LockHolder(token="other-token-0123456789", sub="operator-sub-2")  # noqa: S106
STATION = Point(4.0, 4.0)


def _ctx(
    trigger: Trigger = "PAUSE",
    *,
    origin: ReportedState = "IDLE",
    holder: LockHolder | None = None,
    fault_duration_ms: int | None = None,
    command_id: str | None = COMMAND_ID,
) -> EffectContext:
    """Builds the context of a transition, with the test's clock and identifiers."""
    return EffectContext(
        trigger=trigger,
        origin=origin,
        now_ms=NOW_MS,
        boot_id=BOOT_ID,
        command_id=command_id,
        holder=holder,
        fault_duration_ms=fault_duration_ms,
        wall_iso=format_iso_ms(WALL_ORIGIN_MS),
    )


def _run(
    effects: tuple[Effect, ...],
    model: RobotModel,
    *,
    lock: RobotLock | None = None,
    latch: MemoryLatchStore | None = None,
    ctx: EffectContext | None = None,
) -> EffectOutcome:
    """Applies effects with defaults for the parts a test does not care about."""
    return apply_effects(
        effects,
        model,
        lock if lock is not None else RobotLock(),
        latch if latch is not None else MemoryLatchStore(),
        SITE,
        ctx if ctx is not None else _ctx(),
    )


def test_stop_motion_zeroes_the_speed_and_keeps_the_destination() -> None:
    model = make_model(state="MOVING")
    model.speed = 1.0
    model.destination = Destination("STATION", STATION)

    _run(("STOP_MOTION",), model)

    assert model.speed == 0.0
    assert model.destination == Destination("STATION", STATION)


def test_abort_mission_clears_the_mission_and_the_destination() -> None:
    model = make_model(state="MOVING")
    model.mission_id = "mission-1"
    model.mission_stations = [STATION]
    model.destination = Destination("STATION", STATION)

    _run(("ABORT_MISSION",), model)

    assert (model.mission_id, model.mission_stations, model.destination) == (None, [], None)


def test_end_mission_clears_the_mission_and_keeps_the_destination() -> None:
    model = make_model(state="WORKING")
    model.mission_id = "mission-1"
    model.mission_stations = [STATION]
    model.destination = Destination("STATION", STATION)

    _run(("END_MISSION",), model)

    assert (model.mission_id, model.mission_stations) == (None, [])
    assert model.destination == Destination("STATION", STATION)


def test_set_dest_charger_points_at_the_charger_and_drops_the_charge_request() -> None:
    model = make_model(state="WORKING")
    model.charge_requested = True

    _run(("SET_DEST_CHARGER",), model)

    assert model.destination == Destination("CHARGER", SITE.charger)
    assert model.charge_requested is False


def test_set_dest_station_takes_the_first_station_of_the_mission() -> None:
    model = make_model(state="IDLE")
    model.mission_stations = [STATION, Point(8.0, 8.0)]

    _run(("SET_DEST_STATION",), model)

    assert model.destination == Destination("STATION", STATION)
    assert model.mission_stations == [Point(8.0, 8.0)]


def test_set_dest_station_with_no_station_left_clears_the_destination() -> None:
    model = make_model(state="IDLE")
    model.destination = Destination("STATION", STATION)

    _run(("SET_DEST_STATION",), model)

    assert model.destination is None


def test_resume_target_from_stores_the_state_the_robot_came_from() -> None:
    model = make_model(state="TELEOP")

    _run(("RESUME_TARGET_FROM",), model, ctx=_ctx(origin="TELEOP"))

    assert model.resume_target == "TELEOP"


def test_resume_target_idle_stores_idle() -> None:
    model = make_model(state="PAUSED")

    _run(("RESUME_TARGET_IDLE",), model)

    assert model.resume_target == "IDLE"


@pytest.mark.parametrize(
    ("trigger", "duration", "expected_fault", "expected_clear_at"),
    [
        (
            "SIMULATE_FAULT:OBSTACLE",
            None,
            "OBSTACLE",
            NOW_MS + FAULT_DEFAULT_DURATION_MS["OBSTACLE"],
        ),
        ("SIMULATE_FAULT:SENSOR_FAULT", 5000, "SENSOR_FAULT", NOW_MS + 5000),
        ("OBSTACLE_DETECTED", None, "OBSTACLE", None),
        ("SENSOR_FAULT", None, "SENSOR_FAULT", None),
    ],
    ids=["simulated-obstacle-default", "simulated-sensor-timed", "obstacle-event", "sensor-event"],
)
def test_mark_cause_blocks_the_robot_and_times_only_simulated_faults(
    trigger: Trigger, duration: int | None, expected_fault: str, expected_clear_at: int | None
) -> None:
    model = make_model(state="MOVING")
    model.speed = 1.0

    outcome = _run(
        ("STOP_MOTION", "MARK_CAUSE"),
        model,
        ctx=_ctx(trigger, fault_duration_ms=duration),
    )

    assert model.cause_pending is True
    assert model.fault == expected_fault
    assert model.cause_clear_at_ms == expected_clear_at
    assert outcome.fault_raised == expected_fault


def test_clear_cause_reports_the_fault_it_clears() -> None:
    model = make_model(state="BLOCKED")
    model.cause_pending = True
    model.fault = "OBSTACLE"
    model.cause_clear_at_ms = 9000

    outcome = _run(("CLEAR_CAUSE",), model)

    assert outcome.fault_cleared == "OBSTACLE"
    assert (model.cause_pending, model.fault, model.cause_clear_at_ms) == (False, None, None)


def test_clear_cause_with_no_fault_reports_nothing() -> None:
    model = make_model(state="IDLE")

    outcome = _run(("CLEAR_CAUSE",), model)

    assert outcome.fault_cleared is None


def test_request_charge_marks_the_mission_for_a_charge() -> None:
    model = make_model(state="WORKING")

    _run(("REQUEST_CHARGE",), model)

    assert model.charge_requested is True


def test_set_battery_low_lands_just_under_the_threshold() -> None:
    model = make_model(state="IDLE")
    model.battery = 80.0

    _run(("SET_BATTERY_LOW",), model)

    assert model.battery == 19.0


def test_set_battery_low_never_raises_a_low_battery() -> None:
    model = make_model(state="IDLE")
    model.battery = 10.0

    _run(("SET_BATTERY_LOW",), model)

    assert model.battery == 10.0


def test_drop_link_uses_the_link_loss_default_and_raises_the_fault() -> None:
    model = make_model(state="IDLE")

    outcome = _run(("DROP_LINK",), model)

    assert outcome.drop_link_ms == FAULT_DEFAULT_DURATION_MS["LINK_LOSS"]
    assert outcome.fault_raised == "LINK_LOSS"
    assert model.link_loss_active is True


def test_drop_link_honours_the_requested_duration() -> None:
    model = make_model(state="IDLE")

    outcome = _run(
        ("DROP_LINK",), model, ctx=_ctx("SIMULATE_FAULT:LINK_LOSS", fault_duration_ms=3000)
    )

    assert outcome.drop_link_ms == 3000


def test_acquire_lock_on_a_free_lock_reports_acquired() -> None:
    lock = RobotLock()

    outcome = _run(
        ("ACQUIRE_LOCK",), make_model(), lock=lock, ctx=_ctx("TAKE_CONTROL", holder=HOLDER)
    )

    assert outcome.lock_change == "ACQUIRED"
    assert lock.holder == HOLDER


def test_acquire_lock_after_an_expiry_by_another_holder_reports_a_takeover() -> None:
    lock = RobotLock()
    lock.acquire(OTHER_HOLDER, NOW_MS)
    lock.expire()

    outcome = _run(
        ("ACQUIRE_LOCK",), make_model(), lock=lock, ctx=_ctx("TAKE_CONTROL", holder=HOLDER)
    )

    assert outcome.lock_change == "TAKEOVER"


def test_acquire_lock_by_the_holder_reports_a_refresh() -> None:
    lock = RobotLock()
    lock.acquire(HOLDER, NOW_MS)

    outcome = _run(
        ("ACQUIRE_LOCK",), make_model(), lock=lock, ctx=_ctx("TAKE_CONTROL", holder=HOLDER)
    )

    assert outcome.lock_change == "REFRESHED"


def test_release_lock_reports_a_release_only_when_a_lock_was_held() -> None:
    held = RobotLock()
    held.acquire(HOLDER, NOW_MS)
    free = RobotLock()

    released = _run(("RELEASE_LOCK",), make_model(), lock=held)
    nothing = _run(("RELEASE_LOCK",), make_model(), lock=free)

    assert (released.lock_change, held.held) == ("RELEASED", False)
    assert nothing.lock_change is None


def test_latch_estop_records_the_command_boot_and_time() -> None:
    latch = MemoryLatchStore()

    outcome = _run(("LATCH_ESTOP",), make_model(), latch=latch, ctx=_ctx("ESTOP"))

    assert outcome.latch == "SET"
    assert latch.record == LatchRecord(
        command_id=COMMAND_ID,
        boot_id=BOOT_ID,
        latched_at=format_iso_ms(WALL_ORIGIN_MS),
    )


def test_clear_estop_latch_removes_the_record() -> None:
    latch = MemoryLatchStore(latched=True)

    outcome = _run(("CLEAR_ESTOP_LATCH",), make_model(state="ESTOP"), latch=latch)

    assert outcome.latch == "CLEARED"
    assert latch.record is None


def test_record_estop_origin_remembers_whether_the_robot_was_idle() -> None:
    idle = make_model()
    moving = make_model(state="MOVING")

    _run(("RECORD_ESTOP_ORIGIN",), idle, ctx=_ctx("ESTOP", origin="IDLE"))
    _run(("RECORD_ESTOP_ORIGIN",), moving, ctx=_ctx("ESTOP", origin="MOVING"))

    assert idle.estop_from_idle is True
    assert moving.estop_from_idle is False


def test_clear_estop_latch_forgets_the_origin() -> None:
    model = make_model(state="ESTOP")
    model.estop_from_idle = True

    _run(("CLEAR_ESTOP_LATCH",), model, latch=MemoryLatchStore(latched=True))

    assert model.estop_from_idle is False


def test_a_failed_latch_clear_keeps_the_origin() -> None:
    model = make_model(state="ESTOP")
    model.estop_from_idle = True

    with pytest.raises(EffectError):
        _run(("CLEAR_ESTOP_LATCH",), model, latch=MemoryLatchStore(latched=True, fail_clear=True))

    assert model.estop_from_idle is True


def test_a_failed_latch_clear_raises_and_changes_nothing() -> None:
    model = make_model(state="ESTOP")
    model.speed = 2.0
    model.mission_stations = [STATION]
    before = copy.deepcopy(model)
    lock = RobotLock()
    lock.acquire(HOLDER, NOW_MS)
    lock_before = lock.holder
    latch = MemoryLatchStore(latched=True, fail_clear=True)
    latch_before = latch.record

    with pytest.raises(EffectError) as raised:
        _run(
            ("STOP_MOTION", "ABORT_MISSION", "CLEAR_ESTOP_LATCH", "RESUME_TARGET_IDLE"),
            model,
            lock=lock,
            latch=latch,
        )

    assert str(raised.value) == "the e-stop latch cannot be cleared"
    assert model == before
    assert lock.holder == lock_before
    assert latch.record == latch_before


def test_a_failed_latch_write_gives_set_failed_and_still_stops_the_robot() -> None:
    model = make_model(state="MOVING")
    model.speed = 1.0
    latch = MemoryLatchStore(fail_set=True)

    outcome = _run(("STOP_MOTION", "LATCH_ESTOP"), model, latch=latch, ctx=_ctx("ESTOP"))

    assert outcome.latch == "SET_FAILED"
    assert model.speed == 0.0
    assert latch.record is None


def test_the_latch_is_cleared_before_the_other_effects_so_a_failure_changes_nothing() -> None:
    model = make_model(state="ESTOP")
    model.speed = 2.0
    latch = MemoryLatchStore(latched=True, fail_clear=True)

    with pytest.raises(EffectError):
        _run(("STOP_MOTION", "CLEAR_ESTOP_LATCH"), model, latch=latch)

    assert model.speed == 2.0


def test_effects_apply_in_tuple_order_for_return_to_base() -> None:
    model = make_model(state="BLOCKED")
    model.mission_id = "mission-1"
    model.mission_stations = [STATION]
    model.destination = Destination("STATION", STATION)
    model.cause_pending = True
    model.fault = "OBSTACLE"
    result = transition("BLOCKED", "RETURN_TO_BASE", guards_for(model), None)

    outcome = _run(result.effects, model)

    assert result.effects == ("ABORT_MISSION", "SET_DEST_CHARGER", "CLEAR_CAUSE")
    assert model.destination == Destination("CHARGER", SITE.charger)
    assert outcome.fault_cleared == "OBSTACLE"


def test_a_lock_held_by_another_operator_refuses_the_grant_and_changes_nothing() -> None:
    lock = RobotLock()
    lock.acquire(OTHER_HOLDER, NOW_MS)
    model = make_model(state="IDLE")
    model.speed = 2.0

    with pytest.raises(EffectError):
        _run(
            ("STOP_MOTION", "ACQUIRE_LOCK"),
            model,
            lock=lock,
            ctx=_ctx("TAKE_CONTROL", holder=HOLDER),
        )

    assert model.speed == 2.0
    assert lock.holder == OTHER_HOLDER


def test_a_grant_without_a_holder_is_refused() -> None:
    with pytest.raises(EffectError):
        _run(("ACQUIRE_LOCK",), make_model(), ctx=_ctx("TAKE_CONTROL", holder=None))


def test_a_refused_grant_does_not_clear_the_latch() -> None:
    lock = RobotLock()
    lock.acquire(OTHER_HOLDER, NOW_MS)
    latch = MemoryLatchStore(latched=True)

    with pytest.raises(EffectError):
        _run(
            ("ACQUIRE_LOCK", "CLEAR_ESTOP_LATCH"),
            make_model(state="ESTOP"),
            lock=lock,
            latch=latch,
            ctx=_ctx("TAKE_CONTROL", holder=HOLDER),
        )

    assert latch.clear_calls == 0


def test_a_cause_from_a_trigger_that_raises_no_fault_is_refused() -> None:
    model = make_model(state="IDLE")

    with pytest.raises(EffectError):
        _run(("MARK_CAUSE",), model, ctx=_ctx("PAUSE"))

    assert model.cause_pending is False


def test_a_latch_without_the_command_that_set_it_is_refused() -> None:
    latch = MemoryLatchStore()

    with pytest.raises(EffectError):
        _run(("LATCH_ESTOP",), make_model(), latch=latch, ctx=_ctx("ESTOP", command_id=None))

    assert latch.set_calls == 0
