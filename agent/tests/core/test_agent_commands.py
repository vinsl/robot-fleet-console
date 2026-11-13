"""Command pipeline: the answers, their order on the wire, the lock and the e-stop latch.

The order of publishes is asserted by index, because the console relies on it: the acknowledgement
first, then the state change, then the lock, the faults and the latch.

The denied-access tests are named so that the security checklist can cite them. A denied command
gets a REJECT with its reason, and never a state change.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import NoReturn

import pytest
from _pytest.logging import LogCaptureFixture

from fleet_agent.core.agent import AgentCore
from fleet_agent.core.messages import MessageBuildError, MessageFactory
from fleet_agent.protocol.topics import events_topic

from .fakes import (
    COMMAND_TOPIC,
    LOCK_TOKEN,
    OPERATOR_SUB,
    ROBOT_ID,
    SITE_ID,
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
)

OTHER_TOKEN = "other-token-0123456789abcdef"  # noqa: S105 - a fixed fake token, not a credential
OTHER_SUB = "operator-sub-2"

Scenario = tuple[AgentCore, FakeClock, FakeTransport, MemoryLatchStore]


def idle() -> Scenario:
    """Builds a booted core in IDLE, with no lock.

    Returns:
        The core, its clock, its transport and its latch store.
    """
    return make_core()


def blocked() -> Scenario:
    """Builds a booted simulator in BLOCKED by an injected sensor fault.

    Returns:
        The core, its clock, its transport and its latch store.
    """
    core, clock, transport, latch = make_core(simulated=True)
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "SENSOR_FAULT"})
    return core, clock, transport, latch


def test_pause_is_acknowledged_then_announced_then_telemetry_follows() -> None:
    """Given a teleoperated robot, PAUSE gives ACK PAUSED, then STATE_CHANGED, then telemetry."""
    core, clock, transport, _ = make_teleop()
    core.on_connected()
    before = len(transport.published)

    command = deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)

    assert labels(transport)[before:] == ["ACK", "STATE_CHANGED"]
    ack = body_of(transport, before)
    assert ack["result"] == "ACK"
    assert ack["state"] == "PAUSED"
    assert ack["commandId"] == command["commandId"]
    change = body_of(transport, before + 1)
    assert change["from"] == "TELEOP"
    assert change["to"] == "PAUSED"
    assert change["cause"] == "PAUSE"
    assert change["commandId"] == command["commandId"]
    core.tick()
    assert labels(transport)[-1] == "TELEMETRY"


def test_correlation_identifier_is_echoed_in_the_ack_and_logged(caplog: LogCaptureFixture) -> None:
    """Given a command, its correlation identifier is in the ack and in the acknowledgement log."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, clock, transport, _ = make_teleop()

    command = deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)

    ack_index = len(transport.published) - 2
    assert body_of(transport, ack_index)["correlationId"] == command["correlationId"]
    acked = [r for r in caplog.records if r.getMessage() == "command.acked"]
    assert field_of(acked[-1], "correlationId") == command["correlationId"]


def test_take_control_by_the_holder_refreshes_silently() -> None:
    """Given the holder, TAKE_CONTROL again is acknowledged and changes no lock event."""
    _, clock, transport, _ = make_teleop()
    before = len(transport.published)

    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)

    assert labels(transport)[before:] == ["ACK"]
    assert body_of(transport, before)["state"] == "TELEOP"


def test_resume_without_the_lock_is_refused_not_lock_holder() -> None:
    """Given a paused robot, RESUME without the lock is refused and the state stays PAUSED."""
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)
    before = len(transport.published)

    deliver(transport, clock, "RESUME")

    assert labels(transport)[before:] == ["ACK"]
    ack = body_of(transport, before)
    assert ack["result"] == "REJECT"
    assert ack["reason"] == "NOT_LOCK_HOLDER"
    assert ack["state"] == "PAUSED"
    assert core.snapshot().state == "PAUSED"


def test_refuses_takeover_of_active_lock() -> None:
    """Given an active holder, another operator's TAKE_CONTROL is refused and the lock is kept."""
    core, clock, transport, _ = make_teleop()
    before = len(transport.published)

    deliver(transport, clock, "TAKE_CONTROL", lockToken=OTHER_TOKEN, issuedBy=OTHER_SUB)

    assert labels(transport)[before:] == ["ACK"]
    ack = body_of(transport, before)
    assert ack["result"] == "REJECT"
    assert ack["reason"] == "NOT_LOCK_HOLDER"
    assert core.snapshot().lock_held is True
    assert core.snapshot().state == "TELEOP"


@pytest.mark.parametrize(
    ("token", "sub"),
    [
        pytest.param(OTHER_TOKEN, OPERATOR_SUB, id="wrong-token"),
        pytest.param(LOCK_TOKEN, OTHER_SUB, id="wrong-subject"),
        pytest.param(None, OPERATOR_SUB, id="no-token"),
    ],
)
def test_refuses_non_holder_lock_required_command(token: str | None, sub: str) -> None:
    """Given the lock, a lock-required command needs both the token and the subject to match."""
    core, clock, transport, _ = make_teleop()
    before = len(transport.published)
    overrides: dict[str, object] = {"issuedBy": sub}
    if token is not None:
        overrides["lockToken"] = token

    deliver(transport, clock, "PAUSE", **overrides)

    assert labels(transport)[before:] == ["ACK"]
    ack = body_of(transport, before)
    assert ack["result"] == "REJECT"
    assert ack["reason"] == "NOT_LOCK_HOLDER"
    assert core.snapshot().state == "TELEOP"


def test_after_idle_expiry_another_operator_takes_over_in_order() -> None:
    """Given an idle holder, after 30 s another operator takes over: expiry first, then TAKEOVER."""
    core, clock, transport, _ = make_teleop()
    clock.advance(30000)
    before = len(transport.published)

    deliver(transport, clock, "TAKE_CONTROL", lockToken=OTHER_TOKEN, issuedBy=OTHER_SUB)

    assert labels(transport)[before:] == [
        "LOCK_CHANGED",
        "STATE_CHANGED",
        "ACK",
        "STATE_CHANGED",
        "LOCK_CHANGED",
    ]
    expired = body_of(transport, before)
    assert expired["held"] is False
    assert expired["cause"] == "EXPIRED"
    lapsed = body_of(transport, before + 1)
    assert lapsed["from"] == "TELEOP"
    assert lapsed["to"] == "PAUSED"
    assert lapsed["cause"] == "LOCK_EXPIRED"
    assert body_of(transport, before + 2)["state"] == "TELEOP"
    taken = body_of(transport, before + 4)
    assert taken["held"] is True
    assert taken["cause"] == "TAKEOVER"
    assert taken["holder"] == OTHER_SUB
    assert core.snapshot().state == "TELEOP"


def test_expired_command_is_answered_expired_and_its_age_is_logged(
    caplog: LogCaptureFixture,
) -> None:
    """Given a command issued more than 2 s ago, it is answered EXPIRED with its age in the log."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, clock, transport, _ = make_core()
    before = len(transport.published)

    deliver(transport, clock, "RETURN_TO_BASE", wall_ms=clock.wall_ms() - 2001)

    ack = body_of(transport, before)
    assert ack["result"] == "REJECT"
    assert ack["reason"] == "EXPIRED"
    rejected = [r for r in caplog.records if r.getMessage() == "command.rejected"]
    assert field_of(rejected[-1], "ageMs") == 2001


def test_replayed_command_is_answered_duplicate() -> None:
    """Given a command delivered twice, the second copy is answered DUPLICATE and nothing else."""
    _, clock, transport, _ = make_teleop()
    command = make_command("PAUSE", wall_ms=clock.wall_ms(), lockToken=LOCK_TOKEN)
    transport.deliver(COMMAND_TOPIC, encode(command))
    first = len(transport.published)

    transport.deliver(COMMAND_TOPIC, encode(command))

    assert labels(transport)[first:] == ["ACK"]
    ack = body_of(transport, first)
    assert ack["reason"] == "DUPLICATE"
    assert ack["commandId"] == command["commandId"]


def test_core_drops_oversize_and_unparseable_without_ack() -> None:
    """Given a payload too large or not JSON, the core drops it and publishes nothing."""
    core, _, transport, _ = make_core()
    before = len(transport.published)

    transport.deliver(COMMAND_TOPIC, b"x" * 4097)
    transport.deliver(COMMAND_TOPIC, b"{not json")

    assert len(transport.published) == before
    assert core.snapshot().state == "IDLE"


def test_schema_invalid_command_is_rejected_with_the_failing_path(
    caplog: LogCaptureFixture,
) -> None:
    """Given a command with an unknown parameter, it is rejected INVALID and the path is logged."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, clock, transport, _ = make_teleop()
    before = len(transport.published)

    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN, params={"extra": 1})

    ack = body_of(transport, before)
    assert ack["reason"] == "INVALID"
    rejected = [r for r in caplog.records if r.getMessage() == "command.rejected"]
    assert "PAUSE.params.extra" in field_of(rejected[-1], "errorPaths")


def test_resume_from_teleop_is_refused_as_invalid_state() -> None:
    """Given a teleoperated robot with the lock, RESUME has no row and is refused INVALID_STATE."""
    core, clock, transport, _ = make_teleop()
    before = len(transport.published)

    deliver(transport, clock, "RESUME", lockToken=LOCK_TOKEN)

    ack = body_of(transport, before)
    assert ack["reason"] == "INVALID_STATE"
    assert core.snapshot().state == "TELEOP"


@pytest.mark.parametrize("start", [idle, make_teleop, blocked], ids=["idle", "teleop", "blocked"])
def test_estop_is_acknowledged_from_every_state_without_the_lock(
    start: Callable[[], Scenario],
) -> None:
    """Given a robot in IDLE, TELEOP or BLOCKED, ESTOP needs no lock: it is ACKed and latched."""
    core, clock, transport, latch = start()
    before = len(transport.published)

    estop = deliver(transport, clock, "ESTOP")

    assert labels(transport)[before:] == ["ACK", "STATE_CHANGED"]
    ack = body_of(transport, before)
    assert ack["result"] == "ACK"
    assert ack["state"] == "ESTOP"
    assert core.snapshot().banner == "ESTOP"
    assert latch.record is not None
    assert latch.record.command_id == estop["commandId"]


def test_estop_from_teleop_keeps_the_lock_and_latches() -> None:
    """Given a teleoperated robot, ESTOP stops it and latches it, and the holder keeps the lock."""
    core, clock, transport, latch = make_teleop()

    deliver(transport, clock, "ESTOP")

    assert core.snapshot().state == "ESTOP"
    assert core.snapshot().lock_held is True
    assert latch.record is not None


def test_estop_while_stopped_is_acknowledged_without_a_new_latch_write() -> None:
    """Given a latched robot, another ESTOP is ACKed in place and writes no new latch.

    The state table gives ESTOP-to-ESTOP no effect, so the latch from the first stop stands. The
    design text asks for a rewrite here; the table is the source of truth and this test pins it.
    """
    core, clock, transport, latch = make_core(latched=True)
    before = len(transport.published)

    deliver(transport, clock, "ESTOP")

    assert labels(transport)[before:] == ["ACK"]
    assert body_of(transport, before)["state"] == "ESTOP"
    assert latch.set_calls == 0
    assert core.snapshot().state == "ESTOP"


def test_estop_release_of_a_latched_boot_pauses_and_clears_the_latch() -> None:
    """Given a boot in ESTOP, the origin is unknown, so the release fails safe to PAUSED."""
    core, clock, transport, latch = make_core(latched=True)
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)
    before = len(transport.published)

    deliver(transport, clock, "ESTOP_RELEASE", lockToken=LOCK_TOKEN)

    assert labels(transport)[before:] == ["ACK", "STATE_CHANGED"]
    assert body_of(transport, before)["state"] == "PAUSED"
    change = body_of(transport, before + 1)
    assert change["from"] == "ESTOP"
    assert change["to"] == "PAUSED"
    assert change["cause"] == "ESTOP_RELEASE"
    assert latch.record is None
    assert core.snapshot().latch_persisted is True


def test_estop_of_an_idle_robot_then_release_returns_to_idle() -> None:
    """Given an idle robot, ESTOP, TAKE_CONTROL and ESTOP_RELEASE give IDLE and clear the latch."""
    core, clock, transport, latch = make_core()
    deliver(transport, clock, "ESTOP")
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)
    before = len(transport.published)

    deliver(transport, clock, "ESTOP_RELEASE", lockToken=LOCK_TOKEN)

    assert labels(transport)[before:] == ["ACK", "STATE_CHANGED"]
    assert body_of(transport, before)["state"] == "IDLE"
    change = body_of(transport, before + 1)
    assert (change["from"], change["to"], change["cause"]) == ("ESTOP", "IDLE", "ESTOP_RELEASE")
    assert latch.record is None
    assert core.snapshot().state == "IDLE"


def test_estop_of_a_paused_robot_then_release_pauses() -> None:
    """Given a paused robot, ESTOP then release gives PAUSED: only an idle origin gives IDLE."""
    core, clock, transport, _ = make_core()
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)
    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)
    deliver(transport, clock, "ESTOP")

    deliver(transport, clock, "ESTOP_RELEASE", lockToken=LOCK_TOKEN)

    assert core.snapshot().state == "PAUSED"


def test_a_second_estop_keeps_the_idle_origin() -> None:
    """Given an idle robot stopped twice, the release still returns to IDLE."""
    core, clock, transport, _ = make_core()
    deliver(transport, clock, "ESTOP")
    deliver(transport, clock, "ESTOP")
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)

    deliver(transport, clock, "ESTOP_RELEASE", lockToken=LOCK_TOKEN)

    assert core.snapshot().state == "IDLE"


def test_release_of_an_idle_origin_without_the_lock_is_refused() -> None:
    """Given an idle robot in ESTOP, a release without the lock is refused."""
    core, clock, transport, latch = make_core()
    deliver(transport, clock, "ESTOP")
    before = len(transport.published)

    deliver(transport, clock, "ESTOP_RELEASE", lockToken=LOCK_TOKEN)

    assert body_of(transport, before)["result"] == "REJECT"
    assert core.snapshot().state == "ESTOP"
    assert latch.record is not None


def test_estop_release_with_a_failing_latch_clear_stays_in_estop(
    caplog: LogCaptureFixture,
) -> None:
    """Given a latch that cannot be removed, ESTOP_RELEASE is refused and the robot stays down."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    store = MemoryLatchStore(latched=True, fail_clear=True)
    core, clock, transport, _ = build_core(latch=store)
    core.boot()
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)
    before = len(transport.published)

    deliver(transport, clock, "ESTOP_RELEASE", lockToken=LOCK_TOKEN)

    assert labels(transport)[before:] == ["ACK"]
    ack = body_of(transport, before)
    assert ack["result"] == "REJECT"
    assert ack["reason"] == "INVALID_STATE"
    assert core.snapshot().state == "ESTOP"
    assert store.record is not None
    assert any(r.getMessage() == "latch.clear_failed" for r in caplog.records)


def test_estop_survives_a_failing_latch_write_and_is_reported() -> None:
    """Given a latch that cannot be written, the stop still happens and persistence is reported."""
    store = MemoryLatchStore(fail_set=True)
    core, clock, transport, _ = build_core(latch=store)
    core.boot()

    deliver(transport, clock, "ESTOP")

    assert core.snapshot().state == "ESTOP"
    assert core.snapshot().latch_persisted is False
    assert store.set_calls == 1


def test_heartbeat_with_the_lock_is_never_answered() -> None:
    """Given the lock, an accepted HEARTBEAT gives no acknowledgement and no event."""
    _, clock, transport, _ = make_teleop()
    before = len(transport.published)

    deliver(transport, clock, "HEARTBEAT", lockToken=LOCK_TOKEN)

    assert len(transport.published) == before


def test_heartbeat_without_the_lock_is_silent_and_logged(caplog: LogCaptureFixture) -> None:
    """Given no lock, a HEARTBEAT is refused without an answer, and the refusal is logged."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, clock, transport, _ = make_core()
    before = len(transport.published)

    deliver(transport, clock, "HEARTBEAT", lockToken=OTHER_TOKEN)

    assert len(transport.published) == before
    assert any(r.getMessage() == "heartbeat.refused" for r in caplog.records)


def test_a_failed_estop_latch_is_retried_by_the_next_estop_and_then_persisted(
    caplog: LogCaptureFixture,
) -> None:
    """Given a failed e-stop latch write, the next e-stop retries it and clears the flag."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    store = MemoryLatchStore(fail_set=True)
    core, clock, transport, _ = build_core(latch=store)
    core.boot()
    deliver(transport, clock, "ESTOP")
    assert core.snapshot().latch_persisted is False
    store.fail_set = False

    second = deliver(transport, clock, "ESTOP")

    assert store.set_calls == 2
    assert store.record is not None
    assert store.record.command_id == second["commandId"]
    assert core.snapshot().latch_persisted is True
    assert any(r.getMessage() == "latch.set" for r in caplog.records)


def test_an_estop_while_the_latch_is_in_place_writes_nothing_again() -> None:
    """Given an e-stop whose latch was written, another e-stop does not rewrite it."""
    core, clock, transport, store = make_core()
    deliver(transport, clock, "ESTOP")

    deliver(transport, clock, "ESTOP")

    assert store.set_calls == 1
    assert core.snapshot().latch_persisted is True


@pytest.mark.parametrize("command_type", ["PAUSE", "RETURN_TO_BASE", "RESUME"])
def test_commands_after_begin_shutdown_are_dropped(
    caplog: LogCaptureFixture,
    command_type: str,
) -> None:
    """Given a shutdown in progress, every command but an e-stop is dropped without an answer."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, _ = make_teleop()

    core.begin_shutdown()

    assert core.stopping is True
    before = len(transport.published)
    deliver(transport, clock, command_type, lockToken=LOCK_TOKEN)
    assert len(transport.published) == before
    dropped = [r for r in caplog.records if r.getMessage() == "command.dropped"]
    assert field_of(dropped[-1], "stage") == "STOPPING"


def test_repeated_drops_while_stopping_are_logged_once_per_interval(
    caplog: LogCaptureFixture,
) -> None:
    """Given a stopping robot, a burst of dropped commands writes one line in the interval."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, _ = make_teleop()
    core.begin_shutdown()

    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)
    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)
    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)

    dropped = [r for r in caplog.records if r.getMessage() == "command.dropped"]
    assert len(dropped) == 1


def test_an_estop_is_still_latched_and_acknowledged_while_stopping(
    caplog: LogCaptureFixture,
) -> None:
    """Given a stopping robot, an e-stop is acknowledged, latched and changes the state."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, latch = make_teleop()
    core.begin_shutdown()
    before = len(transport.published)

    estop = deliver(transport, clock, "ESTOP")

    assert labels(transport)[before:] == ["ACK", "STATE_CHANGED"]
    assert body_of(transport, before)["result"] == "ACK"
    assert core.snapshot().state == "ESTOP"
    assert latch.record is not None
    assert latch.record.command_id == estop["commandId"]


def test_begin_shutdown_can_be_called_again_and_logs_the_stop_once(
    caplog: LogCaptureFixture,
) -> None:
    """Given a shutdown in progress, a second call changes nothing and logs nothing new."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _, _, _ = make_teleop()
    core.begin_shutdown()

    core.begin_shutdown()

    assert core.stopping is True
    stopping = [r for r in caplog.records if r.getMessage() == "agent.stopping"]
    assert len(stopping) == 1


def test_build_goodbye_returns_the_going_offline_event_to_publish_last() -> None:
    """Given a shutdown in progress, the goodbye is a GOING_OFFLINE event on the events topic."""
    core, _, _, _ = make_teleop()
    core.begin_shutdown()

    goodbye = core.build_goodbye()

    assert goodbye is not None
    assert goodbye.topic == events_topic(SITE_ID, ROBOT_ID)
    assert json.loads(goodbye.payload)["kind"] == "GOING_OFFLINE"


def test_the_goodbye_sequence_is_above_every_message_published_before_it() -> None:
    """Given an e-stop arrives after the shutdown began, the goodbye still has the highest seq."""
    core, clock, transport, _ = make_teleop()
    deliver(transport, clock, "PAUSE", lockToken=LOCK_TOKEN)
    core.begin_shutdown()
    deliver(transport, clock, "ESTOP")

    goodbye = core.build_goodbye()

    assert goodbye is not None
    goodbye_seq = json.loads(goodbye.payload)["seq"]
    for index in range(len(transport.published)):
        seq = body_of(transport, index)["seq"]
        assert isinstance(seq, int)
        assert goodbye_seq > seq


def test_begin_shutdown_takes_no_sequence_number_until_the_goodbye_is_built() -> None:
    """Given a shutdown began, the next message after it follows the last one without a gap."""
    core, clock, transport, _ = make_teleop()
    last_index = len(transport.published) - 1
    last_seq = body_of(transport, last_index)["seq"]
    assert isinstance(last_seq, int)
    core.begin_shutdown()
    before = len(transport.published)

    deliver(transport, clock, "ESTOP")

    ack_seq = body_of(transport, before)["seq"]
    assert ack_seq == last_seq + 1


def test_a_goodbye_that_cannot_be_built_is_logged_and_the_stop_still_happens(
    monkeypatch: pytest.MonkeyPatch,
    caplog: LogCaptureFixture,
) -> None:
    """Given a goodbye that fails its schema, build_goodbye returns None and logs it.

    The stop itself never builds the goodbye, so it still happens.
    """
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _, _, _ = make_teleop()

    def refuse(self: MessageFactory) -> NoReturn:
        """Stands in for the goodbye builder and refuses the message.

        Args:
            self: The factory.

        Raises:
            MessageBuildError: Always.
        """
        raise MessageBuildError(("kind",))

    monkeypatch.setattr(MessageFactory, "going_offline", refuse)
    core.begin_shutdown()

    goodbye = core.build_goodbye()

    assert goodbye is None
    assert core.stopping is True
    failed = [r for r in caplog.records if r.getMessage() == "message.build_failed"]
    assert field_of(failed[-1], "label") == "GOING_OFFLINE"


def _lock_events_since(transport: FakeTransport, start: int) -> list[int]:
    """Lists the indexes of the lock events published from `start` on, in order.

    Args:
        transport: The fake that recorded the publishes.
        start: The first index to look at.

    Returns:
        The indexes whose publish is a lock change.
    """
    return [
        index
        for index, label in enumerate(labels(transport))
        if label == "LOCK_CHANGED" and index >= start
    ]


def test_a_takeover_after_a_tick_expired_the_lock_is_reported_as_a_takeover() -> None:
    """Given the lock expired in a tick, another operator's grant is reported as a takeover."""
    core, clock, transport, _ = make_teleop()
    clock.advance(30000)
    core.tick()
    before = len(transport.published)

    deliver(transport, clock, "TAKE_CONTROL", lockToken=OTHER_TOKEN, issuedBy=OTHER_SUB)

    lock_events = _lock_events_since(transport, before)
    taken = body_of(transport, lock_events[-1])
    assert taken["cause"] == "TAKEOVER"
    assert taken["holder"] == OTHER_SUB


def test_the_same_operator_after_a_tick_expired_the_lock_is_acquired_not_taken_over() -> None:
    """Given the same operator's lock expired in a tick, the new grant is an acquisition."""
    core, clock, transport, _ = make_teleop()
    clock.advance(30000)
    core.tick()
    before = len(transport.published)

    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)

    lock_events = _lock_events_since(transport, before)
    granted = body_of(transport, lock_events[-1])
    assert granted["cause"] == "ACQUIRED"
