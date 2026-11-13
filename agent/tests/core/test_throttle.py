"""Log throttling: one line per key per interval, with the suppressed count reported after."""

from __future__ import annotations

from fleet_agent.core.throttle import LogThrottle

from .fakes import FakeClock


def test_first_call_for_a_key_is_allowed_with_nothing_suppressed() -> None:
    throttle = LogThrottle(FakeClock(), interval_ms=1000)

    assert throttle.allow("link.lost") == (True, 0)


def test_calls_inside_the_interval_are_refused_and_counted() -> None:
    clock = FakeClock()
    throttle = LogThrottle(clock, interval_ms=1000)
    throttle.allow("link.lost")

    clock.advance(999)

    assert throttle.allow("link.lost") == (False, 1)
    assert throttle.allow("link.lost") == (False, 2)


def test_the_interval_boundary_is_allowed_and_reports_the_suppressed_count() -> None:
    clock = FakeClock()
    throttle = LogThrottle(clock, interval_ms=1000)
    throttle.allow("link.lost")
    throttle.allow("link.lost")
    throttle.allow("link.lost")

    clock.advance(1000)

    assert throttle.allow("link.lost") == (True, 2)


def test_the_counter_restarts_after_an_allowed_line() -> None:
    clock = FakeClock()
    throttle = LogThrottle(clock, interval_ms=1000)
    throttle.allow("link.lost")
    throttle.allow("link.lost")
    clock.advance(1000)
    throttle.allow("link.lost")

    clock.advance(1000)

    assert throttle.allow("link.lost") == (True, 0)


def test_keys_are_throttled_independently() -> None:
    throttle = LogThrottle(FakeClock(), interval_ms=1000)
    throttle.allow("link.lost")

    assert throttle.allow("command.dropped") == (True, 0)
