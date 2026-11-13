"""Telemetry scheduler: decides when the robot publishes telemetry and when it sends a heartbeat.

A real robot reports at a fixed rate in every state, so the console sees it as alive without a
heartbeat. A simulated robot reports only while it moves, which keeps a simulated fleet cheap; a
simulated robot that stays quiet gets a heartbeat, so it is not taken for dead. Any publish counts
as proof of life, so the heartbeat is only sent when the robot has been silent for its interval.

The scheduler holds no clock and no transport. The caller passes the monotonic time, which keeps
every decision deterministic in tests.
"""

from __future__ import annotations

from typing import Literal

from fleet_agent.protocol.constants import (
    REAL_TELEMETRY_HZ,
    ROBOT_HEARTBEAT_INTERVAL_MS,
    SIM_TELEMETRY_MOVING_HZ,
)

SchedulerDecision = Literal["TELEMETRY", "HEARTBEAT"]
"""What the robot must publish now. `None` from `due` means nothing is due."""

_REAL_TELEMETRY_INTERVAL_MS = round(1000 / REAL_TELEMETRY_HZ)
_SIM_TELEMETRY_INTERVAL_MS = round(1000 / SIM_TELEMETRY_MOVING_HZ)


class TelemetryScheduler:
    """Tracks the last publishes and says what is due next.

    An immediate request is a request for telemetry as soon as possible. It is satisfied by the
    next telemetry publish, so a state change reaches the console without waiting for the period.
    """

    def __init__(self, *, simulated: bool) -> None:
        """Creates a scheduler that has published nothing yet.

        Args:
            simulated: Whether the robot is a simulator, which reports only while it moves.
        """
        self._simulated = simulated
        self._last_telemetry_ms: int | None = None
        self._last_publish_ms: int | None = None
        self._immediate = False

    def request_immediate(self) -> None:
        """Asks for telemetry at the next opportunity, outside its period."""
        self._immediate = True

    def record_publish(self, now_ms: int, *, telemetry: bool) -> None:
        """Records a publish attempt. A telemetry publish also satisfies an immediate request.

        Args:
            now_ms: The monotonic time of the attempt, in milliseconds.
            telemetry: Whether the message was telemetry.
        """
        self._last_publish_ms = now_ms
        if telemetry:
            self._last_telemetry_ms = now_ms
            self._immediate = False

    def due(self, now_ms: int, *, moving: bool) -> SchedulerDecision | None:
        """Says what must be published now, if anything.

        Args:
            now_ms: The current monotonic time, in milliseconds.
            moving: Whether the robot is moving. Only a simulated robot's rate depends on it.

        Returns:
            `TELEMETRY` for an immediate request or a due period, `HEARTBEAT` after the silence
            interval, or `None` when nothing is due.
        """
        if self._immediate or self._telemetry_due(now_ms, moving=moving):
            return "TELEMETRY"
        if self._heartbeat_due(now_ms):
            return "HEARTBEAT"
        return None

    def _telemetry_due(self, now_ms: int, *, moving: bool) -> bool:
        """Tells whether the telemetry period has elapsed.

        Args:
            now_ms: The current monotonic time, in milliseconds.
            moving: Whether the robot is moving.

        Returns:
            True when a telemetry is due. A stationary simulator never reports on the period.
        """
        if self._simulated and not moving:
            return False
        interval = _SIM_TELEMETRY_INTERVAL_MS if self._simulated else _REAL_TELEMETRY_INTERVAL_MS
        return self._last_telemetry_ms is None or now_ms - self._last_telemetry_ms >= interval

    def _heartbeat_due(self, now_ms: int) -> bool:
        """Tells whether the robot has been silent for the heartbeat interval.

        Args:
            now_ms: The current monotonic time, in milliseconds.

        Returns:
            True when nothing was published for the interval, or nothing was ever published.
        """
        return (
            self._last_publish_ms is None
            or now_ms - self._last_publish_ms >= ROBOT_HEARTBEAT_INTERVAL_MS
        )
