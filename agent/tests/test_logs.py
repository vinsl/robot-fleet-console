"""The log allowlist: what a line may carry, what it never carries, and its one-line shape."""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Iterator
from typing import Any

import pytest

from fleet_agent.logs import (
    EVENT_NAMES,
    LOG_FIELDS,
    JsonFormatter,
    configure_logging,
    safe_traceback,
)

_CANARY = "canary-7f3a9c-do-not-print"


def _render(event: str, /, **extra: object) -> dict[str, Any]:
    """Logs one record through the formatter and returns the decoded line.

    Args:
        event: The message of the record, which is the event name.
        **extra: The extra fields of the record.

    Returns:
        The JSON object written for the record.
    """
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.Logger("fleet_agent.test")
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    logger.info(event, extra=extra)
    decoded: dict[str, Any] = json.loads(stream.getvalue())
    return decoded


def test_allowlisted_fields_are_kept_with_their_values() -> None:
    line = _render(
        "command.acked",
        robotId="kali-01",
        commandType="PAUSE",
        seq=7,
        battery=81.5,
        simulated=False,
    )

    assert line["event"] == "command.acked"
    assert line["level"] == "INFO"
    assert line["logger"] == "fleet_agent.test"
    assert line["robotId"] == "kali-01"
    assert line["commandType"] == "PAUSE"
    assert line["seq"] == 7
    assert line["battery"] == 81.5
    assert line["simulated"] is False
    assert "droppedFields" not in line


def test_timestamp_is_iso_with_milliseconds_in_utc() -> None:
    line = _render("agent.booted")

    assert line["ts"].endswith("Z")
    assert len(line["ts"]) == len("2026-11-02T10:00:00.000Z")


def test_unknown_field_is_dropped_and_counted() -> None:
    line = _render("agent.booted", robotId="kali-01", notInTheAllowlist="value")

    assert "notInTheAllowlist" not in line
    assert line["robotId"] == "kali-01"
    assert line["droppedFields"] == 1


def test_a_lock_token_is_never_printed() -> None:
    line = _render("command.acked", lockToken=_CANARY)

    assert _CANARY not in json.dumps(line)
    assert "lockToken" not in line
    assert line["droppedFields"] == 1


def test_a_field_with_a_disallowed_value_type_is_dropped() -> None:
    line = _render("command.rejected", errorPaths={"nested": "dict"}, count=[1, 2])

    assert "errorPaths" not in line
    assert "count" not in line
    assert line["droppedFields"] == 2


def test_a_non_finite_float_is_dropped_rather_than_breaking_the_line() -> None:
    line = _render("telemetry.summary", x=float("nan"), y=1.5)

    assert "x" not in line
    assert line["y"] == 1.5
    assert line["droppedFields"] == 1


def test_a_tuple_of_strings_is_written_as_a_list() -> None:
    line = _render("command.rejected", errorPaths=("command.commandId", "command.params"))

    assert line["errorPaths"] == ["command.commandId", "command.params"]


def test_a_list_holding_a_non_string_is_dropped() -> None:
    line = _render("command.rejected", errorPaths=("ok", 3))

    assert "errorPaths" not in line


def test_an_extra_cannot_overwrite_the_fields_the_formatter_writes() -> None:
    line = _render("agent.booted", event="spoofed", level="DEBUG")

    assert line["event"] == "agent.booted"
    assert line["level"] == "INFO"
    assert line["droppedFields"] == 2


def test_exception_information_is_never_rendered() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.Logger("fleet_agent.test")
    logger.addHandler(handler)
    try:
        raise ValueError("secret-value-in-message")
    except ValueError:
        logger.exception("kit.refused")

    text = stream.getvalue()
    assert "secret-value-in-message" not in text
    assert "Traceback" not in text
    assert "exc_info" not in text


def test_a_line_is_one_json_object_even_when_a_value_holds_a_newline() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.Logger("fleet_agent.test")
    logger.addHandler(handler)

    logger.info("command.rejected", extra={"errorPaths": ("first\nsecond",)})

    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["errorPaths"] == ["first\nsecond"]


def test_safe_traceback_gives_locations_and_no_message_text() -> None:
    def _fail() -> None:
        raise ValueError("secret-value-in-message")

    try:
        _fail()
    except ValueError as exc:
        frames = safe_traceback(exc)

    assert frames[-1].startswith("test_logs.py:")
    assert frames[-1].endswith(":_fail")
    assert all("secret-value-in-message" not in frame for frame in frames)


def _descend(depth: int) -> None:
    """Recurses `depth` times and raises at the bottom, to build a traceback of known depth."""
    if depth == 0:
        raise ValueError("bottom")
    _descend(depth - 1)


def test_safe_traceback_keeps_only_the_innermost_frames() -> None:
    try:
        _descend(depth=5)
    except ValueError as exc:
        error = exc

    frames = safe_traceback(error, limit=2)

    assert len(frames) == 2
    assert frames[-1].endswith(":_descend")
    assert safe_traceback(error, limit=0) == []


@pytest.fixture
def restored_root_logger() -> Iterator[None]:
    """Puts the root logger back as it was, since `configure_logging` changes it."""
    root = logging.getLogger()
    handlers = list(root.handlers)
    level = root.level
    yield
    for handler in list(root.handlers):
        if handler not in handlers:
            root.removeHandler(handler)
    root.setLevel(level)


@pytest.mark.usefixtures("restored_root_logger")
def test_configure_logging_writes_json_lines_and_replaces_its_handler() -> None:
    first = io.StringIO()
    second = io.StringIO()
    configure_logging("INFO", stream=first)
    configure_logging("INFO", stream=second)

    logging.getLogger("fleet_agent.cfg").info("agent.booted", extra={"robotId": "kali-01"})

    assert first.getvalue() == ""
    assert json.loads(second.getvalue())["robotId"] == "kali-01"


@pytest.mark.usefixtures("restored_root_logger")
def test_configure_logging_refuses_an_unknown_level() -> None:
    with pytest.raises(ValueError, match="Unknown level"):
        configure_logging("LOUD", stream=io.StringIO())


def test_event_names_are_the_closed_list_of_the_specification() -> None:
    expected: frozenset[str] = frozenset(
        {
            "agent.booted",
            "agent.boot_latched",
            "agent.halted",
            "agent.fault",
            "agent.stopping",
            "agent.stopped",
            "kit.refused",
            "config.refused",
            "latch.set",
            "latch.set_failed",
            "latch.cleared",
            "latch.clear_failed",
            "latch.unreadable",
            "link.connected",
            "link.lost",
            "link.stop_timeout",
            "link.callback_failed",
            "link.connect_failed",
            "link.subscribed",
            "link.subscribe_refused",
            "link.suspended",
            "command.dropped",
            "command.rejected",
            "command.acked",
            "heartbeat.refused",
            "lock.changed",
            "deadman.expired",
            "state.changed",
            "fault.raised",
            "fault.cleared",
            "telemetry.summary",
            "publish.failed",
            "outbox.full",
            "message.build_failed",
            "probe.result",
            "video.listening",
            "video.disabled",
            "video.claimed",
            "video.claim_refused",
            "video.rearmed",
            "video.credentials_ok",
            "video.credentials_failed",
            "video.request_refused",
            "video.stopped",
            "foreign.log",
        }
    )
    assert expected == EVENT_NAMES


def test_the_allowlist_contains_the_fields_the_console_relies_on() -> None:
    assert {"robotId", "siteId", "bootId", "correlationId", "commandId"} <= LOG_FIELDS
    assert "lockToken" not in LOG_FIELDS
    assert "issuedBy" not in LOG_FIELDS


def _render_foreign(logger_name: str, message: str, *args: object) -> dict[str, Any]:
    """Logs one record from a logger the agent does not own, and returns the decoded line.

    Args:
        logger_name: The name of the logger that writes the record.
        message: The message of the record, which may carry values to format.
        *args: The arguments the message formats with.

    Returns:
        The JSON object written for the record.
    """
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.Logger(logger_name)
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    logger.warning(message, *args)
    decoded: dict[str, Any] = json.loads(stream.getvalue())
    return decoded


def test_a_foreign_record_keeps_only_its_level_and_logger() -> None:
    line = _render_foreign("urllib3.connectionpool", "retrying %s", _CANARY)

    assert line["event"] == "foreign.log"
    assert line["level"] == "WARNING"
    assert line["logger"] == "urllib3.connectionpool"
    assert set(line) == {"ts", "level", "event", "logger"}
    assert _CANARY not in json.dumps(line)


def test_a_record_of_a_logger_only_named_like_the_agent_is_foreign() -> None:
    line = _render_foreign("fleet_agentx", "agent.booted")

    assert line["event"] == "foreign.log"


def test_an_agent_record_with_an_unlisted_message_is_foreign_and_drops_the_message() -> None:
    line = _render("command.sent-with-password-" + _CANARY)

    assert line["event"] == "foreign.log"
    assert line["logger"] == "fleet_agent.test"
    assert _CANARY not in json.dumps(line)


def test_a_foreign_record_is_never_formatted_so_its_arguments_cannot_leak() -> None:
    class _Unformattable:
        """A value whose text form raises, so that formatting the message would fail."""

        def __str__(self) -> str:
            """Refuses to be formatted.

            Returns:
                Never returns.

            Raises:
                RuntimeError: Always.
            """
            raise RuntimeError("must not be formatted")

    line = _render_foreign("requests", "value %s", _Unformattable())

    assert line["event"] == "foreign.log"


_VIDEO_EVENTS = (
    "video.listening",
    "video.disabled",
    "video.claimed",
    "video.claim_refused",
    "video.rearmed",
    "video.credentials_ok",
    "video.credentials_failed",
    "video.request_refused",
    "video.stopped",
)


@pytest.mark.parametrize("event", _VIDEO_EVENTS)
def test_every_video_event_name_is_accepted(event: str) -> None:
    line = _render(event, port=49152)

    assert line["event"] == event
    assert line["port"] == 49152
    assert "droppedFields" not in line


def test_a_video_line_with_an_unknown_field_drops_it_and_keeps_the_rest() -> None:
    line = _render("video.claim_refused", reason="wrong", claimToken="secret-token-value")

    assert "claimToken" not in line
    assert line["reason"] == "wrong"
    assert line["droppedFields"] == 1
