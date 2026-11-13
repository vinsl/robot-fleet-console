"""Link: subscribe and its retry, what is published while disconnected, the queue cap and the logs.

The reconnection itself is the transport's job; these tests cover what the core does around it.
"""

from __future__ import annotations

import logging

from _pytest.logging import LogCaptureFixture

from fleet_agent.core.ports import PublishOutcome, SubscribeOutcome

from .fakes import (
    COMMAND_TOPIC,
    OPERATOR_SUB,
    body_of,
    deliver,
    field_of,
    labels,
    make_core,
)


def test_on_connected_subscribes_to_the_command_topic_and_asks_for_telemetry() -> None:
    """Given a connection, the core subscribes to its command topic and sends telemetry at once."""
    core, _, transport, _ = make_core()

    core.on_connected()
    core.tick()

    assert transport.subscriptions == [COMMAND_TOPIC]
    assert labels(transport)[-1] == "TELEMETRY"


def test_a_refused_suback_is_retried_after_the_backoff_with_the_injected_draw() -> None:
    """Given a refused SUBACK, the retry waits half the first window (draw 0.5), then doubles it."""
    core, clock, transport, _ = make_core(rand=lambda: 0.5)
    core.on_connected()
    transport.complete_subscribe(SubscribeOutcome(status="REFUSED", reason_code=135))

    clock.advance(499)
    core.tick()
    assert len(transport.subscriptions) == 1
    clock.advance(1)
    core.tick()
    assert len(transport.subscriptions) == 2

    transport.complete_subscribe(SubscribeOutcome(status="REFUSED", reason_code=135))
    clock.advance(999)
    core.tick()
    assert len(transport.subscriptions) == 2
    clock.advance(1)
    core.tick()
    assert len(transport.subscriptions) == 3


def test_a_granted_suback_is_logged_and_nothing_is_retried(caplog: LogCaptureFixture) -> None:
    """Given a granted SUBACK, the link is logged as subscribed and no retry follows."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, _ = make_core()
    core.on_connected()

    transport.complete_subscribe(SubscribeOutcome(status="GRANTED", reason_code=1))
    clock.advance(10000)
    core.tick()

    assert len(transport.subscriptions) == 1
    assert any(r.getMessage() == "link.subscribed" for r in caplog.records)


def test_a_refused_subscribe_is_logged_at_error_with_its_attempt_and_delay(
    caplog: LogCaptureFixture,
) -> None:
    """Given a refused SUBACK, the refusal line carries the outcome, the attempt and the delay."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _, transport, _ = make_core(rand=lambda: 0.5)
    core.on_connected()

    transport.complete_subscribe(SubscribeOutcome(status="NOT_AUTHORIZED", reason_code=135))

    refused = [r for r in caplog.records if r.getMessage() == "link.subscribe_refused"]
    assert refused[-1].levelname == "ERROR"
    assert field_of(refused[-1], "outcome") == "NOT_AUTHORIZED"
    assert field_of(refused[-1], "attempt") == 0
    assert field_of(refused[-1], "delayMs") == 500


def test_a_new_connection_cancels_a_pending_subscribe_retry() -> None:
    """Given a retry is pending, a fresh connection subscribes at once and drops the retry."""
    core, clock, transport, _ = make_core(rand=lambda: 0.5)
    core.on_connected()
    transport.complete_subscribe(SubscribeOutcome(status="REFUSED", reason_code=135))
    core.on_disconnected("ConnectionError", None)

    core.on_connected()
    assert len(transport.subscriptions) == 2
    clock.advance(10000)
    core.tick()

    assert len(transport.subscriptions) == 2


def test_telemetry_is_not_published_while_disconnected_but_events_still_are() -> None:
    """Given the link is down, telemetry is skipped, while a fault event is still handed over."""
    core, clock, transport, _ = make_core(simulated=True)
    core.on_connected()
    core.on_disconnected("ConnectionError", None)
    before = len(transport.published)

    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "BATTERY_LOW"})
    clock.advance(50)
    core.tick()

    assert labels(transport)[before:] == ["ACK", "FAULT_RAISED", "STATE_CHANGED"]
    assert "TELEMETRY" not in labels(transport)[before:]


def test_the_pending_qos1_cap_drops_the_next_event_and_reports_outbox_full(
    caplog: LogCaptureFixture,
) -> None:
    """Given 100 QoS 1 messages await their PUBACK, the next one is dropped and reported once."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, clock, transport, _ = make_core()
    for _ in range(99):
        deliver(transport, clock, "PAUSE")
    assert len(transport.published) == 100

    deliver(transport, clock, "PAUSE")

    assert len(transport.published) == 100
    full = [r for r in caplog.records if r.getMessage() == "outbox.full"]
    assert full[-1].levelname == "ERROR"
    assert field_of(full[-1], "pending") == 100


def test_an_estop_is_acknowledged_and_announced_while_the_qos1_queue_is_full() -> None:
    """Given 100 QoS 1 messages await their PUBACK, an e-stop is still acknowledged and announced.

    The stop is the one thing the console must learn of, so its acknowledgement and its state
    change are priority: they may use the headroom that an ordinary message may not.
    """
    _, clock, transport, _ = make_core()
    for _ in range(99):
        deliver(transport, clock, "PAUSE")
    deliver(transport, clock, "PAUSE")
    before = len(transport.published)
    assert before == 100

    estop = deliver(transport, clock, "ESTOP")

    assert labels(transport)[before:] == ["ACK", "STATE_CHANGED"]
    ack = body_of(transport, before)
    assert ack["result"] == "ACK"
    assert ack["commandId"] == estop["commandId"]


def test_a_completed_publish_frees_its_slot_under_the_cap() -> None:
    """Given the cap is reached, one PUBACK frees a slot and the next message is published."""
    _, clock, transport, _ = make_core()
    for _ in range(99):
        deliver(transport, clock, "PAUSE")
    deliver(transport, clock, "PAUSE")
    assert len(transport.published) == 100

    transport.complete_publish(0, PublishOutcome(status="OK"))
    deliver(transport, clock, "PAUSE")

    assert len(transport.published) == 101


def test_fault_cleared_for_link_loss_is_published_on_reconnect() -> None:
    """Given a simulated link loss that has been acknowledged, reconnecting clears the fault."""
    core, clock, transport, _ = make_core(simulated=True)
    core.on_connected()
    deliver(transport, clock, "SIMULATE_FAULT", params={"fault": "LINK_LOSS"})
    transport.complete_publish(labels(transport).index("ACK"), PublishOutcome(status="OK"))
    core.on_disconnected("ConnectionError", None)

    core.on_connected()

    assert labels(transport)[-1] == "FAULT_CLEARED"
    assert body_of(transport, len(transport.published) - 1)["fault"] == "LINK_LOSS"


def test_repeated_connect_failures_are_logged_once_per_interval(caplog: LogCaptureFixture) -> None:
    """Given a revoked certificate retrying fast, one line per second is written, with the count."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, _, _ = make_core()

    for _ in range(5):
        core.on_connect_failed("ConnectionError", 134)
    clock.advance(1000)
    core.on_connect_failed("ConnectionError", 134)

    failures = [r for r in caplog.records if r.getMessage() == "link.connect_failed"]
    assert len(failures) == 2
    assert field_of(failures[-1], "suppressed") == 4


def test_a_disconnect_is_logged_with_the_error_and_the_reason(caplog: LogCaptureFixture) -> None:
    """Given a lost link, the line names the error and the broker's reason code."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, _, _, _ = make_core()

    core.on_disconnected("ConnectionError", 135)

    lost = [r for r in caplog.records if r.getMessage() == "link.lost"]
    assert lost[-1].levelname == "WARNING"
    assert field_of(lost[-1], "errorName") == "ConnectionError"
    assert field_of(lost[-1], "reasonCode") == 135


def test_a_refused_publish_is_logged_and_not_retried(caplog: LogCaptureFixture) -> None:
    """Given the broker refused a publish, the core logs it and does not send it again."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, _, transport, _ = make_core()
    count = len(transport.published)

    transport.complete_publish(0, PublishOutcome(status="NOT_AUTHORIZED", reason_code=135))

    assert len(transport.published) == count
    failed = [r for r in caplog.records if r.getMessage() == "publish.failed"]
    assert field_of(failed[-1], "label") == "BOOT"
    assert field_of(failed[-1], "outcome") == "NOT_AUTHORIZED"
    assert field_of(failed[-1], "reasonCode") == 135


def test_refused_command_logs_never_carry_the_operator_subject_or_token(
    caplog: LogCaptureFixture,
) -> None:
    """Given a command refused for its lock, neither subject nor token reaches a log line."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    _, clock, transport, _ = make_core()
    deliver(transport, clock, "PAUSE", lockToken="wrong-token-0123456789ab")

    text = " ".join(r.getMessage() + str(vars(r)) for r in caplog.records)
    assert OPERATOR_SUB not in text
    assert "wrong-token" not in text


def test_a_failed_telemetry_is_logged_and_releases_no_queue_slot(caplog: LogCaptureFixture) -> None:
    """Given a telemetry (QoS 0) fails, it is logged, and the QoS 1 queue count is unchanged."""
    caplog.set_level(logging.DEBUG, logger="fleet_agent.core")
    core, clock, transport, _ = make_core()
    core.on_connected()
    core.tick()
    telemetry_index = labels(transport).index("TELEMETRY")
    transport.complete_publish(
        telemetry_index, PublishOutcome(status="FAILED", error_name="OSError")
    )

    failed = [r for r in caplog.records if r.getMessage() == "publish.failed"]
    assert field_of(failed[-1], "label") == "TELEMETRY"
    assert field_of(failed[-1], "errorName") == "OSError"

    for _ in range(99):
        deliver(transport, clock, "PAUSE")
    count = len(transport.published)
    deliver(transport, clock, "PAUSE")
    assert len(transport.published) == count
    assert any(r.getMessage() == "outbox.full" for r in caplog.records)
