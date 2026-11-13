"""Boot: the starting state, the first event, the latch, the snapshot and the log allowlist."""

from __future__ import annotations

import logging

import pytest
from _pytest.logging import LogCaptureFixture

from fleet_agent.core.corelog import CoreLog, unloggable_reasons
from fleet_agent.core.ports import LatchUnreadableError
from fleet_agent.core.throttle import LogThrottle
from fleet_agent.logs import EVENT_NAMES
from fleet_agent.protocol.topics import command_topic, events_topic

from .fakes import (
    COMMAND_TOPIC,
    LOCK_TOKEN,
    ROBOT_ID,
    SITE_ID,
    FakeClock,
    MemoryLatchStore,
    body_of,
    build_core,
    encode,
    make_command,
    make_core,
)

_EVENTS = events_topic(SITE_ID, ROBOT_ID)


def test_boot_without_latch_starts_idle_and_announces_first() -> None:
    """Given no latch, when the core boots, then it is IDLE and its first event is BOOT, seq 0."""
    core, _, transport, _ = make_core()

    assert core.snapshot().state == "IDLE"
    assert core.snapshot().banner == "NONE"
    assert len(transport.published) == 1
    topic, _, qos = transport.published[0]
    assert topic == _EVENTS
    assert qos == 1
    body = body_of(transport, 0)
    assert body["kind"] == "BOOT"
    assert body["seq"] == 0
    assert body["state"] == "IDLE"
    assert body["simulated"] is False
    assert body["agentVersion"] == "0.1.0"


def test_boot_with_latch_starts_in_estop_and_warns(caplog: LogCaptureFixture) -> None:
    """Given a set latch, when the core boots, then it is in ESTOP and a WARN line says so."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")

    core, _, transport, _ = make_core(latched=True)

    assert core.snapshot().state == "ESTOP"
    assert core.snapshot().banner == "ESTOP"
    assert body_of(transport, 0)["state"] == "ESTOP"
    warnings = [r for r in caplog.records if r.getMessage() == "agent.boot_latched"]
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING


def test_boot_refuses_an_unreadable_latch() -> None:
    """Given a latch store that cannot be read, when the core boots, then the boot raises."""
    core, _, transport, _ = build_core(latch=MemoryLatchStore(unreadable=True))

    with pytest.raises(LatchUnreadableError):
        core.boot()
    assert transport.published == []


def test_snapshot_reports_the_fields_of_a_fresh_boot() -> None:
    """Given a fresh boot, the snapshot holds the boot identifier and an unlocked, offline robot."""
    core, _, transport, _ = make_core(simulated=True)

    snapshot = core.snapshot()

    assert snapshot.lock_held is False
    assert snapshot.connected is False
    assert snapshot.simulated is True
    assert snapshot.latch_persisted is True
    assert snapshot.boot_id == body_of(transport, 0)["bootId"]


def test_an_event_outside_the_closed_list_is_reported_by_the_strict_check() -> None:
    """Given an event name the closed list does not hold, the strict check names it."""
    assert unloggable_reasons("not.an.event", {}) == ("event",)
    assert unloggable_reasons("agent.booted", {}) == ()


@pytest.mark.parametrize("field", ["lockToken", "issuedBy", "logger", "ts"])
def test_a_field_outside_the_allowlist_is_reported_by_the_strict_check(field: str) -> None:
    """Given a field outside the allowlist or a reserved key, the strict check names it."""
    assert unloggable_reasons("agent.booted", {field: "x"}) == (field,)


def test_a_core_log_call_that_would_lose_a_field_fails_the_test() -> None:
    """Given a core log call with a field outside the allowlist, the test-wide check raises."""
    writer = CoreLog(
        robot_id=ROBOT_ID,
        site_id=SITE_ID,
        boot_id="boot-under-test",
        throttle=LogThrottle(FakeClock()),
    )

    with pytest.raises(AssertionError, match="lockToken"):
        writer.log(logging.INFO, "agent.booted", lockToken="x")


def test_every_line_the_core_writes_uses_a_listed_event(caplog: LogCaptureFixture) -> None:
    """Given a scenario writing many kinds of line, every line names a listed event."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _, transport, _ = make_core(latched=True)
    transport.deliver(
        COMMAND_TOPIC,
        encode(make_command("TAKE_CONTROL", lockToken=LOCK_TOKEN)),
    )
    transport.deliver(COMMAND_TOPIC, encode(make_command("PAUSE")))
    core.on_connected()
    core.on_disconnected("ConnectionError", None)

    events = {r.getMessage() for r in caplog.records if r.name == "fleet_agent.core"}

    assert {"agent.booted", "agent.boot_latched", "command.acked", "link.lost"} <= events
    assert events <= EVENT_NAMES


def test_the_command_topic_is_the_robots_own() -> None:
    """Given the test robot, its command topic is the one the protocol defines for it."""
    assert command_topic(SITE_ID, ROBOT_ID) == COMMAND_TOPIC
