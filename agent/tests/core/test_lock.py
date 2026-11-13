"""Robot lock: identity matching in constant time, idle expiry, acquisition kinds and redaction."""

from __future__ import annotations

import hmac
from collections.abc import Callable

import pytest

from fleet_agent.core.lock import LockHolder, RobotLock

LOCK_ID_A = "token-aaaaaaaaaaaaaaaa"
LOCK_ID_B = "token-bbbbbbbbbbbbbbbb"
SUB = "operator-sub-1"
OTHER_SUB = "operator-sub-2"
HOLDER = LockHolder(token=LOCK_ID_A, sub=SUB)


def _held_lock(now_ms: int = 0) -> RobotLock:
    """Returns a lock held by `HOLDER` since `now_ms`."""
    lock = RobotLock()
    lock.acquire(HOLDER, now_ms)
    return lock


def test_the_same_pair_is_the_holder() -> None:
    assert _held_lock().is_holder(LOCK_ID_A, SUB) is True


@pytest.mark.parametrize(
    ("token", "sub"),
    [(LOCK_ID_B, SUB), (LOCK_ID_A, OTHER_SUB), (LOCK_ID_B, OTHER_SUB)],
    ids=["other-token", "other-sub", "both-other"],
)
def test_a_differing_token_or_subject_is_not_the_holder(token: str, sub: str) -> None:
    assert _held_lock().is_holder(token, sub) is False


def test_a_missing_token_is_not_the_holder() -> None:
    assert _held_lock().is_holder(None, SUB) is False


def test_a_free_lock_has_no_holder() -> None:
    assert RobotLock().is_holder(LOCK_ID_A, SUB) is False


def test_both_fields_are_compared_even_when_the_token_differs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[bytes, bytes]] = []
    real_compare: Callable[[bytes, bytes], bool] = hmac.compare_digest

    def counting_compare(left: bytes, right: bytes) -> bool:
        calls.append((left, right))
        return real_compare(left, right)

    monkeypatch.setattr(hmac, "compare_digest", counting_compare)

    assert _held_lock().is_holder(LOCK_ID_B, SUB) is False
    assert len(calls) == 2


def test_the_lock_expires_at_exactly_the_idle_period() -> None:
    lock = _held_lock(now_ms=0)

    assert lock.is_idle_expired(29_999) is False
    assert lock.is_idle_expired(30_000) is True


def test_activity_restarts_the_idle_period() -> None:
    lock = _held_lock(now_ms=0)
    lock.touch(20_000)

    assert lock.is_idle_expired(30_000) is False
    assert lock.is_idle_expired(50_000) is True


def test_a_free_lock_never_expires_and_touch_does_nothing() -> None:
    lock = RobotLock()
    lock.touch(10)

    assert lock.is_idle_expired(10**9) is False


def test_acquiring_a_free_lock_gives_acquired() -> None:
    lock = RobotLock()

    assert lock.acquire(HOLDER, 0) == "ACQUIRED"
    assert lock.holder == HOLDER


def test_the_same_holder_renews_the_lock_as_refreshed() -> None:
    lock = _held_lock(now_ms=0)

    assert lock.acquire(HOLDER, 5_000) == "REFRESHED"
    assert lock.is_idle_expired(30_000) is False


def test_a_new_holder_after_an_expiry_takes_over() -> None:
    lock = _held_lock(now_ms=0)
    assert lock.is_idle_expired(30_000) is True
    assert lock.expire() is True

    kind = lock.acquire(LockHolder(token=LOCK_ID_B, sub=OTHER_SUB), 30_000)

    assert kind == "TAKEOVER"


def test_the_same_subject_with_a_new_token_after_an_expiry_is_a_takeover() -> None:
    """Given an expired holder, the same operator with a new token is reported as a takeover.

    The identity is the pair: a new token is a different holder, even for the same subject.
    """
    lock = _held_lock(now_ms=0)
    lock.expire()

    kind = lock.acquire(LockHolder(token=LOCK_ID_B, sub=SUB), 30_000)

    assert kind == "TAKEOVER"


def test_the_same_holder_after_its_own_expiry_is_acquired_not_taken_over() -> None:
    lock = _held_lock(now_ms=0)
    lock.expire()

    assert lock.acquire(HOLDER, 30_000) == "ACQUIRED"


def test_a_grant_after_a_takeover_forgets_the_expired_holder() -> None:
    lock = _held_lock(now_ms=0)
    lock.expire()
    lock.acquire(LockHolder(token=LOCK_ID_B, sub=OTHER_SUB), 30_000)
    assert lock.release() is True

    assert lock.acquire(HOLDER, 31_000) == "ACQUIRED"


def test_expiring_a_free_lock_changes_nothing_and_the_next_grant_is_acquired() -> None:
    lock = RobotLock()

    assert lock.expire() is False
    assert lock.acquire(LockHolder(token=LOCK_ID_B, sub=OTHER_SUB), 0) == "ACQUIRED"


def test_a_new_holder_on_a_free_lock_without_expiry_is_acquired() -> None:
    lock = RobotLock()

    kind = lock.acquire(LockHolder(token=LOCK_ID_B, sub=OTHER_SUB), 0)

    assert kind == "ACQUIRED"


def test_acquiring_over_another_live_holder_is_refused() -> None:
    lock = _held_lock()

    with pytest.raises(ValueError, match="another holder"):
        lock.acquire(LockHolder(token=LOCK_ID_B, sub=OTHER_SUB), 1)
    assert lock.holder == HOLDER


def test_can_take_when_free_or_when_the_candidate_is_the_holder() -> None:
    assert RobotLock().can_take(HOLDER) is True
    assert _held_lock().can_take(HOLDER) is True
    assert _held_lock().can_take(LockHolder(token=LOCK_ID_B, sub=OTHER_SUB)) is False


def test_release_frees_a_held_lock_and_reports_no_change_when_free() -> None:
    lock = _held_lock()

    assert lock.release() is True
    assert lock.held is False
    assert lock.release() is False


def test_the_repr_of_a_holder_hides_the_token_and_the_subject() -> None:
    text = repr(HOLDER)

    assert LOCK_ID_A not in text
    assert "<redacted>" in text
    assert SUB not in text
