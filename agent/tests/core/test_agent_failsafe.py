"""Failsafe: a core that meets a state it cannot resolve halts, and a command error is answered.

A transition error on a command is a refusal the operator can see. The same error on an internal
trigger means the table and the model disagree, so the robot stops and refuses further work.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable

import pytest
from _pytest.logging import LogCaptureFixture

from fleet_agent.core import agent as agent_module
from fleet_agent.core.agent import AgentCore
from fleet_agent.core.effects import EffectError
from fleet_agent.core.state_machine import Guard, TransitionResult
from fleet_agent.protocol.primitives import ReportedState
from fleet_agent.protocol.triggers import Trigger

from .fakes import (
    LOCK_TOKEN,
    FakeClock,
    FakeTransport,
    MemoryLatchStore,
    body_of,
    build_core,
    deliver,
    encode,
    field_of,
    labels,
    make_command,
    make_core,
    make_teleop,
    model_of,
)

TICK_MS = 50


def test_an_internal_trigger_with_two_matching_rows_halts_with_speed_zero(
    monkeypatch: pytest.MonkeyPatch,
    caplog: LogCaptureFixture,
) -> None:
    """Given two rows match an internal trigger, the core halts, stops and logs CRITICAL."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)
    clock.advance(50)
    core.tick()
    assert model_of(core).speed > 0
    monkeypatch.setattr(
        agent_module,
        "guards_for",
        lambda model: frozenset({"DEST_CHARGER", "DEST_STATION"}),
    )

    core.fire_internal("ARRIVED")

    assert core.halted is True
    halted = [r for r in caplog.records if r.getMessage() == "agent.halted"]
    assert halted[-1].levelname == "CRITICAL"
    assert field_of(halted[-1], "reason") == "TypeError"
    model = model_of(core)
    assert model.speed == 0.0
    assert model.destination is None


def test_a_halted_core_publishes_nothing_and_drops_every_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a halted core, neither the tick nor any command produces a publish."""
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)
    monkeypatch.setattr(
        agent_module,
        "guards_for",
        lambda model: frozenset({"DEST_CHARGER", "DEST_STATION"}),
    )
    core.fire_internal("ARRIVED")
    before = len(transport.published)

    clock.advance(5000)
    core.tick()
    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)

    assert len(transport.published) == before


def _fail_on(monkeypatch: pytest.MonkeyPatch, failing_trigger: str) -> None:
    """Makes the transition table fail for one trigger, as a broken row would.

    Args:
        monkeypatch: The fixture that installs the stand-in.
        failing_trigger: The trigger whose transition raises.
    """
    real = agent_module.transition

    def table(
        origin: ReportedState,
        trigger: Trigger,
        guards: Iterable[Guard] = (),
        resume_target: ReportedState | None = None,
    ) -> TransitionResult:
        """Raises for the failing trigger and delegates every other trigger to the real table.

        Args:
            origin: The state the robot is in.
            trigger: The trigger being applied.
            guards: The guards that hold.
            resume_target: The stored resume target.

        Returns:
            The real outcome for any other trigger.

        Raises:
            TypeError: For the failing trigger, to stand in for a broken row.
        """
        if trigger == failing_trigger:
            raise TypeError("a broken row")
        return real(origin, trigger, guards, resume_target)

    monkeypatch.setattr(agent_module, "transition", table)


def _set_up_lock_expiry() -> tuple[AgentCore, FakeClock, FakeTransport]:
    """Leaves a teleoperated robot whose lock has just become idle for 30 s.

    Returns:
        The core, its clock and its transport.
    """
    core, clock, transport, _ = make_teleop()
    clock.advance(30000)
    return core, clock, transport


def _set_up_deadman() -> tuple[AgentCore, FakeClock, FakeTransport]:
    """Leaves a teleoperated robot whose operator has been silent for the deadman timeout.

    Returns:
        The core, its clock and its transport.
    """
    core, clock, transport, _ = make_teleop()
    clock.advance(1000)
    return core, clock, transport


def _set_up_fault_timer() -> tuple[AgentCore, FakeClock, FakeTransport]:
    """Leaves a blocked simulator whose one-second sensor fault has just elapsed.

    Returns:
        The core, its clock and its transport.
    """
    core, clock, transport, _ = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "SENSOR_FAULT", "durationS": 1})
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)
    clock.advance(1000)
    return core, clock, transport


def _set_up_battery() -> tuple[AgentCore, FakeClock, FakeTransport]:
    """Leaves an idle robot whose charge is at the low-battery threshold.

    Returns:
        The core, its clock and its transport.
    """
    core, clock, transport, _ = make_core(battery_start=20.0)
    clock.advance(50)
    return core, clock, transport


def _set_up_arrival() -> tuple[AgentCore, FakeClock, FakeTransport]:
    """Leaves a teleoperated robot on its way to the charger, with the lock held and no tick yet.

    Returns:
        The core, its clock and its transport.
    """
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)
    return core, clock, transport


@pytest.mark.parametrize(
    ("setup", "trigger", "keeps_alive"),
    [
        pytest.param(_set_up_lock_expiry, "LOCK_EXPIRED", False, id="lock-expiry"),
        pytest.param(_set_up_deadman, "DEADMAN_EXPIRED", False, id="deadman"),
        pytest.param(_set_up_fault_timer, "CAUSE_CLEARED", False, id="fault-timer"),
        pytest.param(_set_up_battery, "BATTERY_LOW", False, id="battery"),
        pytest.param(_set_up_arrival, "ARRIVED", True, id="arrival"),
    ],
)
def test_a_halt_in_any_step_of_the_tick_stops_the_rest_of_the_tick(
    monkeypatch: pytest.MonkeyPatch,
    setup: Callable[[], tuple[AgentCore, FakeClock, FakeTransport]],
    trigger: str,
    keeps_alive: bool,
) -> None:
    """Given a broken row for a step's trigger, the tick halts in that step and runs no later one.

    The arrival case keeps the operator's heartbeat going, so that the deadman does not stop the
    robot before it reaches the charger. The loop ends as soon as the core halts.
    """
    core, clock, transport = setup()
    _fail_on(monkeypatch, trigger)

    for step in range(400):
        clock.advance(TICK_MS)
        if keeps_alive and step % 10 == 0:
            deliver(transport, clock, "HEARTBEAT", lockToken=LOCK_TOKEN)
        core.tick()
        if core.halted:
            break

    assert core.halted is True
    after_halt = len(transport.published)
    clock.advance(TICK_MS)
    core.tick()
    assert len(transport.published) == after_halt
    assert model_of(core).speed == 0.0


def test_fire_internal_after_a_halt_changes_nothing() -> None:
    """Given a halted core, an internal trigger is ignored: no state change and no publish."""
    core, _, transport, _ = make_teleop()
    core.halt("RuntimeError")
    before = len(transport.published)

    core.fire_internal("ARRIVED")

    assert len(transport.published) == before


def test_a_halt_while_expiring_the_lock_stops_the_command_before_its_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given the lock lapses and the table fails, the command that found it gets no answer."""
    core, clock, transport, _ = make_teleop()
    clock.advance(30000)
    _fail_on(monkeypatch, "LOCK_EXPIRED")
    before = len(transport.published)

    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)

    assert core.halted is True
    assert "ACK" not in labels(transport)[before:]


def test_an_effect_refused_for_another_reason_is_answered_without_a_latch_line(
    monkeypatch: pytest.MonkeyPatch,
    caplog: LogCaptureFixture,
) -> None:
    """Given the effects refuse a transition, the operator gets INVALID_STATE, and no latch line."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, clock, transport, _ = make_teleop()

    def refuse(*args: object, **kwargs: object) -> None:
        """Stands in for the effect application and refuses every transition.

        Args:
            *args: The effect arguments, which the test does not read.
            **kwargs: The effect keyword arguments, which the test does not read.

        Raises:
            EffectError: Always.
        """
        _ = (args, kwargs)
        raise EffectError("refused for the test")

    monkeypatch.setattr(agent_module, "apply_effects", refuse)
    before = len(transport.published)

    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)

    ack = body_of(transport, before)
    assert ack["reason"] == "INVALID_STATE"
    assert not any(r.getMessage() == "latch.clear_failed" for r in caplog.records)


def test_halt_is_idempotent_and_logs_once(caplog: LogCaptureFixture) -> None:
    """Given a core halted twice, the second call changes nothing and writes no second line."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _, _, _ = make_teleop()

    core.halt("RuntimeError")
    core.halt("RuntimeError")

    halted = [r for r in caplog.records if r.getMessage() == "agent.halted"]
    assert len(halted) == 1


def test_fire_internal_refuses_boot() -> None:
    """Given a request to fire BOOT as an internal trigger, the core refuses it."""
    core, _, _, _ = make_teleop()

    with pytest.raises(ValueError, match="boot"):
        core.fire_internal("BOOT")


def test_a_command_transition_error_gives_invalid_state_and_the_robot_keeps_running(
    monkeypatch: pytest.MonkeyPatch,
    caplog: LogCaptureFixture,
) -> None:
    """Given the table fails for PAUSE, the operator gets INVALID_STATE and the core runs on."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, _ = make_teleop()
    real = agent_module.transition

    def failing(
        origin: ReportedState,
        trigger: Trigger,
        guards: Iterable[Guard] = (),
        resume_target: ReportedState | None = None,
    ) -> TransitionResult:
        """Raises for PAUSE and delegates every other trigger to the real table.

        Args:
            origin: The state the robot is in.
            trigger: The trigger the test raises.
            guards: The guards that hold.
            resume_target: The stored resume target.

        Returns:
            The real outcome for any trigger but PAUSE.

        Raises:
            TypeError: For PAUSE, to stand in for a broken row.
        """
        if trigger == "PAUSE":
            raise TypeError("a broken row")
        return real(origin, trigger, guards, resume_target)

    monkeypatch.setattr(agent_module, "transition", failing)
    before = len(transport.published)

    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)

    ack = body_of(transport, before)
    assert ack["reason"] == "INVALID_STATE"
    assert core.snapshot().state == "TELEOP"
    assert core.halted is False
    rejected = [r for r in caplog.records if r.getMessage() == "command.rejected"]
    assert rejected[-1].levelname == "ERROR"
    assert labels(transport)[before:] == ["ACK"]


def test_a_reject_row_without_a_reason_is_a_table_fault_and_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a REJECT row that carries no reason, the core raises rather than answer without one."""
    _, clock, transport, _ = make_teleop()

    def no_reason(
        origin: ReportedState,
        trigger: Trigger,
        guards: Iterable[Guard] = (),
        resume_target: ReportedState | None = None,
    ) -> TransitionResult:
        """Returns a REJECT with no reason, which the table never produces.

        Args:
            origin: The state the robot is in.
            trigger: The trigger the test raises.
            guards: The guards that hold.
            resume_target: The stored resume target.

        Returns:
            A REJECT outcome without a reason.
        """
        _ = (origin, trigger, guards, resume_target)
        return TransitionResult(to="TELEOP", reply="REJECT", reason=None, effects=(), changed=False)

    monkeypatch.setattr(agent_module, "transition", no_reason)

    with pytest.raises(TypeError, match="reason"):
        deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)


def test_the_snapshot_banner_follows_the_state() -> None:
    """Given the robot in TELEOP, the banner is TELEOP and the state is reported as such."""
    core, _, _, _ = make_teleop()

    snapshot = core.snapshot()

    assert snapshot.banner == "TELEOP"
    assert snapshot.state == "TELEOP"


@pytest.mark.parametrize("failure", ["table", "effects"])
def test_an_estop_that_cannot_be_applied_stops_latches_and_is_never_refused(
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """Given a moving robot whose e-stop fails in the table or the effects, it stops and latches.

    The e-stop is never answered with a refusal: a refusal would leave a moving robot moving. No
    line at all is published, because the core halts and the runner shuts the link down.
    """
    core, clock, transport, latch = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)
    clock.advance(50)
    core.tick()
    assert model_of(core).speed > 0
    if failure == "table":
        _fail_on(monkeypatch, "ESTOP")
    else:
        monkeypatch.setattr(agent_module, "apply_effects", _refuse_every_effect)
    before = len(transport.published)

    estop = deliver(transport, clock, "ESTOP")

    assert core.halted is True
    assert labels(transport)[before:] == []
    assert model_of(core).speed == 0.0
    assert model_of(core).destination is None
    assert core.snapshot().banner == "ESTOP"
    assert core.snapshot().state == "ESTOP"
    assert latch.record is not None
    assert latch.record.command_id == estop["commandId"]


def test_an_estop_fault_with_a_failing_latch_still_stops_and_reports_the_persistence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given an e-stop that cannot be applied and a latch that cannot be written, the robot stops.

    The stop is applied in memory and the core halts; the lost persistence is reported, not raised.
    """
    store = MemoryLatchStore(fail_set=True)
    core, clock, transport, _ = build_core(latch=store)
    core.boot()
    _fail_on(monkeypatch, "ESTOP")

    deliver(transport, clock, "ESTOP")

    assert core.halted is True
    assert core.snapshot().latch_persisted is False
    assert core.snapshot().banner == "ESTOP"
    assert store.set_calls == 1


def _refuse_every_effect(*args: object, **kwargs: object) -> None:
    """Stands in for the effect application and refuses every transition.

    Args:
        *args: The effect arguments, which the test does not read.
        **kwargs: The effect keyword arguments, which the test does not read.

    Raises:
        EffectError: Always.
    """
    _ = (args, kwargs)
    raise EffectError("refused for the test")


def test_an_effect_that_cannot_be_applied_on_an_internal_trigger_halts_the_core(
    monkeypatch: pytest.MonkeyPatch,
    caplog: LogCaptureFixture,
) -> None:
    """Given an internal trigger whose effects are refused, the core halts and changes no state.

    The effects are what the internal trigger needs to be carried out, so an EffectError is a fault
    of the core. It must not escape to the runner, and it must not be guessed past.
    """
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _, transport, _ = make_teleop()
    monkeypatch.setattr(agent_module, "apply_effects", _refuse_every_effect)
    before = len(transport.published)

    core.fire_internal("LOCK_EXPIRED")

    assert core.halted is True
    assert core.snapshot().state == "TELEOP"
    assert model_of(core).speed == 0.0
    assert len(transport.published) == before
    halted = [r for r in caplog.records if r.getMessage() == "agent.halted"]
    assert field_of(halted[-1], "reason") == "EffectError"


def test_an_estop_after_a_halt_stops_latches_and_is_acknowledged() -> None:
    """Given a halted core that was moving, an e-stop still stops it, latches it and is acked.

    The core stays halted: the e-stop is the one command a halted core acts on, not a recovery.
    """
    core, clock, transport, latch = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)
    clock.advance(50)
    core.tick()
    assert model_of(core).speed > 0
    core.halt("RuntimeError")
    before = len(transport.published)

    estop = deliver(transport, clock, "ESTOP")

    assert core.halted is True
    assert labels(transport)[before:] == ["ACK"]
    ack = body_of(transport, before)
    assert ack["result"] == "ACK"
    assert ack["state"] == "ESTOP"
    assert ack["commandId"] == estop["commandId"]
    assert core.snapshot().state == "ESTOP"
    model = model_of(core)
    assert model.speed == 0.0
    assert model.destination is None
    assert latch.record is not None
    assert latch.record.command_id == estop["commandId"]


def test_an_estop_after_a_halt_with_a_failing_latch_is_still_acted_on_and_reported() -> None:
    """Given a halted core and a latch that cannot be written, the e-stop still stops the robot.

    The lost persistence is reported through the snapshot, and the write is attempted once.
    """
    store = MemoryLatchStore(fail_set=True)
    core, clock, transport, _ = build_core(latch=store)
    core.boot()
    core.halt("RuntimeError")
    before = len(transport.published)

    deliver(transport, clock, "ESTOP")

    assert core.halted is True
    assert core.snapshot().state == "ESTOP"
    assert core.snapshot().latch_persisted is False
    assert store.set_calls == 1
    assert labels(transport)[before:] == ["ACK"]


def _closed_link_publish(*args: object, **kwargs: object) -> None:
    """Stands in for a publish on a link the broker has closed, which raises.

    Args:
        *args: The publish arguments, which the test does not read.
        **kwargs: The publish keyword arguments, which the test does not read.

    Raises:
        OSError: Always.
    """
    _ = (args, kwargs)
    raise OSError("the link is closed")


def test_an_estop_after_a_halt_still_stops_when_its_acknowledgement_cannot_be_sent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: LogCaptureFixture,
) -> None:
    """Given a halted core whose link raises on publish, the e-stop still stops and latches.

    The acknowledgement is best effort: its failure is logged by its error class, and it does not
    escape to the runner nor undo the stop.
    """
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, latch = make_teleop()
    core.halt("RuntimeError")
    monkeypatch.setattr(transport, "publish", _closed_link_publish)

    estop = deliver(transport, clock, "ESTOP")

    assert core.snapshot().state == "ESTOP"
    assert latch.record is not None
    assert latch.record.command_id == estop["commandId"]
    failed = [r for r in caplog.records if r.getMessage() == "publish.failed"]
    assert field_of(failed[-1], "label") == "ACK"
    assert field_of(failed[-1], "errorName") == "OSError"


@pytest.mark.parametrize("command_type", ["PAUSE", "RESUME", "RETURN_TO_BASE", "TAKE_CONTROL"])
def test_every_command_but_an_estop_is_still_dropped_after_a_halt(command_type: str) -> None:
    """Given a halted core, a command other than an e-stop makes no publish and no latch write."""
    store = MemoryLatchStore()
    core, clock, transport, _ = build_core(latch=store)
    core.boot()
    core.halt("RuntimeError")
    before = len(transport.published)

    deliver(transport, clock, command_type, lockToken=LOCK_TOKEN)

    assert len(transport.published) == before
    assert store.set_calls == 0
    assert core.snapshot().state == "IDLE"


def test_an_estop_refused_by_screening_after_a_halt_is_not_acted_on() -> None:
    """Given a halted core, an e-stop that fails screening is dropped like any other command."""
    store = MemoryLatchStore()
    core, clock, transport, _ = build_core(latch=store)
    core.boot()
    core.halt("RuntimeError")
    before = len(transport.published)

    transport.deliver(
        "unrelated/other/topic", encode(make_command("ESTOP", wall_ms=clock.wall_ms()))
    )

    assert len(transport.published) == before
    assert store.set_calls == 0
    assert core.snapshot().state == "IDLE"
