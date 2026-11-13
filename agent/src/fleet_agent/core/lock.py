"""The robot lock: which operator may command the robot, and when that right lapses.

Only one holder at a time. The holder is identified by a pair, the lock token and the operator's
subject, and both must match. The lock expires after a period without a lock-required command, so
an operator who walks away does not keep the robot hostage; another operator may then take it over.

Time is the monotonic clock of the core. A wall-clock step cannot extend or shorten the lock.
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Literal

from fleet_agent.protocol.constants import LOCK_IDLE_EXPIRY_MS

LockChangeKind = Literal["ACQUIRED", "TAKEOVER", "REFRESHED", "RELEASED", "EXPIRED"]
"""What happened to the lock. `REFRESHED` is the holder renewing it, which emits no event."""


@dataclass(frozen=True, slots=True, repr=False)
class LockHolder:
    """The identity of a lock holder: the token the console issued and the operator's subject.

    Attributes:
        token: The lock token. It is a credential for the lock and is never printed.
        sub: The operator's subject, from the verified identity of the command.
    """

    token: str
    sub: str

    def __repr__(self) -> str:
        """Describes the holder without its token.

        Returns:
            A representation that redacts both the subject and the token.
        """
        return "LockHolder(sub=<redacted>, token=<redacted>)"


def _same_pair(pair: LockHolder, token: str | None, sub: str) -> bool:
    """Tells whether a candidate identity matches a stored pair, on both fields.

    Both comparisons always run, and their results are combined without short-circuit. Stopping
    after the first mismatch would make the time taken depend on which field was wrong.

    Args:
        pair: The stored identity.
        token: The lock token of the candidate. None when the command carried no token.
        sub: The subject of the candidate.

    Returns:
        True only if the candidate has a token and both the token and the subject match.
    """
    if token is None:
        return False
    token_matches = hmac.compare_digest(token.encode("utf-8"), pair.token.encode("utf-8"))
    sub_matches = hmac.compare_digest(sub.encode("utf-8"), pair.sub.encode("utf-8"))
    return bool(token_matches & sub_matches)


class RobotLock:
    """The single lock of the robot, with an idle timer that releases it.

    Every comparison of identity runs in constant time, so a timing side channel cannot reveal the
    token one character at a time. The holder an expiry released is kept until the next grant, so
    that a late operator's grant is reported as a takeover even when the expiry ran in a tick.
    """

    def __init__(self, idle_expiry_ms: int = LOCK_IDLE_EXPIRY_MS) -> None:
        """Creates a free lock.

        Args:
            idle_expiry_ms: The time without activity after which the lock expires, in
                milliseconds.
        """
        self._idle_expiry_ms = idle_expiry_ms
        self._holder: LockHolder | None = None
        self._last_activity_ms: int | None = None
        self._expired_holder: LockHolder | None = None

    @property
    def holder(self) -> LockHolder | None:
        """The current holder, or None when the lock is free.

        Returns:
            The holder. Its representation does not show the token.
        """
        return self._holder

    @property
    def held(self) -> bool:
        """Whether a holder currently has the lock.

        Returns:
            True when the lock is held.
        """
        return self._holder is not None

    def is_holder(self, token: str | None, sub: str) -> bool:
        """Tells whether a candidate matches the current holder on both fields.

        Both comparisons always run, and their results are combined without short-circuit. Stopping
        after the first mismatch would make the time taken depend on which field was wrong.

        Args:
            token: The lock token of the candidate. None when the command carried no token.
            sub: The subject of the candidate.

        Returns:
            True only if the lock is held and both the token and the subject match.
        """
        if self._holder is None:
            return False
        return _same_pair(self._holder, token, sub)

    def can_take(self, candidate: LockHolder) -> bool:
        """Tells whether a candidate may take the lock now, without waiting for an expiry.

        Args:
            candidate: The identity asking for the lock.

        Returns:
            True when the lock is free, or when the candidate is already the holder.
        """
        return self._holder is None or self.is_holder(candidate.token, candidate.sub)

    def is_idle_expired(self, now_ms: int) -> bool:
        """Tells whether the lock has been idle for the whole expiry period.

        Args:
            now_ms: The current monotonic time, in milliseconds.

        Returns:
            True when the lock is held and the idle time reached the expiry, inclusive.
        """
        if self._last_activity_ms is None:
            return False
        return now_ms - self._last_activity_ms >= self._idle_expiry_ms

    def touch(self, now_ms: int) -> None:
        """Records activity by the holder, which restarts the idle timer. Does nothing when free.

        Args:
            now_ms: The current monotonic time, in milliseconds.
        """
        if self._holder is not None:
            self._last_activity_ms = now_ms

    def acquire(self, holder: LockHolder, now_ms: int) -> LockChangeKind:
        """Gives the lock to a candidate, or renews it when the candidate already holds it.

        The caller expires an idle lock before it asks for one, so a call on a lock held by someone
        else is a programming error and is refused, not overwritten. A grant to someone other than
        the holder that last expired is a takeover, which the console and the audit trail report
        differently from a free acquisition. The expired holder is forgotten by any grant.

        Args:
            holder: The identity to grant the lock to.
            now_ms: The current monotonic time, in milliseconds.

        Returns:
            `REFRESHED` for the same holder, `TAKEOVER` after an expiry by another holder,
            `ACQUIRED` otherwise.

        Raises:
            ValueError: If another holder still has the lock.
        """
        if self._holder is not None:
            if not self.is_holder(holder.token, holder.sub):
                raise ValueError("the lock is held by another holder")
            self._last_activity_ms = now_ms
            return "REFRESHED"
        expired = self._expired_holder
        kind: Literal["ACQUIRED", "TAKEOVER"] = (
            "TAKEOVER"
            if expired is not None and not _same_pair(expired, holder.token, holder.sub)
            else "ACQUIRED"
        )
        self._holder = holder
        self._last_activity_ms = now_ms
        self._expired_holder = None
        return kind

    def release(self) -> bool:
        """Frees the lock on the holder's request.

        Returns:
            True when a holder released it, False when it was already free.
        """
        if self._holder is None:
            return False
        self._holder = None
        self._last_activity_ms = None
        return True

    def expire(self) -> bool:
        """Frees the lock because it lapsed, and remembers the holder for the next grant.

        The caller checks that the lock is idle before it calls this.

        Returns:
            True when a holder was expired, False when the lock was already free.
        """
        if self._holder is None:
            return False
        self._expired_holder = self._holder
        self._holder = None
        self._last_activity_ms = None
        return True
