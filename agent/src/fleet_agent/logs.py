"""Structured JSON logs with an allowlist, so that a secret cannot reach a log line by accident.

Every record is one JSON object on one line. Only the fields named in `LOG_FIELDS` are written, and
only with a scalar or a list of strings as value. Anything else is dropped and counted, so adding a
sensitive field to a log call is a visible change to this file, not a silent leak.
"""

from __future__ import annotations

import json
import logging
import math
import sys
import traceback
from pathlib import PurePath
from typing import TextIO

from fleet_agent.timefmt import format_iso_ms

LOG_FIELDS: frozenset[str] = frozenset(
    {
        "event",
        "level",
        "ts",
        "logger",
        "robotId",
        "siteId",
        "bootId",
        "thingName",
        "correlationId",
        "commandId",
        "commandType",
        "result",
        "reason",
        "stage",
        "state",
        "fromState",
        "toState",
        "cause",
        "trigger",
        "lockCause",
        "fault",
        "seq",
        "label",
        "qos",
        "outcome",
        "reasonCode",
        "errorName",
        "errorPaths",
        "attempt",
        "delayMs",
        "ageMs",
        "sizeBytes",
        "durationMs",
        "sinceMs",
        "pending",
        "suppressed",
        "count",
        "x",
        "y",
        "battery",
        "exitCode",
        "version",
        "simulated",
        "code",
        "traceback",
        "latch",
        "port",
        "droppedFields",
    }
)
"""Keys a log record may carry. Any other extra key is dropped. Names are camelCase, as on wire."""

EVENT_NAMES: frozenset[str] = frozenset(
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
"""The closed list of event names: the message of every line the agent writes. `foreign.log` is
the one the formatter writes for a record it does not own, in place of its message."""

FOREIGN_EVENT: str = "foreign.log"
"""The event name of a record that is not the agent's: a library's, or an unlisted message."""

_OWN_LOGGER: str = "fleet_agent"
"""The root of the logger names the agent owns. Records of any other logger are foreign."""

_BASE_KEYS: frozenset[str] = frozenset({"ts", "level", "event", "logger"})
"""Keys the formatter writes itself. An extra with one of these names cannot overwrite them."""

# A record built by the stdlib carries these attributes. They are not extras, so they are not
# judged against the allowlist. Built once from a real record, so the list follows the runtime.
_STANDARD_ATTRIBUTES: frozenset[str] = frozenset(
    vars(logging.LogRecord("", 0, "", 0, "", None, None))
) | frozenset({"message", "asctime"})

_handler: logging.Handler | None = None
"""The one handler `configure_logging` installed. Kept so that a second call replaces it."""


def _is_allowed_value(value: object) -> bool:
    """Tells whether a value may be written to a log line.

    Args:
        value: The value of an extra field.

    Returns:
        True for a string, boolean, integer, None, a finite float, or a list or tuple of strings.
    """
    if value is None or isinstance(value, bool | int | str):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list | tuple):
        return all(isinstance(item, str) for item in value)
    return False


def _is_own_logger(name: str) -> bool:
    """Tells whether a logger belongs to the agent.

    Args:
        name: The logger name.

    Returns:
        True for `fleet_agent` and its children, false for every other name.
    """
    return name == _OWN_LOGGER or name.startswith(f"{_OWN_LOGGER}.")


def _foreign_line(record: logging.LogRecord, ts: str) -> str:
    """Renders a record that is not the agent's, keeping only its level and logger.

    A library's message is not ours to vouch for, and it can quote a value that must not be
    written. The message and the arguments are therefore never read on this path.

    Args:
        record: The foreign record.
        ts: The record's timestamp, already formatted.

    Returns:
        A single line of JSON with the foreign event name.
    """
    line: dict[str, object] = {
        "ts": ts,
        "level": record.levelname,
        "event": FOREIGN_EVENT,
        "logger": record.name,
    }
    return json.dumps(line, separators=(",", ":"), allow_nan=False)


class JsonFormatter(logging.Formatter):
    """Formats a record as one JSON object per line, with the allowlisted fields only.

    The exception information of a record is never rendered: a traceback can quote a value. Frames
    are logged through `safe_traceback` instead, which keeps locations and no message text. A record
    whose logger is not the agent's, or whose message is not a listed event, is written as
    `foreign.log` with its level and logger only.
    """

    def format(self, record: logging.LogRecord) -> str:
        """Renders one record.

        Args:
            record: The record to render.

        Returns:
            A single line of JSON. When some extra fields were dropped, the line carries
            `droppedFields` with their number.
        """
        ts = format_iso_ms(int(record.created * 1000))
        if not _is_own_logger(record.name):
            return _foreign_line(record, ts)
        event = record.getMessage()
        if event not in EVENT_NAMES:
            return _foreign_line(record, ts)
        fields: dict[str, object] = {
            "ts": ts,
            "level": record.levelname,
            "event": event,
            "logger": record.name,
        }
        dropped = 0
        for key, value in vars(record).items():
            if key in _STANDARD_ATTRIBUTES:
                continue
            if key in _BASE_KEYS or key not in LOG_FIELDS or not _is_allowed_value(value):
                dropped += 1
                continue
            fields[key] = value
        if dropped:
            fields["droppedFields"] = dropped
        return json.dumps(fields, separators=(",", ":"), allow_nan=False)


def configure_logging(level: str, stream: TextIO | None = None) -> None:
    """Routes the root logger to one JSON handler, replacing the one installed by an earlier call.

    Args:
        level: A standard level name, such as `INFO`.
        stream: Where the lines go. Defaults to standard output, which systemd and the terminal
            both capture.

    Raises:
        ValueError: If `level` is not a known level name.
    """
    global _handler
    root = logging.getLogger()
    root.setLevel(level)
    if _handler is not None:
        root.removeHandler(_handler)
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    _handler = handler


def safe_traceback(exc: BaseException, limit: int = 10) -> list[str]:
    """Returns the frames of an exception as locations, without any message text.

    Args:
        exc: The exception whose traceback is summarised.
        limit: The number of innermost frames kept.

    Returns:
        One `file.py:line:function` entry per frame, outermost first. The exception message is
        never included, because it can quote the value that failed.
    """
    frames = traceback.extract_tb(exc.__traceback__)
    kept = frames[max(len(frames) - limit, 0) :]
    return [f"{PurePath(frame.filename).name}:{frame.lineno}:{frame.name}" for frame in kept]
