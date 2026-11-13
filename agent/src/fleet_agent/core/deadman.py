"""Deadman: stops a robot that is being driven when its operator stops sending proof of life.

The deadman is armed only while a holder has the lock and the robot is in a state that moves. An
unlocked robot is not armed: the console is not driving it, so there is nothing to stop. The timer
runs on the monotonic clock and keeps running while the link is down, so a cut cable stops the robot
as surely as a silent operator does.
"""

from __future__ import annotations

from fleet_agent.core.state_machine import MOTION_STATES
from fleet_agent.protocol.constants import DEADMAN_TIMEOUT_MS
from fleet_agent.protocol.primitives import ReportedState


class Deadman:
    """A watchdog fed by lock-required commands, expiring when they stop for the timeout.

    A deadman that is armed but has never been fed counts as expired. An armed robot must prove its
    operator is present from the start, not inherit an arbitrary first moment.
    """

    def __init__(self, timeout_ms: int = DEADMAN_TIMEOUT_MS) -> None:
        """Creates a deadman that has never been fed.

        Args:
            timeout_ms: The silence, in milliseconds, after which an armed deadman expires.
        """
        self._timeout_ms = timeout_ms
        self._last_feed_ms: int | None = None

    @property
    def last_feed_ms(self) -> int | None:
        """The monotonic time of the most recent feed, or None if it was never fed.

        Returns:
            The time of the last feed.
        """
        return self._last_feed_ms

    def feed(self, now_ms: int) -> None:
        """Records proof of life from the operator.

        The caller feeds only after the command passed its age and lock checks, and at the time the
        operator issued it, not the time it arrived. A feed never moves the deadline backwards: a
        late copy of an older message cannot extend the window past one already recorded.

        Args:
            now_ms: The monotonic time at which the operator's proof of life was issued, in
                milliseconds.
        """
        if self._last_feed_ms is None or now_ms > self._last_feed_ms:
            self._last_feed_ms = now_ms

    def is_armed(self, *, lock_held: bool, state: ReportedState) -> bool:
        """Tells whether the deadman applies to a robot in this situation.

        Args:
            lock_held: Whether an operator holds the lock.
            state: The robot's current state.

        Returns:
            True when the lock is held and the state is one in which the robot moves.
        """
        return lock_held and state in MOTION_STATES

    def expired(self, now_ms: int, *, lock_held: bool, state: ReportedState) -> bool:
        """Tells whether the robot must be stopped now for lack of proof of life.

        Args:
            now_ms: The current monotonic time, in milliseconds.
            lock_held: Whether an operator holds the lock.
            state: The robot's current state.

        Returns:
            True when the deadman is armed and either was never fed or has been silent for at least
            the timeout, inclusive.
        """
        if not self.is_armed(lock_held=lock_held, state=state):
            return False
        if self._last_feed_ms is None:
            return True
        return now_ms - self._last_feed_ms >= self._timeout_ms
