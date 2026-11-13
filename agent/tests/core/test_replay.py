"""Replay memory: first sighting, eviction order, the no-refresh rule and the capacity check."""

from __future__ import annotations

import pytest

from fleet_agent.core.replay import ReplayGuard
from fleet_agent.protocol.constants import REPLAY_LRU_SIZE


def test_the_first_sighting_is_recorded_and_the_second_is_a_replay() -> None:
    guard = ReplayGuard()

    assert guard.seen_or_record("cmd-a") is False
    assert guard.seen_or_record("cmd-a") is True


def test_the_default_capacity_is_the_protocol_replay_size() -> None:
    guard = ReplayGuard()
    for index in range(REPLAY_LRU_SIZE + 5):
        guard.seen_or_record(f"cmd-{index}")

    assert len(guard) == REPLAY_LRU_SIZE


def test_the_oldest_identifier_is_evicted_and_then_accepted_again() -> None:
    guard = ReplayGuard(capacity=1000)
    guard.seen_or_record("cmd-first")

    for index in range(1000):
        guard.seen_or_record(f"cmd-new-{index}")

    assert guard.seen_or_record("cmd-first") is False


def test_a_repeat_does_not_refresh_its_place_in_the_order() -> None:
    guard = ReplayGuard(capacity=2)
    guard.seen_or_record("cmd-a")
    guard.seen_or_record("cmd-b")
    assert guard.seen_or_record("cmd-a") is True

    guard.seen_or_record("cmd-c")

    assert guard.seen_or_record("cmd-b") is True
    assert guard.seen_or_record("cmd-a") is False


def test_length_never_exceeds_the_capacity() -> None:
    guard = ReplayGuard(capacity=3)

    for index in range(10):
        guard.seen_or_record(f"cmd-{index}")

    assert len(guard) == 3


@pytest.mark.parametrize("capacity", [0, -1])
def test_a_capacity_below_one_is_refused(capacity: int) -> None:
    with pytest.raises(ValueError, match="capacity"):
        ReplayGuard(capacity=capacity)
