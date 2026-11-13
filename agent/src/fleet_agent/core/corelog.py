"""The core's log writer: the closed event list, the allowlist, and the throttle of noisy lines.

A log call on the safety path must never raise, because a logging bug would otherwise stop the
robot. In production an event outside the closed list is not written, and a field outside the
allowlist is left out and counted in `droppedFields`. The tests check every call with
`unloggable_reasons`, so a call that would lose something fails its test instead of disappearing in
the field.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from typing import Final

from fleet_agent.core.throttle import LogThrottle
from fleet_agent.logs import EVENT_NAMES, LOG_FIELDS

LogValue = str | int | float | bool | tuple[str, ...] | None
"""The values a log field may carry. `None` means the field is left out of the line."""

_LOGGER: Final = logging.getLogger("fleet_agent.core")
_RESERVED_FIELDS: Final = frozenset({"event", "level", "ts", "logger"})
"""Keys the log formatter writes itself. A call may not pass one of them as a field."""


def _refused_keys(keys: Iterable[str]) -> tuple[str, ...]:
    """Lists the field names a log call may not carry: reserved ones and those off the allowlist.

    This is the one filter both the writer and the strict check use, so they can never disagree
    about what a line loses.

    Args:
        keys: The field names of the call.

    Returns:
        The refused names, sorted.
    """
    return tuple(sorted(key for key in keys if key in _RESERVED_FIELDS or key not in LOG_FIELDS))


def unloggable_reasons(event: str, fields: Mapping[str, object]) -> tuple[str, ...]:
    """Lists what a log call would lose: an event outside the closed list, or fields outside it.

    This is the check the tests apply to every core log call. The production writer does not raise;
    it drops what this function names, so the test suite is where a broken call is caught.

    Args:
        event: The event name the call passes.
        fields: The fields the call passes, keyed by their camel-case names.

    Returns:
        `event` when the event is not in the closed list, then the names of the fields that are
        reserved or outside the allowlist, sorted. Empty when the call loses nothing.
    """
    refused_fields = _refused_keys(fields)
    if event not in EVENT_NAMES:
        return ("event", *refused_fields)
    return refused_fields


class CoreLog:
    """Writes the core's log lines, stamped with the identity of the robot and of its boot.

    The identity and the throttle are fixed at construction, so every line of a boot carries the
    same identifiers, and a rate-limited line counts the lines it suppressed.
    """

    def __init__(
        self,
        *,
        robot_id: str,
        site_id: str,
        boot_id: str,
        throttle: LogThrottle,
    ) -> None:
        """Creates the writer for one robot's boot.

        Args:
            robot_id: The robot identifier, added to every line.
            site_id: The site identifier, added to every line.
            boot_id: The identifier of this boot, added to every line.
            throttle: The throttle the rate-limited lines use.
        """
        self._robot_id = robot_id
        self._site_id = site_id
        self._boot_id = boot_id
        self._throttle = throttle

    def log(self, level: int, event: str, **fields: LogValue) -> None:
        """Writes one line. An event outside the closed list writes nothing.

        A field outside the allowlist, or a reserved key, is left out and counted in
        `droppedFields`. A field whose value is `None` is left out without a count, as it is on the
        wire.

        Args:
            level: The standard logging level.
            event: The event name. It must be in the closed list to be written.
            **fields: The camel-case fields of the line.
        """
        if event not in EVENT_NAMES:
            return
        refused = _refused_keys(fields)
        kept: dict[str, object] = {
            key: value for key, value in fields.items() if key not in refused and value is not None
        }
        if refused:
            kept["droppedFields"] = len(refused)
        extra: dict[str, object] = {
            **kept,
            "robotId": self._robot_id,
            "siteId": self._site_id,
            "bootId": self._boot_id,
        }
        _LOGGER.log(level, event, extra=extra)

    def log_throttled(self, key: str, level: int, event: str, **fields: LogValue) -> None:
        """Writes a line at most once per interval per key, and reports how many were skipped.

        Args:
            key: The throttle key, one per log site.
            level: The standard logging level.
            event: The event name.
            **fields: The fields of the line.
        """
        allowed, suppressed = self._throttle.allow(key)
        if allowed:
            self.log(level, event, suppressed=suppressed or None, **fields)
