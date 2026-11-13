"""A transport that answers the isolation probe the way a broker with a given policy would.

It is scripted, not a fake of the SDK: each call is answered on the next loop iteration, from the
allowed topics the test lists. The probe's logic, not the broker, is what the tests exercise.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Literal

from fleet_agent.core.ports import (
    PublishOutcome,
    QoS,
    SubscribeOutcome,
    SubscribeStatus,
    TransportListener,
)
from fleet_agent.protocol.topics import ack_topic, command_topic, events_topic

Deny = Literal["NOT_AUTHORIZED", "REFUSED", "DISCONNECT_135", "SILENT"]
"""How a topic outside the policy is answered: a refusal, a refusal code, a 135 disconnection, or
no answer at all."""

_NOT_AUTHORIZED_CODE = 0x87
_REFUSED_CODE = 0x80
_DISCONNECT_NOT_AUTHORIZED = 135


def own_publish_topics(site_id: str, robot_id: str) -> frozenset[str]:
    """Lists the topics a robot may publish on: its own events and its own acknowledgements.

    Args:
        site_id: The robot's site.
        robot_id: The robot.

    Returns:
        The publish topics of the correct policy.
    """
    return frozenset({events_topic(site_id, robot_id), ack_topic(site_id, robot_id)})


def own_subscribe_filters(site_id: str, robot_id: str) -> frozenset[str]:
    """Lists the filters a robot may subscribe to: its own command topic only.

    Args:
        site_id: The robot's site.
        robot_id: The robot.

    Returns:
        The subscribe filters of the correct policy.
    """
    return frozenset({command_topic(site_id, robot_id)})


class PolicyTransport:
    """A transport whose publishes and subscribes are allowed on fixed sets of topics.

    Attributes:
        published: The topic of every publish, in order.
        subscribed: The filter of every subscribe, in order.
        started: How many times the transport was started.
        stops: How many times the transport was stopped.
    """

    def __init__(
        self,
        *,
        allowed_topics: frozenset[str],
        allowed_filters: frozenset[str] | None = None,
        deny: Deny = "NOT_AUTHORIZED",
        refuse_connect: bool = False,
        silent_connect: bool = False,
        drop_on_connect: bool = False,
    ) -> None:
        """Creates a transport with its policy.

        Args:
            allowed_topics: The topics a publish is granted on.
            allowed_filters: The filters a subscribe is granted on. Defaults to `allowed_topics`.
            deny: How every other topic is answered.
            refuse_connect: Whether every connection attempt fails with NOT_AUTHORIZED.
            silent_connect: Whether every connection attempt never completes.
            drop_on_connect: Whether an accepted connection is dropped with reason 135 at once,
                before any action can be sent.
        """
        self._allowed = allowed_topics
        self._allowed_filters = allowed_topics if allowed_filters is None else allowed_filters
        self._deny = deny
        self._refuse_connect = refuse_connect
        self._silent_connect = silent_connect
        self._drop_on_connect = drop_on_connect
        self._listener: TransportListener | None = None
        self.published: list[str] = []
        self.subscribed: list[str] = []
        self.started = 0
        self.stops = 0

    def set_listener(self, listener: TransportListener) -> None:
        """Registers the listener.

        Args:
            listener: The listener, which receives the connection events.
        """
        self._listener = listener

    def start(self) -> None:
        """Connects, or fails to, on the next loop iteration.

        Raises:
            AssertionError: If no listener was set, which would hide the events.
        """
        if self._listener is None:
            raise AssertionError("no listener")
        self.started += 1
        listener = self._listener
        loop = asyncio.get_running_loop()
        if self._silent_connect:
            return
        if self._refuse_connect:
            loop.call_soon(listener.on_connect_failed, None, _NOT_AUTHORIZED_CODE)
            return
        loop.call_soon(listener.on_connected)
        if self._drop_on_connect:
            loop.call_soon(listener.on_disconnected, None, _DISCONNECT_NOT_AUTHORIZED)

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Answers a publish according to the policy.

        Args:
            topic: The topic published on.
            payload: Unused.
            qos: Unused.
            on_done: The completion callback, which the policy answers.
        """
        del payload, qos
        self.published.append(topic)
        if topic in self._allowed:
            self._answer_publish(on_done, PublishOutcome("OK"))
        elif self._deny == "DISCONNECT_135":
            self._disconnect_135()
        elif self._deny == "SILENT":
            return
        elif self._deny == "REFUSED":
            self._answer_publish(on_done, PublishOutcome("REFUSED", reason_code=_REFUSED_CODE))
        else:
            self._answer_publish(
                on_done,
                PublishOutcome("NOT_AUTHORIZED", reason_code=_NOT_AUTHORIZED_CODE),
            )

    def subscribe(self, topic_filter: str, on_done: Callable[[SubscribeOutcome], None]) -> None:
        """Answers a subscribe according to the policy.

        Args:
            topic_filter: The filter subscribed to.
            on_done: The completion callback, which the policy answers.
        """
        self.subscribed.append(topic_filter)
        if topic_filter in self._allowed_filters:
            status: SubscribeStatus = "GRANTED"
        elif self._deny == "DISCONNECT_135":
            self._disconnect_135()
            return
        elif self._deny == "SILENT":
            return
        elif self._deny == "REFUSED":
            status = "REFUSED"
        else:
            status = "NOT_AUTHORIZED"
        asyncio.get_running_loop().call_soon(on_done, SubscribeOutcome(status))

    def suspend(self, duration_ms: int) -> None:
        """Unused by the probe. Present because the port requires it.

        Args:
            duration_ms: Unused.
        """
        del duration_ms

    async def stop(self, timeout_s: float) -> None:
        """Counts the stop. There is no broker to disconnect from.

        Args:
            timeout_s: Unused.
        """
        del timeout_s
        self.stops += 1

    def _answer_publish(
        self,
        on_done: Callable[[PublishOutcome], None] | None,
        outcome: PublishOutcome,
    ) -> None:
        """Delivers a publish outcome on the next loop iteration, when the caller asked for one.

        Args:
            on_done: The completion callback, or None.
            outcome: The outcome to deliver.
        """
        if on_done is not None:
            asyncio.get_running_loop().call_soon(on_done, outcome)

    def _disconnect_135(self) -> None:
        """Drops the connection with reason 135, which the broker sends on a refusal."""
        if self._listener is None:
            raise AssertionError("no listener")
        asyncio.get_running_loop().call_soon(
            self._listener.on_disconnected,
            None,
            _DISCONNECT_NOT_AUTHORIZED,
        )
