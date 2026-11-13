"""The clock of the real robot: the operating system's monotonic and wall clocks."""

from __future__ import annotations

import time

_NS_PER_MS = 1_000_000


class SystemClock:
    """Reads the operating system's clocks, in integer milliseconds.

    The monotonic clock drives every timer and never steps. The wall clock only stamps messages
    and checks command ages, so an NTP step on it is tolerated by the age window.
    """

    def monotonic_ms(self) -> int:
        """Returns the monotonic time in milliseconds.

        Returns:
            A non-negative integer that never goes backwards.
        """
        return time.monotonic_ns() // _NS_PER_MS

    def wall_ms(self) -> int:
        """Returns the wall-clock time in milliseconds since the Unix epoch.

        Returns:
            A non-negative integer. It may step when NTP corrects the clock.
        """
        return time.time_ns() // _NS_PER_MS
