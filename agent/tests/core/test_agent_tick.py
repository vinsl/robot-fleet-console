"""Tick: the deadman, the lock expiry, the fault timers, the motion, the battery and the telemetry.

The tick order is the safety order, and these tests drive the clock in steps of 50 ms, as the runner
does. Heartbeats are sent by the test where the operator would send them.
"""

from __future__ import annotations

import logging
from typing import NoReturn

import pytest
from _pytest.logging import LogCaptureFixture

from fleet_agent.core.messages import MessageBuildError, MessageFactory
from fleet_agent.core.model import guards_for
from fleet_agent.core.ports import PublishOutcome

from .fakes import (
    LOCK_TOKEN,
    FakeClock,
    FakeTransport,
    body_of,
    deliver,
    field_of,
    labels,
    make_core,
    make_teleop,
    model_of,
)

TICK_MS = 50


def state_changes(transport: FakeTransport) -> list[tuple[str, str, str]]:
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


def heartbeat(transport: FakeTransport, clock: FakeClock) -> None:
    """Sends the operator's heartbeat, which proves presence and refreshes the lock.

    Args:
        transport: The fake that delivers the message.
        clock: The clock the heartbeat is issued at.
    """
    deliver(transport, clock, "HEARTBEAT", lockToken=LOCK_TOKEN)


def test_teleop_without_heartbeat_pauses_on_the_deadman_at_one_second() -> None:
    """Given a teleoperated robot, 999 ms without heartbeat keeps it; 1000 ms pauses it."""
    core, clock, transport, _ = make_teleop()

    clock.advance(999)
    core.tick()
    assert core.snapshot().state == "TELEOP"

    clock.advance(1)
    core.tick()

    assert core.snapshot().state == "PAUSED"
    assert core.snapshot().lock_held is True
    assert state_changes(transport)[-1] == ("TELEOP", "PAUSED", "DEADMAN_EXPIRED")


def test_the_deadman_fires_while_the_link_is_down(caplog: LogCaptureFixture) -> None:
    """Given a disconnected robot, the deadman still stops it, and the expiry is logged."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, _ = make_teleop()
    core.on_connected()
    core.on_disconnected("ConnectionError", None)

    clock.advance(1000)
    core.tick()

    assert core.snapshot().state == "PAUSED"
    assert state_changes(transport)[-1][2] == "DEADMAN_EXPIRED"
    expired = [r for r in caplog.records if r.getMessage() == "deadman.expired"]
    assert field_of(expired[-1], "sinceMs") == 1000


def test_a_heartbeat_every_900_ms_keeps_the_robot_teleoperated() -> None:
    """Given an operator who sends a heartbeat every 900 ms, the deadman never fires."""
    core, clock, transport, _ = make_teleop()

    for _ in range(20):
        clock.advance(900)
        heartbeat(transport, clock)
        core.tick()

    assert core.snapshot().state == "TELEOP"


def test_an_expired_heartbeat_does_not_feed_the_deadman() -> None:
    """Given a heartbeat issued 5 s ago, it is refused silently and the deadman is not fed by it."""
    core, clock, transport, _ = make_teleop()
    clock.advance(900)
    before = len(transport.published)
    deliver(transport, clock, "HEARTBEAT", lockToken=LOCK_TOKEN, wall_ms=clock.wall_ms() - 5000)
    assert len(transport.published) == before

    clock.advance(100)
    core.tick()

    assert core.snapshot().state == "PAUSED"


def test_lock_idle_expiry_in_teleop_pauses_and_releases_the_lock() -> None:
    """Given a teleoperated robot idle for 30 s, the lock expires, and the robot pauses."""
    core, clock, transport, _ = make_teleop()
    clock.advance(30000)

    core.tick()

    assert core.snapshot().state == "PAUSED"
    assert core.snapshot().lock_held is False
    tail = labels(transport)[-2:]
    assert tail == ["LOCK_CHANGED", "STATE_CHANGED"]
    assert state_changes(transport)[-1] == ("TELEOP", "PAUSED", "LOCK_EXPIRED")


def test_return_to_base_moves_arrives_charges_and_returns_to_idle() -> None:
    """Given the lock, RETURN_TO_BASE drives to the charger, charges, and ends IDLE."""
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)

    for step in range(4000):
        clock.advance(TICK_MS)
        if step % 10 == 0:
            heartbeat(transport, clock)
        core.tick()
        if core.snapshot().state == "IDLE" and step > 0:
            break

    assert core.snapshot().state == "IDLE"
    assert state_changes(transport) == [
        ("IDLE", "TELEOP", "TAKE_CONTROL"),
        ("TELEOP", "MOVING", "RETURN_TO_BASE"),
        ("MOVING", "CHARGING", "ARRIVED"),
        ("CHARGING", "IDLE", "CHARGED"),
    ]


def test_low_battery_is_raised_once_and_sends_an_idle_robot_to_its_charger() -> None:
    """Given a battery at 20 %, the first tick raises BATTERY_LOW once and the robot charges."""
    core, clock, transport, _ = make_core(battery_start=20.0)
    clock.advance(TICK_MS)

    core.tick()
    for _ in range(100):
        clock.advance(TICK_MS)
        core.tick()

    assert labels(transport)[1:3] == ["FAULT_RAISED", "STATE_CHANGED"]
    assert body_of(transport, 1)["fault"] == "BATTERY_LOW"
    assert state_changes(transport) == [("IDLE", "MOVING", "BATTERY_LOW")]
    assert labels(transport).count("FAULT_RAISED") == 1


def test_low_battery_is_cleared_once_the_robot_is_full_again() -> None:
    """Given a battery that ran low, a full charge publishes FAULT_CLEARED for BATTERY_LOW."""
    core, clock, transport, _ = make_core(battery_start=20.0)

    for _ in range(6000):
        clock.advance(TICK_MS)
        core.tick()
        if state_changes(transport)[-1:] == [("CHARGING", "IDLE", "CHARGED")]:
            break

    assert labels(transport).count("FAULT_RAISED") == 1
    raised = labels(transport).index("FAULT_RAISED")
    cleared = labels(transport).index("FAULT_CLEARED")
    assert raised < cleared
    assert body_of(transport, cleared)["fault"] == "BATTERY_LOW"


def test_drop_link_suspends_once_the_ack_is_acknowledged() -> None:
    """Given a simulated link loss, the link is dropped when the ACK's PUBACK arrives, once."""
    core, clock, transport, _ = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "LINK_LOSS", "durationS": 5})
    ack_index = labels(transport).index("ACK")
    assert transport.suspended == []

    transport.complete_publish(ack_index, PublishOutcome(status="OK"))
    core.tick()

    assert transport.suspended == [5000]


def test_drop_link_suspends_after_the_grace_period_without_an_ack() -> None:
    """Given no PUBACK for the ACK, the link is dropped 1000 ms after the command."""
    core, clock, transport, _ = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "LINK_LOSS", "durationS": 5})

    clock.advance(999)
    core.tick()
    assert transport.suspended == []

    clock.advance(1)
    core.tick()
    assert transport.suspended == [5000]


def test_telemetry_is_published_every_500_ms_while_connected() -> None:
    """Given a connected real robot, the first telemetry is immediate and then one every 500 ms."""
    core, clock, transport, _ = make_core()
    core.on_connected()
    core.tick()

    for _ in range(20):
        clock.advance(TICK_MS)
        core.tick()

    assert labels(transport).count("TELEMETRY") == 3


def test_a_stationary_simulator_sends_a_heartbeat_after_five_seconds() -> None:
    """Given a connected simulator at rest, it reports once, then is silent until a heartbeat."""
    core, clock, transport, _ = make_core(simulated=True)
    core.on_connected()
    core.tick()

    for _ in range(100):
        clock.advance(TICK_MS)
        core.tick()

    assert labels(transport)[1:] == ["TELEMETRY", "HEARTBEAT"]


def test_a_summary_is_logged_every_ten_seconds_while_connected(caplog: LogCaptureFixture) -> None:
    """Given a connected robot, a telemetry.summary line appears once per 10 s."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, _, _ = make_core()
    core.on_connected()
    core.tick()

    # Telemetry at 0, 500, ... 10000 ms: 21 publishes, all counted before the 10 s line is written.
    for _ in range(200):
        clock.advance(TICK_MS)
        core.tick()

    summaries = [r for r in caplog.records if r.getMessage() == "telemetry.summary"]
    assert len(summaries) == 1
    assert field_of(summaries[0], "count") == 21


def test_a_message_that_fails_its_schema_is_logged_and_not_sent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: LogCaptureFixture,
) -> None:
    """Given a builder that refuses its message, nothing is published and the failure is logged."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _clock, transport, _ = make_core()
    core.on_connected()

    def refuse(self: MessageFactory, fields: object) -> NoReturn:
        """Stands in for the telemetry builder and refuses every message.

        Args:
            self: The factory.
            fields: The telemetry fields, which the test does not read.

        Raises:
            MessageBuildError: Always.
        """
        raise MessageBuildError(("x",))

    monkeypatch.setattr(MessageFactory, "telemetry", refuse)
    before = len(transport.published)

    core.tick()

    assert len(transport.published) == before
    failed = [r for r in caplog.records if r.getMessage() == "message.build_failed"]
    assert field_of(failed[-1], "errorPaths") == ("x",)


def test_a_cause_cleared_in_blocked_then_resumed_returns_to_the_resume_target() -> None:
    """Given a timed sensor fault, it clears on the tick, and RESUME returns to the target."""
    core, clock, transport, _ = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "SENSOR_FAULT", "durationS": 1})
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)

    clock.advance(1000)
    core.tick()
    assert labels(transport)[-1] == "FAULT_CLEARED"
    assert core.snapshot().state == "BLOCKED"

    deliver(transport, clock, "RESUME", lockToken=LOCK_TOKEN)

    assert core.snapshot().state == "IDLE"
    assert state_changes(transport)[-1] == ("BLOCKED", "IDLE", "RESUME")


def test_resume_while_the_cause_is_pending_is_refused() -> None:
    """Given a blocked robot whose fault has not cleared, RESUME is refused INVALID_STATE."""
    core, clock, transport, _ = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "SENSOR_FAULT", "durationS": 30})
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)
    before = len(transport.published)

    deliver(transport, clock, "RESUME", lockToken=LOCK_TOKEN)

    ack = body_of(transport, before)
    assert ack["reason"] == "INVALID_STATE"
    assert core.snapshot().state == "BLOCKED"


def test_a_stale_fault_outside_blocked_is_cleared_without_a_state_change() -> None:
    """Given a fault outliving its BLOCKED state, the tick clears it and keeps the state."""
    core, clock, transport, _ = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "SENSOR_FAULT", "durationS": 1})
    deliver(transport, clock, "ESTOP")
    assert core.snapshot().state == "ESTOP"

    clock.advance(1000)
    core.tick()

    assert labels(transport)[-1] == "FAULT_CLEARED"
    assert body_of(transport, len(transport.published) - 1)["fault"] == "SENSOR_FAULT"
    assert core.snapshot().state == "ESTOP"
    assert state_changes(transport)[-1] == ("BLOCKED", "ESTOP", "ESTOP")


def test_a_late_puback_after_the_grace_suspend_does_not_suspend_twice() -> None:
    """Given the grace period dropped the link, a late PUBACK for the ACK drops nothing more."""
    core, clock, transport, _ = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "LINK_LOSS", "durationS": 5})
    clock.advance(1000)
    core.tick()
    assert transport.suspended == [5000]

    transport.complete_publish(labels(transport).index("ACK"), PublishOutcome(status="OK"))

    assert transport.suspended == [5000]


def test_a_stopping_robot_keeps_its_speed_at_zero_and_does_not_move() -> None:
    """Given a moving robot that began a shutdown, every later tick reports speed 0."""
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)
    for _ in range(5):
        clock.advance(TICK_MS)
        heartbeat(transport, clock)
        core.tick()
    assert model_of(core).speed > 0
    core.begin_shutdown()
    core.on_connected()
    before = len(transport.published)

    for _ in range(10):
        clock.advance(TICK_MS)
        core.tick()

    telemetry = [
        body_of(transport, index)
        for index, label in enumerate(labels(transport))
        if label == "TELEMETRY" and index >= before
    ]
    assert telemetry
    assert {body["speed"] for body in telemetry} == {0}
    assert len({body["x"] for body in telemetry}) == 1
    assert model_of(core).speed == 0.0


def test_a_heartbeat_aged_1900_ms_does_not_keep_the_robot_alive_for_a_second() -> None:
    """Given a heartbeat issued 1900 ms before it arrived, the deadman runs from its issue time."""
    core, clock, transport, _ = make_teleop()
    clock.advance(950)
    deliver(transport, clock, "HEARTBEAT", lockToken=LOCK_TOKEN, wall_ms=clock.wall_ms() - 1900)
    clock.advance(50)

    core.tick()

    assert core.snapshot().state == "PAUSED"


def test_a_take_control_aged_1900_ms_feeds_the_deadman_at_its_issue_time() -> None:
    """Given a take-control issued 1900 ms before it arrived, the deadman runs from its issue."""
    core, clock, transport, _ = make_core()
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN, wall_ms=clock.wall_ms() - 1900)

    core.tick()

    assert core.snapshot().state == "PAUSED"


def test_an_arrival_clears_the_destination_so_no_stale_guard_survives_the_charge() -> None:
    """Given a robot that drove to its charger and charged, no destination guard remains in IDLE."""
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "RETURN_TO_BASE", lockToken=LOCK_TOKEN)

    for step in range(4000):
        clock.advance(TICK_MS)
        if step % 10 == 0:
            heartbeat(transport, clock)
        core.tick()
        if core.snapshot().state == "IDLE" and step > 0:
            break

    assert core.snapshot().state == "IDLE"
    assert model_of(core).destination is None
    assert not any(guard.startswith("DEST_") for guard in guards_for(model_of(core)))
