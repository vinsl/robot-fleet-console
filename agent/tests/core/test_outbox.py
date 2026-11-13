"""The outbox: the QoS 1 cap, the release of a slot after a transport error, and the outcomes."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from fleet_agent.core.constants import MAX_PENDING_QOS1, PRIORITY_QOS1_HEADROOM
from fleet_agent.core.corelog import CoreLog
from fleet_agent.core.ids import uuid7
from fleet_agent.core.messages import MessageFactory
from fleet_agent.core.outbox import Outbox
from fleet_agent.core.ports import PublishOutcome, QoS
from fleet_agent.core.scheduler import TelemetryScheduler
from fleet_agent.core.throttle import LogThrottle

from .fakes import ROBOT_ID, SITE_ID, FakeClock, FakeTransport


class LinkDownTransport(FakeTransport):
    """A transport whose publish raises while the link is down, as a closed socket would."""

    def __init__(self) -> None:
        """Creates a transport whose link is down."""
        super().__init__()
        self.down = True

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Raises while the link is down, and records the publish otherwise.

        Args:
            topic: The topic published on.
            payload: The serialised message.
            qos: The requested quality of service.
            on_done: The completion callback, if the core gave one.

        Raises:
            RuntimeError: While the link is down.
        """
        if self.down:
            raise RuntimeError("the link is down")
        super().publish(topic, payload, qos, on_done)


def _outbox(transport: FakeTransport) -> Outbox:
    """Builds an outbox over a transport, with a fresh factory, scheduler and log.

    Args:
        transport: The transport the outbox publishes through.

    Returns:
        The outbox, which is not connected.
    """
    clock = FakeClock()
    boot_id = uuid7()
    factory = MessageFactory(
        robot_id=ROBOT_ID,
        site_id=SITE_ID,
        boot_id=boot_id,
        clock=clock,
        new_id=uuid7,
    )
    log = CoreLog(robot_id=ROBOT_ID, site_id=SITE_ID, boot_id=boot_id, throttle=LogThrottle(clock))
    return Outbox(
        transport=transport,
        factory=factory,
        scheduler=TelemetryScheduler(simulated=False),
        log=log,
        clock=clock,
    )


def _send_ack(outbox: Outbox, *, priority: bool = False) -> bool:
    """Sends one acknowledgement, which is a QoS 1 message.

    Args:
        outbox: The outbox to send through.
        priority: Whether the acknowledgement is priority, as an e-stop's is.

    Returns:
        What the outbox reported: True when the message was handed to the transport.
    """
    factory = outbox.factory
    return outbox.send(
        "ACK",
        lambda: factory.ack(
            command_id=uuid7(),
            correlation_id="corr-0123456789",
            state="IDLE",
            result="ACK",
            reason=None,
        ),
        priority=priority,
    )


class ReportsThenRaisesTransport(FakeTransport):
    """A transport that reports a publish as done and then raises, as a buggy binding might."""

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Completes the publish at once, then raises.

        Args:
            topic: The topic published on.
            payload: The serialised message.
            qos: The requested quality of service.
            on_done: The completion callback, if the core gave one.

        Raises:
            RuntimeError: Always, after the completion callback ran.
        """
        if on_done is not None:
            on_done(PublishOutcome(status="OK"))
        raise RuntimeError("link closed")


def test_a_publish_reported_then_raised_cannot_lift_the_cap() -> None:
    """Given a transport that reports and then raises, the count stays at zero, not below it."""
    outbox = _outbox(ReportsThenRaisesTransport())
    for _ in range(MAX_PENDING_QOS1 + 5):
        with pytest.raises(RuntimeError):
            _send_ack(outbox)
    transport = FakeTransport()
    outbox._transport = transport

    sent = [_send_ack(outbox) for _ in range(MAX_PENDING_QOS1 + 1)]

    assert sent.count(True) == MAX_PENDING_QOS1


def test_a_transport_error_releases_the_qos1_slot_it_took() -> None:
    """Given a link that raises for more messages than the cap, a later message still goes out."""
    transport = LinkDownTransport()
    outbox = _outbox(transport)
    for _ in range(MAX_PENDING_QOS1 + 1):
        with pytest.raises(RuntimeError):
            _send_ack(outbox)
    transport.down = False

    sent = [_send_ack(outbox) for _ in range(MAX_PENDING_QOS1)]

    assert all(sent)
    assert len(transport.published) == MAX_PENDING_QOS1


def test_the_cap_refuses_the_next_qos1_message_until_one_completes() -> None:
    """Given a full set of unacknowledged QoS 1 messages, the next is refused until one ends."""
    transport = FakeTransport()
    outbox = _outbox(transport)
    for _ in range(MAX_PENDING_QOS1):
        assert _send_ack(outbox) is True

    assert _send_ack(outbox) is False
    assert len(transport.published) == MAX_PENDING_QOS1

    transport.complete_publish(0, PublishOutcome(status="OK"))

    assert _send_ack(outbox) is True


def test_a_synchronous_completion_cannot_leave_the_count_negative_or_stuck() -> None:
    """Given a transport that completes at once, the slot is taken and released in the same call."""

    class Synchronous(FakeTransport):
        """A transport that calls the completion callback before `publish` returns."""

        def publish(
            self,
            topic: str,
            payload: bytes,
            qos: QoS,
            on_done: Callable[[PublishOutcome], None] | None = None,
        ) -> None:
            """Records the publish and completes it at once.

            Args:
                topic: The topic published on.
                payload: The serialised message.
                qos: The requested quality of service.
                on_done: The completion callback, if the core gave one.
            """
            super().publish(topic, payload, qos, on_done)
            if on_done is not None:
                on_done(PublishOutcome(status="OK"))

    outbox = _outbox(Synchronous())

    sent = [_send_ack(outbox) for _ in range(MAX_PENDING_QOS1 + 1)]

    assert all(sent)


def test_a_priority_message_takes_only_the_headroom_beyond_the_cap() -> None:
    """Given the cap is reached, a priority message takes the headroom, and never more than that."""
    transport = FakeTransport()
    outbox = _outbox(transport)
    for _ in range(MAX_PENDING_QOS1):
        assert _send_ack(outbox) is True
    assert _send_ack(outbox) is False

    for _ in range(PRIORITY_QOS1_HEADROOM):
        assert _send_ack(outbox, priority=True) is True
    assert _send_ack(outbox, priority=True) is False

    assert len(transport.published) == MAX_PENDING_QOS1 + PRIORITY_QOS1_HEADROOM


def test_a_publish_reported_twice_cannot_lift_the_cap() -> None:
    """Given a transport that reports one publish twice, the count stays at zero, not below it.

    A negative count would let one message more than the cap through, and it would stay there.
    """
    transport = FakeTransport()
    outbox = _outbox(transport)
    assert _send_ack(outbox) is True
    transport.complete_publish(0, PublishOutcome(status="OK"))
    transport.complete_publish(0, PublishOutcome(status="OK"))

    sent = [_send_ack(outbox) for _ in range(MAX_PENDING_QOS1)]

    assert all(sent)
    assert _send_ack(outbox) is False
