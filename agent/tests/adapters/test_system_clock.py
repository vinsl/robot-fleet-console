"""Tests of the operating-system clock adapter."""

from __future__ import annotations

import time

from fleet_agent.adapters.system_clock import SystemClock


def test_monotonic_time_is_integer_and_never_goes_back() -> None:
    """The monotonic reading is an integer in milliseconds and does not decrease."""
    clock = SystemClock()

    first = clock.monotonic_ms()
    second = clock.monotonic_ms()

    assert isinstance(first, int)
    assert second >= first >= 0


def test_wall_time_is_the_epoch_time_in_milliseconds() -> None:
    """The wall reading is within a second of the epoch time in milliseconds."""
    before = time.time_ns() // 1_000_000
    reading = SystemClock().wall_ms()
    after = time.time_ns() // 1_000_000

    assert before <= reading <= after
