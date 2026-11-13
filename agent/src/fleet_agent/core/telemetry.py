"""Telemetry: the periodic reports of the robot's position, and the heartbeat of a quiet robot.

The scheduler decides when a report is due; this module builds and sends it. Telemetry is best
effort: a dropped report is replaced by the next one, which carries the state anyway. A heartbeat
keeps a silent robot from being taken for a dead one. A summary line, once per interval, lets an
operator see that the robot is still reporting without reading every message.
"""

from __future__ import annotations

import logging

from fleet_agent.core.constants import TELEMETRY_SUMMARY_INTERVAL_MS
from fleet_agent.core.corelog import CoreLog
from fleet_agent.core.messages import TelemetryFields
from fleet_agent.core.model import RobotModel
from fleet_agent.core.outbox import Outbox
from fleet_agent.core.scheduler import TelemetryScheduler


class TelemetryPublisher:
    """Sends the telemetry and heartbeats the scheduler asks for, and the periodic summary line.

    The publisher reads the robot model; it never changes it.
    """

    def __init__(
        self,
        *,
        model: RobotModel,
        outbox: Outbox,
        scheduler: TelemetryScheduler,
        log: CoreLog,
        now_ms: int,
    ) -> None:
        """Creates a publisher whose first summary falls due one interval after `now_ms`.

        Args:
            model: The robot model, read for every report.
            outbox: The door the reports are published through.
            scheduler: The scheduler that decides what is due.
            log: The core's log writer.
            now_ms: The monotonic time at which the core started, in milliseconds.
        """
        self._model = model
        self._outbox = outbox
        self._scheduler = scheduler
        self._log = log
        self._summary_due_ms = now_ms + TELEMETRY_SUMMARY_INTERVAL_MS
        self._telemetry_since_summary = 0

    def publish_due(self, now: int) -> None:
        """Publishes the report or the heartbeat that is due, and the summary line if it is time.

        Args:
            now: The current monotonic time, in milliseconds.
        """
        due = self._scheduler.due(now, moving=self._model.speed > 0)
        if due == "TELEMETRY":
            self._publish_telemetry()
        elif due == "HEARTBEAT":
            self._publish_heartbeat()
        self._maybe_log_summary(now)

    def _publish_telemetry(self) -> None:
        """Publishes one telemetry message on the best-effort channel."""
        model = self._model
        fields = TelemetryFields(
            x=model.x,
            y=model.y,
            heading=model.heading,
            state=model.state,
            battery=model.battery,
            speed=model.speed,
            mission_id=model.mission_id,
            error_code=model.fault,
        )
        factory = self._outbox.factory
        if self._outbox.send("TELEMETRY", lambda: factory.telemetry(fields)):
            self._telemetry_since_summary += 1

    def _publish_heartbeat(self) -> None:
        """Publishes a heartbeat event, so that a silent robot is not taken for a dead one."""
        model = self._model
        factory = self._outbox.factory
        self._outbox.send(
            "HEARTBEAT",
            lambda: factory.heartbeat(state=model.state, battery=model.battery),
        )

    def _maybe_log_summary(self, now: int) -> None:
        """Logs the telemetry progress once per summary interval, so an operator sees it run.

        Args:
            now: The current monotonic time, in milliseconds.
        """
        if now < self._summary_due_ms:
            return
        model = self._model
        self._log.log(
            logging.INFO,
            "telemetry.summary",
            count=self._telemetry_since_summary,
            seq=self._outbox.factory.last_seq,
            state=model.state,
            x=model.x,
            y=model.y,
            battery=model.battery,
        )
        self._telemetry_since_summary = 0
        self._summary_due_ms = now + TELEMETRY_SUMMARY_INTERVAL_MS
