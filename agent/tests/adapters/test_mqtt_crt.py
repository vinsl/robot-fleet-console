"""Tests of the CRT transport against a fake client: options, outcomes, threads and exactly-once.

No test opens a connection. The fake client records what the transport sends and lets the test
complete each operation, so every ordering that matters is decided by the test.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace

import pytest
from awscrt import mqtt5
from awscrt.exceptions import AwsCrtError

from fleet_agent.adapters.mqtt_crt import (
    ClientStoppedError,
    CrtMqttTransport,
    MqttSettings,
    build_crt_transport,
    builder_kwargs,
    publish_outcome_of,
    subscribe_outcome_of,
)
from fleet_agent.config.kit_file import KitError, LoadedKit, TlsMaterial, load_kit
from fleet_agent.core.ports import PublishOutcome, SubscribeOutcome
from fleet_agent.protocol.robots import RobotKitConfig
from tests.protocol.conftest import FIXTURES_DIR, read_fixture

# Split so that secret scanners do not mistake a test marker for a key.
PEM_KEY_BEGIN = b"-----BEGIN " + b"PRIVATE KEY-----"
PEM_KEY_END = b"-----END " + b"PRIVATE KEY-----"

ENDPOINT = "a1b2c3d4e5f6g7-ats.iot.eu-west-3.amazonaws.com"
CLIENT_ID = "mfc-demo-kali-01"
TOPIC = "fleet/paris-01/kali-01/cmd"
_NOT_AUTHORIZED = 0x87
_QUOTA_EXCEEDED = 0x97
SECRET = "SECRET-PAYLOAD-7f3a"  # noqa: S105 - a fixed marker in a log leak check, not a credential
WAIT_S = 5.0
"""The longest a test waits for an event it expects. Generous, so a slow machine never fails it."""
_VALID_KIT = FIXTURES_DIR / "register-robot-response" / "valid" / "01.json"


class FakeClient:
    """A client that records calls and leaves every operation pending until the test completes it.

    Attributes:
        started: How many times `start` was called.
        stops: The disconnect packet of every `stop` call.
        published: The packet of every publish.
        subscribed: The packet of every subscribe.
        publish_futures: The future returned for each publish.
        subscribe_futures: The future returned for each subscribe.
        publish_error: When set, every publish raises it instead of returning a future.
        subscribe_error: When set, every subscribe raises it instead of returning a future.
        start_hook: When set, runs on every start, so a test can wait for a restart.
    """

    def __init__(self) -> None:
        """Creates a client with nothing recorded and no failure set."""
        self.started = 0
        self.start_hook: Callable[[], None] | None = None
        self.stops: list[object | None] = []
        self.published: list[mqtt5.PublishPacket] = []
        self.subscribed: list[mqtt5.SubscribePacket] = []
        self.publish_futures: list[Future[object]] = []
        self.subscribe_futures: list[Future[object]] = []
        self.publish_error: BaseException | None = None
        self.subscribe_error: BaseException | None = None

    def start(self) -> None:
        """Records a start, then runs the start hook when one is set."""
        self.started += 1
        if self.start_hook is not None:
            self.start_hook()

    def stop(self, disconnect_packet: object | None = None) -> None:
        """Records a stop and its disconnect packet.

        Args:
            disconnect_packet: The packet sent with the stop, or None.
        """
        self.stops.append(disconnect_packet)

    def publish(self, publish_packet: mqtt5.PublishPacket) -> Future[object]:
        """Records a publish and returns a future the test completes.

        Args:
            publish_packet: The packet to send.

        Returns:
            A pending future, unless a publish error is set.

        Raises:
            BaseException: The configured publish error, when one is set.
        """
        self.published.append(publish_packet)
        if self.publish_error is not None:
            raise self.publish_error
        future: Future[object] = Future()
        self.publish_futures.append(future)
        return future

    def subscribe(self, subscribe_packet: mqtt5.SubscribePacket) -> Future[object]:
        """Records a subscribe and returns a future the test completes.

        Args:
            subscribe_packet: The packet to send.

        Returns:
            A pending future, unless a subscribe error is set.

        Raises:
            BaseException: The configured subscribe error, when one is set.
        """
        self.subscribed.append(subscribe_packet)
        if self.subscribe_error is not None:
            raise self.subscribe_error
        future: Future[object] = Future()
        self.subscribe_futures.append(future)
        return future


class FakeFactory:
    """A client factory that records the keyword arguments it was called with.

    Attributes:
        client: The client it returns.
        kwargs: The keyword arguments of the last call.
    """

    def __init__(self, client: FakeClient) -> None:
        """Creates a factory that returns the given client.

        Args:
            client: The client to return.
        """
        self.client = client
        self.kwargs: dict[str, object] = {}

    def __call__(self, **kwargs: object) -> FakeClient:
        """Records the keyword arguments and returns the client.

        Args:
            **kwargs: The keyword arguments the transport passed.

        Returns:
            The fake client.
        """
        self.kwargs = kwargs
        return self.client


class RecordingListener:
    """A listener that records each event and the thread it arrived on.

    Attributes:
        events: The events in arrival order, as (name, value) pairs.
        threads: The thread identifier of each event.
    """

    def __init__(self) -> None:
        """Creates an empty recorder."""
        self.events: list[tuple[str, object]] = []
        self.threads: list[int] = []

    def on_connected(self) -> None:
        """Records a connection."""
        self._record("connected", None)

    def on_disconnected(self, error_name: str | None, reason_code: int | None) -> None:
        """Records a lost connection.

        Args:
            error_name: The local error class name, if any.
            reason_code: The reason code, if any.
        """
        self._record("disconnected", (error_name, reason_code))

    def on_connect_failed(self, error_name: str | None, reason_code: int | None) -> None:
        """Records a failed attempt.

        Args:
            error_name: The local error class name, if any.
            reason_code: The reason code, if any.
        """
        self._record("connect_failed", (error_name, reason_code))

    def on_message(self, topic: str, payload: bytes) -> None:
        """Records an inbound message.

        Args:
            topic: The topic.
            payload: The payload.
        """
        self._record("message", (topic, payload))

    def _record(self, name: str, value: object) -> None:
        """Stores one event with the thread it arrived on.

        Args:
            name: The event name.
            value: The event's value.
        """
        self.events.append((name, value))
        self.threads.append(threading.get_ident())


@pytest.fixture
def loop() -> Iterator[asyncio.AbstractEventLoop]:
    """Provides a fresh event loop, closed after the test.

    Yields:
        The loop.
    """
    created = asyncio.new_event_loop()
    yield created
    if not created.is_closed():
        created.close()


def _settings(port: int = 8883) -> MqttSettings:
    """Builds the settings of the robot used by the tests.

    Args:
        port: The broker port.

    Returns:
        The connection settings.
    """
    return MqttSettings(endpoint=ENDPOINT, port=port, client_id=CLIENT_ID)


def _tls() -> TlsMaterial:
    """Builds TLS material with placeholder bytes, which the fake client never reads.

    Returns:
        The material.
    """
    return TlsMaterial(
        certificate_pem=b"-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n",
        private_key_pem=(PEM_KEY_BEGIN + b"\nkey\n" + PEM_KEY_END + b"\n"),
        root_ca_pem=b"-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
    )


def _transport(
    loop: asyncio.AbstractEventLoop,
) -> tuple[CrtMqttTransport, FakeClient, FakeFactory, RecordingListener]:
    """Builds a transport over a fake client, with a recording listener already set.

    Args:
        loop: The loop the transport marshals onto.

    Returns:
        The transport, its client, its factory and its listener.
    """
    client = FakeClient()
    factory = FakeFactory(client)
    transport = CrtMqttTransport(_settings(), _tls(), loop, client_factory=factory)
    listener = RecordingListener()
    transport.set_listener(listener)
    return transport, client, factory, listener


def _drain(loop: asyncio.AbstractEventLoop) -> None:
    """Runs the loop until the callbacks queued from other threads have run.

    Args:
        loop: The loop to run.
    """
    for _ in range(3):
        loop.run_until_complete(asyncio.sleep(0))


def _settled(future: asyncio.Future[None]) -> None:
    """Completes a future, unless it already completed. Used as a hook that fires once.

    Args:
        future: The future to complete.
    """
    if not future.done():
        future.set_result(None)


def _failing(_outcome: PublishOutcome) -> None:
    """A publish callback that fails, as a buggy caller would.

    Args:
        _outcome: The outcome, unused.

    Raises:
        ValueError: Always, with a value that must never reach the logs.
    """
    raise ValueError(SECRET)


def _in_thread(function: Callable[[], None]) -> None:
    """Runs a function on another thread, as the SDK's callbacks run, and waits for it.

    Args:
        function: The function to run.
    """
    thread = threading.Thread(target=function)
    thread.start()
    thread.join()


def _puback(reason_code: int) -> SimpleNamespace:
    """Builds the completion data of a QoS 1 publish with the given PUBACK reason code.

    Args:
        reason_code: The PUBACK reason code.

    Returns:
        Completion data with a PUBACK.
    """
    return SimpleNamespace(puback=SimpleNamespace(reason_code=reason_code))


def _suback(reason_code: int) -> SimpleNamespace:
    """Builds a SUBACK with the given first reason code.

    Args:
        reason_code: The SUBACK reason code.

    Returns:
        A SUBACK.
    """
    return SimpleNamespace(reason_codes=[reason_code])


# Options of the SDK client


def test_builder_options_match_the_reviewed_profile() -> None:
    """The client uses a clean session, full jitter, the reconnection bounds and no metrics."""
    options = builder_kwargs(_settings())

    assert options["session_behavior"] == mqtt5.ClientSessionBehaviorType.CLEAN
    assert options["retry_jitter_mode"] == mqtt5.ExponentialBackoffJitterMode.FULL
    assert options["offline_queue_behavior"] == (
        mqtt5.ClientOperationQueueBehaviorType.FAIL_QOS0_PUBLISH_ON_DISCONNECT
    )
    assert options["min_reconnect_delay_ms"] == 1000
    assert options["max_reconnect_delay_ms"] == 30000
    assert options["min_connected_time_to_reset_reconnect_delay_ms"] == 30000
    assert options["enable_metrics_collection"] is False


def test_builder_connect_packet_has_no_will_no_session_expiry_and_a_packet_cap() -> None:
    """The CONNECT packet is bounded, keeps alive for 30 s, and carries no will or expiry."""
    options = builder_kwargs(_settings())
    connect = options["connect_options"]

    assert isinstance(connect, mqtt5.ConnectPacket)
    assert connect.keep_alive_interval_sec == 30
    assert connect.maximum_packet_size == 8192
    assert connect.client_id == CLIENT_ID
    assert connect.will is None
    assert connect.session_expiry_interval_sec is None


def test_builder_endpoint_port_and_client_id_come_from_the_settings() -> None:
    """The endpoint, the port and the client identifier are the settings' values."""
    options = builder_kwargs(_settings(port=443))

    assert options["endpoint"] == ENDPOINT
    assert options["port"] == 443
    assert options["client_id"] == CLIENT_ID


def test_the_client_is_built_with_the_thing_name_and_the_ca_bundle(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """The factory receives the TLS material, the CA and the thing name as the client identifier."""
    _, _, factory, _ = _transport(loop)

    assert factory.kwargs["client_id"] == CLIENT_ID
    assert factory.kwargs["ca_bytes"] == _tls().root_ca_pem
    assert factory.kwargs["cert_bytes"] == _tls().certificate_pem
    assert factory.kwargs["pri_key_bytes"] == _tls().private_key_pem


# Outcome mapping


@pytest.mark.parametrize(
    ("reason_code", "status"),
    [(0, "OK"), (16, "OK"), (_NOT_AUTHORIZED, "NOT_AUTHORIZED"), (_QUOTA_EXCEEDED, "REFUSED")],
)
def test_publish_maps_the_puback_reason_code(reason_code: int, status: str) -> None:
    """Reason codes 0 and 16 publish, 0x87 is denied, and any other code is refused as itself."""
    outcome = publish_outcome_of(_puback(reason_code), None)

    assert outcome.status == status
    assert outcome.reason_code == reason_code


def test_a_qos0_publish_with_an_empty_puback_counts_as_published() -> None:
    """Given the SDK's QoS 0 completion, an empty PUBACK with no reason code is a success.

    The real SDK never leaves `puback` unset: it hands over a packet whose reason code is None.
    """
    result = mqtt5.PublishCompletionData(puback=mqtt5.PubackPacket())

    outcome = publish_outcome_of(result, None)

    assert outcome.status == "OK"


def test_a_qos0_publish_without_a_puback_counts_as_published() -> None:
    """A QoS 0 publish has no PUBACK, so it is OK."""
    outcome = publish_outcome_of(SimpleNamespace(puback=None), None)

    assert outcome == PublishOutcome("OK")


def test_a_publish_exception_is_failed_with_its_error_name_and_no_message() -> None:
    """A local failure reports the SDK's error name, never the message that may quote data."""
    error = AwsCrtError(code=1, name="AWS_ERROR_MQTT_TIMEOUT", message="secret detail")

    outcome = publish_outcome_of(None, error)

    assert outcome == PublishOutcome("FAILED", error_name="AWS_ERROR_MQTT_TIMEOUT")
    assert "secret" not in repr(outcome)


def test_a_publish_without_result_or_error_is_failed() -> None:
    """Neither a result nor an error means nothing completed, so the publish is not claimed OK."""
    assert publish_outcome_of(None, None) == PublishOutcome("FAILED")


@pytest.mark.parametrize(
    ("reason_code", "status"),
    [(0, "GRANTED"), (1, "GRANTED"), (_NOT_AUTHORIZED, "NOT_AUTHORIZED"), (128, "REFUSED")],
)
def test_subscribe_maps_the_first_suback_reason_code(reason_code: int, status: str) -> None:
    """Codes 0 and 1 are granted, 0x87 is denied, and any other code is refused."""
    outcome = subscribe_outcome_of(_suback(reason_code), None)

    assert outcome.status == status
    assert outcome.reason_code == reason_code


def test_a_suback_without_codes_is_refused() -> None:
    """A SUBACK that carries no code grants nothing."""
    outcome = subscribe_outcome_of(SimpleNamespace(reason_codes=[]), None)

    assert outcome == SubscribeOutcome("REFUSED")


def test_a_subscribe_without_result_or_error_is_failed() -> None:
    """A subscribe that completed with nothing is not claimed granted."""
    assert subscribe_outcome_of(None, None) == SubscribeOutcome("FAILED")


def test_a_subscribe_exception_is_failed() -> None:
    """A subscribe that failed locally is FAILED with the error name."""
    outcome = subscribe_outcome_of(None, OSError("socket"))

    assert outcome == SubscribeOutcome("FAILED", error_name="OSError")


# Publish: exactly one outcome, copies, QoS


def test_publish_reports_its_completion_once(loop: asyncio.AbstractEventLoop) -> None:
    """A completed publish is reported on the loop once, with its mapped outcome."""
    transport, client, _, _ = _transport(loop)
    outcomes: list[PublishOutcome] = []

    transport.publish("fleet/p/r/telemetry", b"{}", 0, outcomes.append)
    client.publish_futures[0].set_result(SimpleNamespace(puback=None))
    _drain(loop)

    assert outcomes == [PublishOutcome("OK")]


def test_a_completed_publish_is_not_reported_again_when_the_client_stops(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A publish already reported is not reported a second time when the client later stops."""
    transport, client, _, _ = _transport(loop)
    outcomes: list[PublishOutcome] = []
    transport.publish("t", b"x", 1, outcomes.append)
    client.publish_futures[0].set_result(_puback(0))
    _drain(loop)

    loop.run_until_complete(transport.stop(0.01))

    assert len(outcomes) == 1


def test_a_synchronous_publish_failure_is_reported_once_and_not_raised(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A client that raises on publish gives one FAILED outcome, and the call itself returns."""
    transport, client, _, _ = _transport(loop)
    client.publish_error = OSError("closed socket")
    outcomes: list[PublishOutcome] = []

    transport.publish("t", b"x", 1, outcomes.append)
    _drain(loop)

    assert outcomes == [PublishOutcome("FAILED", error_name="OSError")]


def test_a_pending_publish_is_failed_once_when_the_client_stops(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A publish pending at the stop is reported failed, and a late completion adds nothing."""
    transport, client, _, _ = _transport(loop)
    outcomes: list[PublishOutcome] = []
    transport.publish("t", b"x", 1, outcomes.append)

    loop.run_until_complete(transport.stop(0.01))
    client.publish_futures[0].set_result(_puback(0))
    _drain(loop)

    assert outcomes == [PublishOutcome("FAILED", error_name=ClientStoppedError.__name__)]


def test_a_publish_without_a_callback_is_still_sent(loop: asyncio.AbstractEventLoop) -> None:
    """A fire-and-forget publish reaches the client, and nothing is reported for it."""
    transport, client, _, _ = _transport(loop)

    transport.publish("t", b"x", 0)

    assert len(client.published) == 1


def test_the_payload_is_copied_before_it_is_sent(loop: asyncio.AbstractEventLoop) -> None:
    """A buffer the caller reuses after the call does not change the packet already built."""
    transport, client, _, _ = _transport(loop)
    buffer = bytearray(b"abc")

    transport.publish("t", bytes(buffer), 1)
    buffer[0] = ord("z")

    assert client.published[0].payload == b"abc"


def test_qos_maps_to_the_sdk_levels(loop: asyncio.AbstractEventLoop) -> None:
    """QoS 0 maps to at-most-once and QoS 1 to at-least-once."""
    transport, client, _, _ = _transport(loop)

    transport.publish("t", b"a", 0)
    transport.publish("t", b"b", 1)

    assert client.published[0].qos == mqtt5.QoS.AT_MOST_ONCE
    assert client.published[1].qos == mqtt5.QoS.AT_LEAST_ONCE


# Subscribe


def test_subscribe_asks_for_qos1_and_reports_the_suback_once(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A subscribe requests QoS 1 for its filter and reports the granted outcome once."""
    transport, client, _, _ = _transport(loop)
    outcomes: list[SubscribeOutcome] = []

    transport.subscribe(TOPIC, outcomes.append)
    client.subscribe_futures[0].set_result(_suback(1))
    _drain(loop)

    subscription = client.subscribed[0].subscriptions[0]
    assert subscription.topic_filter == TOPIC
    assert subscription.qos == mqtt5.QoS.AT_LEAST_ONCE
    assert outcomes == [SubscribeOutcome("GRANTED", reason_code=1)]


def test_a_pending_subscribe_is_failed_once_when_the_client_stops(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A subscribe pending at the stop is reported failed, and never again."""
    transport, client, _, _ = _transport(loop)
    outcomes: list[SubscribeOutcome] = []
    transport.subscribe(TOPIC, outcomes.append)

    loop.run_until_complete(transport.stop(0.01))
    client.subscribe_futures[0].set_result(_suback(1))
    _drain(loop)

    assert outcomes == [SubscribeOutcome("FAILED", error_name=ClientStoppedError.__name__)]


def test_a_synchronous_subscribe_failure_is_reported_once(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A client that raises on subscribe gives one FAILED outcome."""
    transport, client, _, _ = _transport(loop)
    client.subscribe_error = OSError("refused")
    outcomes: list[SubscribeOutcome] = []

    transport.subscribe(TOPIC, outcomes.append)
    _drain(loop)

    assert outcomes == [SubscribeOutcome("FAILED", error_name="OSError")]


# Threads and the loop


def test_a_callback_from_another_thread_reaches_the_listener_on_the_loop_thread(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """The SDK's connection event runs on its own thread, but the listener runs on the loop."""
    _, _, factory, listener = _transport(loop)
    callback = factory.kwargs["on_lifecycle_connection_success"]
    assert callable(callback)

    _in_thread(lambda: callback(SimpleNamespace()))
    _drain(loop)

    assert listener.events == [("connected", None)]
    assert listener.threads == [threading.get_ident()]


def test_an_inbound_message_is_copied_and_delivered_on_the_loop_thread(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """An inbound message is copied on the SDK thread and delivered to the listener on the loop."""
    _, _, factory, listener = _transport(loop)
    on_publish = factory.kwargs["on_publish_received"]
    assert callable(on_publish)
    payload = bytearray(b'{"type":"PAUSE"}')
    packet = mqtt5.PublishPacket(topic=TOPIC, payload=bytes(payload))

    _in_thread(lambda: on_publish(SimpleNamespace(publish_packet=packet)))
    payload[0] = ord("x")
    _drain(loop)

    assert listener.events == [("message", (TOPIC, b'{"type":"PAUSE"}'))]
    assert listener.threads == [threading.get_ident()]


def test_a_callback_after_the_loop_closed_does_not_raise(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """An SDK callback that arrives after the loop closed is dropped without raising."""
    _, _, factory, _ = _transport(loop)
    callback = factory.kwargs["on_lifecycle_connection_success"]
    assert callable(callback)
    loop.close()

    _in_thread(lambda: callback(SimpleNamespace()))


def test_a_connect_failure_reports_the_connack_code_and_the_error_name(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A refused CONNACK gives its reason code, and an exception gives its SDK error name."""
    _, _, factory, listener = _transport(loop)
    on_failure = factory.kwargs["on_lifecycle_connection_failure"]
    assert callable(on_failure)
    error = AwsCrtError(code=2, name="AWS_ERROR_MQTT_CONNACK_TIMEOUT", message="x")

    on_failure(
        SimpleNamespace(connack_packet=SimpleNamespace(reason_code=_NOT_AUTHORIZED), exception=None)
    )
    on_failure(SimpleNamespace(connack_packet=None, exception=error))
    _drain(loop)

    assert listener.events == [
        ("connect_failed", (None, _NOT_AUTHORIZED)),
        ("connect_failed", ("AWS_ERROR_MQTT_CONNACK_TIMEOUT", None)),
    ]


def test_a_disconnect_reports_the_broker_reason_code(loop: asyncio.AbstractEventLoop) -> None:
    """A DISCONNECT from the broker carries its reason code to the listener."""
    _, _, factory, listener = _transport(loop)
    on_disconnection = factory.kwargs["on_lifecycle_disconnection"]
    assert callable(on_disconnection)

    on_disconnection(
        SimpleNamespace(
            disconnect_packet=mqtt5.DisconnectPacket(reason_code=_NOT_AUTHORIZED),
            exception=None,
        )
    )
    _drain(loop)

    assert listener.events == [("disconnected", (None, _NOT_AUTHORIZED))]


def test_start_connects_once_a_listener_is_set(loop: asyncio.AbstractEventLoop) -> None:
    """With a listener set, starting hands the connection to the SDK client."""
    transport, client, _, _ = _transport(loop)

    transport.start()

    assert client.started == 1


def test_a_failed_publish_future_is_failed_with_its_error_name(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A publish whose future fails reports FAILED with the exception's class name."""
    transport, client, _, _ = _transport(loop)
    outcomes: list[PublishOutcome] = []
    transport.publish("t", b"x", 1, outcomes.append)

    client.publish_futures[0].set_exception(OSError("socket"))
    _drain(loop)

    assert outcomes == [PublishOutcome("FAILED", error_name="OSError")]


def test_a_cancelled_publish_future_is_failed(loop: asyncio.AbstractEventLoop) -> None:
    """A publish whose future is cancelled reports FAILED, never a success."""
    transport, client, _, _ = _transport(loop)
    outcomes: list[PublishOutcome] = []
    transport.publish("t", b"x", 1, outcomes.append)

    assert client.publish_futures[0].cancel()
    _drain(loop)

    assert outcomes == [PublishOutcome("FAILED", error_name="CancelledError")]


def test_start_refuses_to_run_without_a_listener(loop: asyncio.AbstractEventLoop) -> None:
    """Starting before a listener is set would lose every event, so it is refused."""
    client = FakeClient()
    transport = CrtMqttTransport(_settings(), _tls(), loop, client_factory=FakeFactory(client))

    with pytest.raises(RuntimeError, match="listener"):
        transport.start()

    assert client.started == 0


# Stop and suspend


def test_stop_sends_a_normal_disconnection(loop: asyncio.AbstractEventLoop) -> None:
    """The stop sends a DISCONNECT with the normal disconnection reason."""
    transport, client, _, _ = _transport(loop)

    loop.run_until_complete(transport.stop(0.01))

    packet = client.stops[0]
    assert isinstance(packet, mqtt5.DisconnectPacket)
    assert packet.reason_code == mqtt5.DisconnectReasonCode.NORMAL_DISCONNECTION


def test_stop_returns_when_the_client_confirms_the_stop(loop: asyncio.AbstractEventLoop) -> None:
    """A stopped event from the client ends the wait before the timeout."""
    transport, _, factory, _ = _transport(loop)
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)

    loop.call_later(0.005, lambda: _in_thread(lambda: on_stopped(SimpleNamespace())))
    loop.run_until_complete(transport.stop(5.0))


def test_stop_times_out_with_a_warning_and_returns(
    loop: asyncio.AbstractEventLoop,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A stop the client never confirms returns after the timeout and logs a warning."""
    transport, _, _, _ = _transport(loop)
    transport.start()

    with caplog.at_level(logging.WARNING, logger="fleet_agent.adapters.mqtt_crt"):
        loop.run_until_complete(transport.stop(0.01))

    assert [record.getMessage() for record in caplog.records] == ["link.stop_timeout"]


def test_stop_after_a_suspend_that_stopped_the_client_does_not_wait_or_warn(
    loop: asyncio.AbstractEventLoop,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A client a suspend already stopped is not stopped again, and the stop does not time out."""
    transport, client, factory, _ = _transport(loop)
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)
    transport.suspend(60_000)
    _in_thread(lambda: on_stopped(SimpleNamespace()))
    _drain(loop)
    stops_before = len(client.stops)

    with caplog.at_level(logging.WARNING, logger="fleet_agent.adapters.mqtt_crt"):
        loop.run_until_complete(asyncio.wait_for(transport.stop(30.0), timeout=1.0))

    assert len(client.stops) == stops_before
    assert caplog.records == []


def _after(loop: asyncio.AbstractEventLoop, seconds: float) -> asyncio.Future[None]:
    """Returns a future that completes after a delay, so a test can let the loop run that long.

    Args:
        loop: The loop the delay runs on.
        seconds: The delay, in seconds.

    Returns:
        The future that completes once the delay has passed.
    """
    marker: asyncio.Future[None] = loop.create_future()
    loop.call_later(seconds, _settled, marker)
    return marker


def test_a_restart_scheduled_before_a_shutdown_does_not_start_the_client(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A restart already scheduled when the shutdown begins never reconnects the robot."""
    transport, client, factory, _ = _transport(loop)
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)
    transport.suspend(10)
    _in_thread(lambda: on_stopped(SimpleNamespace()))
    _drain(loop)
    loop.run_until_complete(transport.stop(0.01))

    loop.run_until_complete(asyncio.wait_for(_after(loop, 0.05), timeout=WAIT_S))

    assert client.started == 0


def test_suspend_restarts_the_client_only_after_it_stopped(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A suspended link restarts once the client reports its stop and the delay has passed."""
    transport, client, factory, _ = _transport(loop)
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)
    restarted: asyncio.Future[None] = loop.create_future()
    client.start_hook = lambda: _settled(restarted)

    transport.suspend(20)
    _drain(loop)
    assert client.started == 0

    _in_thread(lambda: on_stopped(SimpleNamespace()))
    loop.run_until_complete(asyncio.wait_for(restarted, timeout=WAIT_S))

    assert len(client.stops) == 1
    assert client.started == 1


def test_a_suspend_while_the_client_is_stopped_restarts_it_without_another_stop(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A client already stopped gets its restart at once, and is not sent a second stop."""
    transport, client, factory, _ = _transport(loop)
    transport.start()
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)
    _in_thread(lambda: on_stopped(SimpleNamespace()))
    _drain(loop)
    stops_before = len(client.stops)
    restarted: asyncio.Future[None] = loop.create_future()
    client.start_hook = lambda: _settled(restarted)

    transport.suspend(10)
    loop.run_until_complete(asyncio.wait_for(restarted, timeout=WAIT_S))

    assert len(client.stops) == stops_before
    assert client.started == 2


def test_a_shorter_suspend_does_not_shorten_a_pending_restart(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Of two pending restarts, the later deadline wins: a short suspend cannot pull it forward."""
    transport, client, factory, _ = _transport(loop)
    transport.start()
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)
    _in_thread(lambda: on_stopped(SimpleNamespace()))
    _drain(loop)
    restarted: asyncio.Future[None] = loop.create_future()
    client.start_hook = lambda: _settled(restarted)

    transport.suspend(60_000)
    transport.suspend(10)
    loop.run_until_complete(asyncio.wait_for(_after(loop, 0.05), timeout=WAIT_S))

    assert client.started == 1


def test_stop_of_a_client_that_never_started_sends_the_disconnect_without_waiting(
    loop: asyncio.AbstractEventLoop,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A client that never connected is not waited for: the stop returns at once, no warning."""
    transport, client, _, _ = _transport(loop)

    with caplog.at_level(logging.WARNING, logger="fleet_agent.adapters.mqtt_crt"):
        loop.run_until_complete(asyncio.wait_for(transport.stop(30.0), timeout=1.0))

    assert len(client.stops) == 1
    assert caplog.records == []


def test_a_raising_callback_does_not_stop_the_other_pending_operations(
    loop: asyncio.AbstractEventLoop,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A callback that raises is logged by its error name only, and the others still get theirs."""
    transport, _, _, _ = _transport(loop)
    outcomes: list[PublishOutcome] = []
    transport.publish("t", b"x", 1, _failing)
    transport.publish("t", b"y", 1, outcomes.append)

    with caplog.at_level(logging.ERROR, logger="fleet_agent.adapters.mqtt_crt"):
        loop.run_until_complete(transport.stop(0.01))

    assert outcomes == [PublishOutcome("FAILED", error_name=ClientStoppedError.__name__)]
    failures = [r for r in caplog.records if r.getMessage() == "link.callback_failed"]
    assert [vars(r).get("errorName") for r in failures] == ["ValueError"]
    assert SECRET not in caplog.text


def test_a_raising_callback_during_the_client_stop_does_not_hold_the_stop(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A callback that raises during the fan-out cannot keep a waiting stop from returning."""
    transport, _, factory, _ = _transport(loop)
    transport.start()
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)
    transport.publish("t", b"x", 1, _failing)
    loop.call_later(0.005, lambda: _in_thread(lambda: on_stopped(SimpleNamespace())))

    loop.run_until_complete(asyncio.wait_for(transport.stop(30.0), timeout=WAIT_S))


def test_a_raising_callback_during_the_client_stop_does_not_prevent_a_restart(
    loop: asyncio.AbstractEventLoop,
) -> None:
    """A suspended link still restarts when a callback that raises is pending at the stop."""
    transport, client, factory, _ = _transport(loop)
    transport.start()
    on_stopped = factory.kwargs["on_lifecycle_stopped"]
    assert callable(on_stopped)
    restarted: asyncio.Future[None] = loop.create_future()
    client.start_hook = lambda: _settled(restarted)
    transport.publish("t", b"x", 1, _failing)
    transport.suspend(10)

    _in_thread(lambda: on_stopped(SimpleNamespace()))
    loop.run_until_complete(asyncio.wait_for(restarted, timeout=WAIT_S))

    assert client.started == 2


def test_suspend_does_nothing_during_a_shutdown(loop: asyncio.AbstractEventLoop) -> None:
    """Once a shutdown has begun, a suspend neither stops the client again nor restarts it."""
    transport, client, _, _ = _transport(loop)
    loop.run_until_complete(transport.stop(0.01))
    stops_before = len(client.stops)

    transport.suspend(10)

    assert len(client.stops) == stops_before


# Building from a kit


def test_a_key_the_tls_context_refuses_is_a_kit_key_invalid(
    loop: asyncio.AbstractEventLoop,
    tmp_path: Path,
) -> None:
    """A kit whose key the TLS context refuses gives KIT_KEY_INVALID, without any network."""
    document = read_fixture(_VALID_KIT)
    assert isinstance(document, dict)
    config = RobotKitConfig.model_validate(document["kit"]["config"])
    kit = LoadedKit(config=config, tls=_tls(), kit_dir=tmp_path)

    with pytest.raises(KitError) as caught:
        build_crt_transport(kit, 8883, loop)

    assert caught.value.code == "KIT_KEY_INVALID"


@pytest.mark.live
@pytest.mark.skipif(
    "FLEET_LIVE_KIT_ROOT" not in os.environ,
    reason="needs a registered robot's kit on this machine",
)
def test_a_real_kit_builds_a_client(loop: asyncio.AbstractEventLoop) -> None:
    """A real kit, on a machine that holds one, builds the client without a KIT_KEY_INVALID."""
    kit = load_kit(Path(os.environ["FLEET_LIVE_KIT_ROOT"]), os.environ["FLEET_LIVE_ROBOT_ID"])

    transport = build_crt_transport(kit, 8883, loop)

    assert isinstance(transport, CrtMqttTransport)
