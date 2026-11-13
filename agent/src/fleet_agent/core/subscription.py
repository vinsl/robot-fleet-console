"""The command subscription: subscribes to the robot's command topic, and retries a refused SUBACK.

A refusal is retried with full-jitter exponential backoff, so a broker that refuses a whole fleet
at once is not hit by a synchronised retry. The retry is scheduled on the monotonic clock and
driven by the core's tick, so it runs while the core is otherwise busy.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from fleet_agent.core.backoff import compute_backoff_s
from fleet_agent.core.constants import SUBSCRIBE_RETRY_BASE_S, SUBSCRIBE_RETRY_CAP_S
from fleet_agent.core.corelog import CoreLog
from fleet_agent.core.ports import Clock, Link, SubscribeOutcome


class Subscription:
    """Subscribes to one topic and keeps retrying while the broker refuses it.

    A new subscribe cancels a retry that was pending: the caller asked for a fresh attempt, so the
    old timer must not fire a second one.
    """

    def __init__(
        self,
        *,
        transport: Link,
        topic: str,
        log: CoreLog,
        clock: Clock,
        rand: Callable[[], float],
    ) -> None:
        """Creates a subscription that has not been requested yet.

        Args:
            transport: The MQTT link the subscribe goes through.
            topic: The topic filter to subscribe to.
            log: The core's log writer.
            clock: The source of monotonic time, for the retry deadline.
            rand: The uniform draw source of the full-jitter backoff, injected for tests.
        """
        self._transport = transport
        self._topic = topic
        self._log = log
        self._clock = clock
        self._rand = rand
        self._next_retry_ms: int | None = None
        self._attempt = 0

    def subscribe(self) -> None:
        """Requests the subscription now, cancelling any retry that was pending."""
        self._next_retry_ms = None
        self._transport.subscribe(self._topic, self._on_subscribed)

    def retry_due(self, now: int) -> bool:
        """Tells whether a refused subscription is due for its next attempt.

        Args:
            now: The current monotonic time, in milliseconds.

        Returns:
            True when a retry is scheduled and its time has come.
        """
        return self._next_retry_ms is not None and now >= self._next_retry_ms

    def _on_subscribed(self, outcome: SubscribeOutcome) -> None:
        """Handles the SUBACK. A refusal schedules a retry with full-jitter backoff.

        Args:
            outcome: The mapped result of the subscribe.
        """
        if outcome.status == "GRANTED":
            self._attempt = 0
            self._log.log(logging.INFO, "link.subscribed")
            return
        delay_ms = round(
            compute_backoff_s(
                self._attempt,
                base_s=SUBSCRIBE_RETRY_BASE_S,
                cap_s=SUBSCRIBE_RETRY_CAP_S,
                rand=self._rand,
            )
            * 1000
        )
        self._log.log(
            logging.ERROR,
            "link.subscribe_refused",
            outcome=outcome.status,
            reasonCode=outcome.reason_code,
            errorName=outcome.error_name,
            attempt=self._attempt,
            delayMs=delay_ms,
        )
        self._next_retry_ms = self._clock.monotonic_ms() + delay_ms
        self._attempt += 1
