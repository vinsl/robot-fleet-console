"""Telemetry scheduler: the real and simulated rates, the immediate request and the heartbeat."""

from __future__ import annotations

import pytest

from fleet_agent.core.scheduler import TelemetryScheduler


def test_real_robot_reports_every_500_ms_in_any_state() -> None:
    """Given a real robot, it reports again after 500 ms, whether stationary or not."""
    scheduler = TelemetryScheduler(simulated=False)
    scheduler.record_publish(0, telemetry=True)

    assert scheduler.due(499, moving=False) is None
    assert scheduler.due(500, moving=False) == "TELEMETRY"
    assert scheduler.due(500, moving=True) == "TELEMETRY"


def test_simulated_robot_reports_only_while_moving_every_2000_ms() -> None:
    """Given a simulator at rest, it sends no telemetry on the period; while moving it does."""
    scheduler = TelemetryScheduler(simulated=True)
    scheduler.record_publish(0, telemetry=True)

    assert scheduler.due(2000, moving=False) is None
    assert scheduler.due(1999, moving=True) is None
    assert scheduler.due(2000, moving=True) == "TELEMETRY"


def test_immediate_request_gives_telemetry_until_a_telemetry_is_published() -> None:
    """Given an immediate request, the next telemetry is due, and its publish satisfies it."""
    scheduler = TelemetryScheduler(simulated=False)
    scheduler.record_publish(0, telemetry=True)
    scheduler.request_immediate()

    assert scheduler.due(1, moving=False) == "TELEMETRY"
    scheduler.record_publish(1, telemetry=True)
    assert scheduler.due(2, moving=False) is None


def test_an_event_publish_does_not_satisfy_an_immediate_request() -> None:
    """Given an immediate request, an event published meanwhile leaves the telemetry still due."""
    scheduler = TelemetryScheduler(simulated=False)
    scheduler.request_immediate()
    scheduler.record_publish(0, telemetry=False)

    assert scheduler.due(0, moving=False) == "TELEMETRY"


def test_heartbeat_after_five_seconds_of_silence() -> None:
    """Given a simulator at rest that published an event, it sends a heartbeat after 5000 ms."""
    scheduler = TelemetryScheduler(simulated=True)
    scheduler.record_publish(0, telemetry=False)

    assert scheduler.due(4999, moving=False) is None
    assert scheduler.due(5000, moving=False) == "HEARTBEAT"


@pytest.mark.parametrize("simulated", [False, True])
def test_a_fresh_scheduler_is_due(simulated: bool) -> None:
    """Given a scheduler that never published, a telemetry or a heartbeat is due at once."""
    scheduler = TelemetryScheduler(simulated=simulated)

    decision = scheduler.due(0, moving=False)

    assert decision == ("HEARTBEAT" if simulated else "TELEMETRY")
