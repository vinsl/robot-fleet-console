"""The outbox: the one door through which the core publishes, under the publishing rules.

A QoS 1 message is refused when too many are waiting for their acknowledgement, which bounds the
memory of a long disconnection. A priority message, an e-stop's acknowledgement or state change,
may use a small headroom beyond that bound, so that a stop is still reported when the queue is full.
A QoS 0 message is never queued here. A message that fails its schema is logged and not sent, so a
bug in one builder cannot stop the robot. The outbox also tells the telemetry scheduler what it
sent, so the scheduler knows when the next telemetry is due.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Literal

from fleet_agent.core.constants import MAX_PENDING_QOS1, PRIORITY_QOS1_HEADROOM
from fleet_agent.core.corelog import CoreLog
from fleet_agent.core.messages import MessageBuildError, MessageFactory, OutboundMessage
from fleet_agent.core.ports import Clock, Link, PublishOutcome
from fleet_agent.core.scheduler import TelemetryScheduler
from fleet_agent.protocol.acks import AckReason
from fleet_agent.protocol.primitives import ReportedState


class Outbox:
    """Builds, bounds and publishes the core's messages, and counts the QoS 1 ones in flight.

    The counter is incremented before the transport is called and decremented if the call raises,
    so a transport error never leaks a slot. The completion callback runs after the counter is
    released, which keeps the count right even if a transport completes a publish synchronously.
    """

    def __init__(
        self,
        *,
        transport: Link,
        factory: MessageFactory,
        scheduler: TelemetryScheduler,
        log: CoreLog,
        clock: Clock,
    ) -> None:
        """Creates an outbox that is not connected and has nothing in flight.

        Args:
            transport: The MQTT link the messages go through.
            factory: The builder of every message, which owns the sequence numbers.
            scheduler: The telemetry scheduler, told of every telemetry and heartbeat sent.
            log: The core's log writer.
            clock: The source of monotonic time, for the scheduler.
        """
        self._transport = transport
        self._factory = factory
        self._scheduler = scheduler
        self._log = log
        self._clock = clock
        self._connected = False
        self._pending_qos1 = 0

    @property
    def factory(self) -> MessageFactory:
        """The builder of the messages, for the core's own announcements.

        Returns:
            The message factory of this boot.
        """
        return self._factory

    @property
    def connected(self) -> bool:
        """Whether the link to the broker is up.

        Returns:
            True between a connection and the next disconnection.
        """
        return self._connected

    def set_connected(self, connected: bool) -> None:
        """Records whether the link is up. Only a connected outbox schedules telemetry.

        Args:
            connected: True on a connection, False on a loss or a failed attempt.
        """
        self._connected = connected

    def send(
        self,
        label: str,
        build: Callable[[], OutboundMessage],
        on_done: Callable[[PublishOutcome], None] | None = None,
        *,
        priority: bool = False,
    ) -> bool:
        """Builds a message and publishes it, under the publishing rules of the core.

        Args:
            label: The message type, for the log line if the build fails.
            build: Builds the message. It runs once, and consumes a sequence number.
            on_done: Called with the outcome, after the outbox's own bookkeeping.
            priority: Whether the message may use the headroom beyond the QoS 1 cap. Only an
                e-stop's acknowledgement and state change are priority.

        Returns:
            True when the message was handed to the transport, False when it was not sent.

        Raises:
            Exception: Whatever the transport's publish raises, such as a closed socket. The QoS 1
                slot is released first, and the exception is not caught here.
        """
        try:
            message = build()
        except MessageBuildError as err:
            self._log.log(logging.ERROR, "message.build_failed", label=label, errorPaths=err.paths)
            return False
        if message.qos == 1:
            limit = MAX_PENDING_QOS1 + PRIORITY_QOS1_HEADROOM if priority else MAX_PENDING_QOS1
            if self._pending_qos1 >= limit:
                self._log.log_throttled(
                    "outbox.full",
                    logging.ERROR,
                    "outbox.full",
                    label=message.label,
                    pending=self._pending_qos1,
                )
                return False
            self._pending_qos1 += 1
        try:
            self._transport.publish(
                message.topic,
                message.payload,
                message.qos,
                lambda outcome: self._publish_done(message, on_done, outcome),
            )
        except Exception:
            if message.qos == 1:
                # Clamped like the completion path: a transport may report, then raise.
                self._pending_qos1 = max(0, self._pending_qos1 - 1)
            raise
        if self._connected:
            self._scheduler.record_publish(
                self._clock.monotonic_ms(),
                telemetry=message.kind == "telemetry",
            )
        return True

    def send_ack(
        self,
        *,
        command_id: str,
        correlation_id: str,
        state: ReportedState,
        result: Literal["ACK", "REJECT"],
        reason: AckReason | None,
        on_done: Callable[[PublishOutcome], None] | None = None,
        priority: bool = False,
    ) -> None:
        """Publishes an acknowledgement, with the robot's state at the time of the answer.

        Args:
            command_id: The command being answered.
            correlation_id: The correlation identifier, echoed back.
            state: The reported state at the time of the answer.
            result: `ACK` or `REJECT`.
            reason: The reason of a `REJECT`, None for an `ACK`.
            on_done: Called with the publish outcome, if the caller needs it.
            priority: Whether the acknowledgement may use the headroom beyond the QoS 1 cap.
        """
        factory = self._factory
        self.send(
            "ACK",
            lambda: factory.ack(
                command_id=command_id,
                correlation_id=correlation_id,
                state=state,
                result=result,
                reason=reason,
            ),
            on_done,
            priority=priority,
        )

    def _publish_done(
        self,
        message: OutboundMessage,
        user_done: Callable[[PublishOutcome], None] | None,
        outcome: PublishOutcome,
    ) -> None:
        """Handles the outcome of a publish: releases its slot, logs a failure, then notifies.

        A failed publish is logged and not retried: the next telemetry carries the state anyway.

        Args:
            message: The message that was published.
            user_done: The caller's callback, if it gave one.
            outcome: What the transport reported.
        """
        if message.qos == 1:
            # Clamped: a transport that reports a message twice must not lift the bound by making
            # the count negative and letting later messages through.
            self._pending_qos1 = max(0, self._pending_qos1 - 1)
        if outcome.status != "OK":
            self._log.log_throttled(
                f"publish.failed.{message.label}",
                logging.WARNING,
                "publish.failed",
                label=message.label,
                outcome=outcome.status,
                reasonCode=outcome.reason_code,
                errorName=outcome.error_name,
            )
        if user_done is not None:
            user_done(outcome)
