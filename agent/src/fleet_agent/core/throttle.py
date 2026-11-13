"""Rate limiting of repeated log lines, so a flood cannot fill the disk or hide the first cause.

A refused command or a failing reconnect can repeat several times a second. The first line of each
burst is kept, and the number of lines it stood for is reported with the next one.
"""

from __future__ import annotations

from dataclasses import dataclass

from fleet_agent.core.constants import LOG_THROTTLE_INTERVAL_MS
from fleet_agent.core.ports import Clock


@dataclass(slots=True)
class _KeyState:
    """Per-key memory: when the last line was allowed, and how many were suppressed since."""

    last_allowed_ms: int | None = None
    suppressed: int = 0


class LogThrottle:
    """Allows at most one log line per key per interval, and counts the lines it suppresses.

    The keys are fixed by the code that logs (one per event), so the memory is bounded by the
    number of log sites rather than by traffic.
    """

    def __init__(self, clock: Clock, interval_ms: int = LOG_THROTTLE_INTERVAL_MS) -> None:
        """Creates a throttle with no history.

        Args:
            clock: The source of the monotonic time that measures the interval.
            interval_ms: The minimum gap between two allowed lines of one key, in milliseconds.
        """
        self._clock = clock
        self._interval_ms = interval_ms
        self._keys: dict[str, _KeyState] = {}

    def allow(self, key: str) -> tuple[bool, int]:
        """Decides whether a log line for `key` is written now.

        Args:
            key: The throttle key, one per log site.

        Returns:
            A pair of whether to write the line, and the number of lines suppressed for the key
            since the last allowed one. A refused call counts itself in that number.
        """
        state = self._keys.setdefault(key, _KeyState())
        now = self._clock.monotonic_ms()
        if state.last_allowed_ms is None or now - state.last_allowed_ms >= self._interval_ms:
            reported = state.suppressed
            state.last_allowed_ms = now
            state.suppressed = 0
            return True, reported
        state.suppressed += 1
        return False, state.suppressed
