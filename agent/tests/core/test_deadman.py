"""Deadman: which situations arm it, the 1000 ms boundary, and a deadman that was never fed."""

from __future__ import annotations

from typing import get_args

import pytest

from fleet_agent.core.deadman import Deadman
from fleet_agent.core.state_machine import MOTION_STATES
from fleet_agent.protocol.primitives import ReportedState

_ALL_STATES: tuple[ReportedState, ...] = get_args(ReportedState)


@pytest.mark.parametrize("state", _ALL_STATES)
@pytest.mark.parametrize("lock_held", [True, False], ids=["locked", "unlocked"])
def test_armed_only_when_locked_and_in_a_motion_state(
    state: ReportedState, lock_held: bool
) -> None:
    armed = Deadman().is_armed(lock_held=lock_held, state=state)

    assert armed is (lock_held and state in MOTION_STATES)


def test_the_motion_states_are_the_ones_the_specification_names() -> None:
    assert set(MOTION_STATES) == {"TELEOP", "MOVING", "WORKING"}


def test_not_expired_just_under_the_timeout() -> None:
    deadman = Deadman(timeout_ms=1000)
    deadman.feed(0)

    assert deadman.expired(999, lock_held=True, state="TELEOP") is False


def test_expired_at_exactly_the_timeout() -> None:
    deadman = Deadman(timeout_ms=1000)
    deadman.feed(0)

    assert deadman.expired(1000, lock_held=True, state="TELEOP") is True


def test_a_feed_restarts_the_window() -> None:
    deadman = Deadman(timeout_ms=1000)
    deadman.feed(0)
    deadman.feed(900)

    assert deadman.expired(1500, lock_held=True, state="MOVING") is False
    assert deadman.last_feed_ms == 900


def test_an_armed_deadman_that_was_never_fed_counts_as_expired() -> None:
    assert Deadman().expired(0, lock_held=True, state="TELEOP") is True


def test_a_deadman_that_is_not_armed_never_expires() -> None:
    deadman = Deadman(timeout_ms=1000)

    assert deadman.expired(10_000, lock_held=False, state="TELEOP") is False
    assert deadman.expired(10_000, lock_held=True, state="IDLE") is False


def test_no_feed_yet_reports_no_last_feed() -> None:
    assert Deadman().last_feed_ms is None


def test_a_late_feed_never_moves_the_deadline_backwards() -> None:
    deadman = Deadman(timeout_ms=1000)
    deadman.feed(900)

    deadman.feed(-1000)

    assert deadman.last_feed_ms == 900
    assert deadman.expired(1899, lock_held=True, state="TELEOP") is False
    assert deadman.expired(1900, lock_held=True, state="TELEOP") is True
