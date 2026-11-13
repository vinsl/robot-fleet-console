"""The core's log writer: what a line keeps, what it leaves out, and the throttle's count."""

from __future__ import annotations

import logging
from typing import Any

from _pytest.logging import LogCaptureFixture

from fleet_agent.core.corelog import CoreLog, unloggable_reasons
from fleet_agent.core.throttle import LogThrottle
from fleet_agent.logs import LOG_FIELDS

from .fakes import ROBOT_ID, SITE_ID, FakeClock

BOOT_ID = "0190f2c4-7b1a-7c3d-8e4f-5a6b7c8d9e01"
REAL_LOG = CoreLog.log
"""The writer as it is before any test fixture wraps it, so these tests can send a bad call."""


def _writer(clock: FakeClock) -> CoreLog:
    """Builds a writer for the test robot, on the test clock.

    Args:
        clock: The clock the throttle reads.

    Returns:
        The writer.
    """
    return CoreLog(robot_id=ROBOT_ID, site_id=SITE_ID, boot_id=BOOT_ID, throttle=LogThrottle(clock))


def _lines(caplog: LogCaptureFixture) -> list[logging.LogRecord]:
    """Lists the records the core wrote, in order.

    Args:
        caplog: The fixture that captured them.

    Returns:
        The records of the core's logger.
    """
    return [r for r in caplog.records if r.name == "fleet_agent.core"]


def test_every_line_carries_the_identity_of_the_robot_and_of_its_boot(
    caplog: LogCaptureFixture,
) -> None:
    """Given a line, it names the robot, the site and the boot."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")

    _writer(FakeClock()).log(logging.INFO, "agent.booted", state="IDLE")

    record = _lines(caplog)[-1]
    assert vars(record)["robotId"] == ROBOT_ID
    assert vars(record)["siteId"] == SITE_ID
    assert vars(record)["bootId"] == BOOT_ID


def test_an_event_outside_the_closed_list_writes_nothing(caplog: LogCaptureFixture) -> None:
    """Given an event the closed list does not hold, the production writer drops the whole line."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")

    REAL_LOG(_writer(FakeClock()), logging.INFO, "not.an.event")

    assert _lines(caplog) == []


def test_a_field_outside_the_allowlist_is_left_out_and_counted(caplog: LogCaptureFixture) -> None:
    """Given a field outside the allowlist, the line keeps the others and counts the dropped one."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")

    REAL_LOG(_writer(FakeClock()), logging.INFO, "command.acked", commandId="c", lockToken="t")

    record = _lines(caplog)[-1]
    assert "lockToken" not in vars(record)
    assert vars(record)["commandId"] == "c"
    assert vars(record)["droppedFields"] == 1


def test_a_reserved_key_is_dropped_and_counted(caplog: LogCaptureFixture) -> None:
    """Given a call that passes a key the formatter writes itself, the key is dropped."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    fields: dict[str, Any] = {"ts": "forged"}

    REAL_LOG(_writer(FakeClock()), logging.INFO, "agent.booted", **fields)

    assert vars(_lines(caplog)[-1])["droppedFields"] == 1


def test_a_field_without_a_value_is_left_out_without_a_count(caplog: LogCaptureFixture) -> None:
    """Given a field whose value is None, the line omits it and reports nothing dropped."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")

    _writer(FakeClock()).log(logging.INFO, "command.rejected", errorPaths=None, commandId="c")

    record = _lines(caplog)[-1]
    assert "errorPaths" not in vars(record)
    assert "droppedFields" not in vars(record)


def test_a_throttled_line_reports_how_many_it_suppressed(caplog: LogCaptureFixture) -> None:
    """Given three calls in one interval, the next line after it reports the two it suppressed."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    clock = FakeClock()
    writer = _writer(clock)
    for _ in range(3):
        writer.log_throttled("k", logging.WARNING, "outbox.full", pending=100)

    clock.advance(1000)
    writer.log_throttled("k", logging.WARNING, "outbox.full", pending=100)

    lines = _lines(caplog)
    assert len(lines) == 2
    assert "suppressed" not in vars(lines[0])
    assert vars(lines[1])["suppressed"] == 2


def test_unloggable_reasons_names_the_event_and_the_fields_that_would_be_lost() -> None:
    """Given a call that would lose an event and two fields, the strict check names all three."""
    reasons = unloggable_reasons("not.an.event", {"lockToken": 1, "ts": 2, "robotId": 3})

    assert reasons == ("event", "lockToken", "ts")


def test_the_writer_drops_exactly_the_fields_the_strict_check_names(
    caplog: LogCaptureFixture,
) -> None:
    """Given two fields outside the allowlist, the writer drops exactly the two the check names."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    fields: dict[str, Any] = {"commandId": "c", "lockToken": "t", "ts": "forged"}

    names = unloggable_reasons("command.acked", fields)
    REAL_LOG(_writer(FakeClock()), logging.INFO, "command.acked", **fields)

    record = _lines(caplog)[-1]
    assert names == ("lockToken", "ts")
    assert vars(record)["droppedFields"] == len(names)
    assert "lockToken" not in vars(record)


def test_unloggable_reasons_is_empty_for_a_call_that_loses_nothing() -> None:
    """Given a call with a listed event and listed fields, the strict check finds nothing."""
    assert unloggable_reasons("command.acked", {"commandId": "c", "droppedFields": 1}) == ()
    assert "droppedFields" in LOG_FIELDS
