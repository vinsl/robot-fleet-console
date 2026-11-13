"""AWS IoT Device SDK v2 transport: MQTT 5 over mutual TLS, behind the core's `Transport` port.

The CRT client runs its own threads. Every CRT callback therefore only copies what it received and
hands it to the event loop with `call_soon_threadsafe`, so the core is never entered off the loop
thread. Every publish and subscribe that has a callback reports exactly one outcome: a
completion, a synchronous failure, or the stop of the client, whichever comes first. The
settlement table is touched on the loop thread only, which is what makes "exactly once" hold
without a lock.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
from collections.abc import Callable
from concurrent.futures import CancelledError, Future
from dataclasses import dataclass
from typing import Final, Protocol

from awscrt import mqtt5
from awscrt.exceptions import AwsCrtError
from awscrt.mqtt5 import (
    LifecycleConnectFailureData,
    LifecycleConnectSuccessData,
    LifecycleDisconnectData,
    LifecycleStoppedData,
    PublishCompletionData,
    PublishReceivedData,
    SubackPacket,
)
from awsiot.mqtt5_client_builder import mtls_from_bytes

from fleet_agent.config.kit_file import KitError, LoadedKit, TlsMaterial
from fleet_agent.core.ports import (
    PublishOutcome,
    PublishStatus,
    QoS,
    SubscribeOutcome,
    SubscribeStatus,
    TransportListener,
)

_LOG: Final = logging.getLogger(__name__)

_PUBACK_SUCCESS: Final = 0
"""PUBACK reason code 0: the message was published."""

_PUBACK_NO_MATCHING_SUBSCRIBERS: Final = 16
"""PUBACK reason code 16: published, and nobody was subscribed. Not a failure."""

_SUBACK_GRANTED_QOS_0: Final = 0
"""SUBACK reason code 0: subscribed at QoS 0."""

_SUBACK_GRANTED_QOS_1: Final = 1
"""SUBACK reason code 1: subscribed at QoS 1."""

_NOT_AUTHORIZED: Final = 0x87
"""MQTT 5 reason code 0x87, 'Not authorized', in PUBACK, SUBACK and DISCONNECT alike. It is the
broker's answer when the robot policy refuses an action, so it is what the isolation probe looks
for."""

_STOP_TIMEOUT_EVENT: Final = "link.stop_timeout"
"""Event of the warning written when a stop is not confirmed in time. The link is not confirmed
closed, which is not the same as a lost link, so it has an event of its own."""

Outcome = tuple[object | None, BaseException | None]
"""A completed operation: its result, or the exception it failed with. Exactly one is set."""


class ClientStoppedError(Exception):
    """The CRT client stopped while an operation was still pending, so the operation failed."""


@dataclass(frozen=True, slots=True)
class MqttSettings:
    """Connection settings of the MQTT client, all validated before they reach the SDK.

    Attributes:
        endpoint: The account's IoT data endpoint.
        port: The broker port, 8883 or 443.
        client_id: The MQTT client identifier. It is always the robot's thing name.
        keep_alive_s: The keep-alive interval, in seconds.
        ping_timeout_ms: How long a PINGREQ may go unanswered.
        connack_timeout_ms: How long a CONNACK may take.
        ack_timeout_s: How long a QoS 1 operation may wait for its acknowledgement.
        min_reconnect_ms: The first reconnection delay, before jitter.
        max_reconnect_ms: The largest reconnection delay.
        reset_after_ms: How long the link must stay up for the delay to reset.
        max_packet_bytes: The largest packet the robot accepts from the broker.
    """

    endpoint: str
    port: int
    client_id: str
    keep_alive_s: int = 30
    ping_timeout_ms: int = 5000
    connack_timeout_ms: int = 10000
    ack_timeout_s: int = 10
    min_reconnect_ms: int = 1000
    max_reconnect_ms: int = 30000
    reset_after_ms: int = 30000
    max_packet_bytes: int = 8192


class Mqtt5ClientLike(Protocol):
    """The part of the SDK's MQTT 5 client the transport uses. A fake implements it in tests."""

    def start(self) -> None:
        """Starts connecting, and reconnecting after every loss, by itself."""
        ...

    def stop(self, disconnect_packet: object | None = None) -> None:
        """Disconnects, sending the given DISCONNECT packet when one is given.

        Args:
            disconnect_packet: The packet to send, or None.
        """
        ...

    def publish(self, publish_packet: object) -> Future[object]:
        """Publishes one message.

        Args:
            publish_packet: The packet to send.

        Returns:
            A future that completes with the publish result.
        """
        ...

    def subscribe(self, subscribe_packet: object) -> Future[object]:
        """Subscribes to filters.

        Args:
            subscribe_packet: The packet to send.

        Returns:
            A future that completes with the SUBACK.
        """
        ...


ClientFactory = Callable[..., Mqtt5ClientLike]
"""Builds a client from the TLS material and the keyword options. The SDK's mTLS builder is the
default; tests pass a fake."""


def builder_kwargs(settings: MqttSettings) -> dict[str, object]:
    """Returns the options of the SDK's MQTT 5 client, except the TLS material and the callbacks.

    The client uses a clean session, the full-jitter reconnection with the given bounds, and a
    queue that fails QoS 0 publishes while disconnected. It sends no last will and no session
    expiry, and it bounds the packets it accepts. SDK metrics collection is off, so the
    connection carries no SDK usage metadata.

    Args:
        settings: The connection settings.

    Returns:
        The keyword arguments of the builder, without the CA bundle.
    """
    return {
        "endpoint": settings.endpoint,
        "port": settings.port,
        "client_id": settings.client_id,
        "session_behavior": mqtt5.ClientSessionBehaviorType.CLEAN,
        "offline_queue_behavior": (
            mqtt5.ClientOperationQueueBehaviorType.FAIL_QOS0_PUBLISH_ON_DISCONNECT
        ),
        "retry_jitter_mode": mqtt5.ExponentialBackoffJitterMode.FULL,
        "min_reconnect_delay_ms": settings.min_reconnect_ms,
        "max_reconnect_delay_ms": settings.max_reconnect_ms,
        "min_connected_time_to_reset_reconnect_delay_ms": settings.reset_after_ms,
        "ping_timeout_ms": settings.ping_timeout_ms,
        "connack_timeout_ms": settings.connack_timeout_ms,
        "ack_timeout_sec": settings.ack_timeout_s,
        "connect_options": mqtt5.ConnectPacket(
            keep_alive_interval_sec=settings.keep_alive_s,
            client_id=settings.client_id,
            maximum_packet_size=settings.max_packet_bytes,
        ),
        "enable_metrics_collection": False,
    }


def publish_outcome_of(
    result: PublishCompletionData | None,
    error: BaseException | None,
) -> PublishOutcome:
    """Maps the outcome of one publish to the port's outcome.

    A QoS 0 publish has no PUBACK and counts as published. Reason codes 0 and 16 are published,
    0x87 is not authorized, and any other code is refused with that code kept for the logs.

    Args:
        result: The completion data, when the publish completed.
        error: The exception, when the publish failed locally.

    Returns:
        The outcome the core sees.
    """
    if error is not None:
        return PublishOutcome("FAILED", error_name=_error_name(error))
    if result is None:
        return PublishOutcome("FAILED")
    puback = result.puback
    # The SDK hands a QoS 0 publish an empty PUBACK whose reason code is None, not a missing PUBACK.
    if puback is None or puback.reason_code is None:
        return PublishOutcome("OK")
    code = int(puback.reason_code)
    status: PublishStatus
    if code in (_PUBACK_SUCCESS, _PUBACK_NO_MATCHING_SUBSCRIBERS):
        status = "OK"
    elif code == _NOT_AUTHORIZED:
        status = "NOT_AUTHORIZED"
    else:
        status = "REFUSED"
    return PublishOutcome(status, reason_code=code)


def subscribe_outcome_of(
    result: SubackPacket | None,
    error: BaseException | None,
) -> SubscribeOutcome:
    """Maps the outcome of one subscribe to the port's outcome, from the first SUBACK code.

    Reason codes 0 and 1 are granted, 0x87 is not authorized, and any other code is refused.

    Args:
        result: The SUBACK, when the subscribe completed.
        error: The exception, when the subscribe failed locally.

    Returns:
        The outcome the core sees.
    """
    if error is not None:
        return SubscribeOutcome("FAILED", error_name=_error_name(error))
    if result is None:
        return SubscribeOutcome("FAILED")
    codes = result.reason_codes
    if not codes:
        return SubscribeOutcome("REFUSED")
    code = int(codes[0])
    status: SubscribeStatus
    if code in (_SUBACK_GRANTED_QOS_0, _SUBACK_GRANTED_QOS_1):
        status = "GRANTED"
    elif code == _NOT_AUTHORIZED:
        status = "NOT_AUTHORIZED"
    else:
        status = "REFUSED"
    return SubscribeOutcome(status, reason_code=code)


class CrtMqttTransport:
    """The robot's MQTT link, implementing the core's `Transport` port over the SDK's client.

    The client is built at once, which fails early on a key the TLS context refuses. The core
    drives it from the loop thread; the SDK's callbacks reach the core only through the loop.
    """

    def __init__(
        self,
        settings: MqttSettings,
        tls: TlsMaterial,
        loop: asyncio.AbstractEventLoop,
        client_factory: ClientFactory | None = None,
    ) -> None:
        """Builds the client with its TLS material and its callbacks, without connecting.

        Args:
            settings: The connection settings.
            tls: The TLS material, passed to the SDK as bytes.
            loop: The event loop the core runs on.
            client_factory: Builds the client. Defaults to the SDK's mTLS builder.

        Raises:
            AwsCrtError, RuntimeError, TypeError or ValueError: If the TLS context or the SDK's
                builder refuses the material. The caller maps every one of them to a kit refusal.
        """
        self._loop = loop
        self._listener: TransportListener | None = None
        self._open: dict[int, Callable[[object | None, BaseException | None], None]] = {}
        self._keys = itertools.count()
        self._shutting_down = False
        self._started = False
        self._resume_at: float | None = None
        self._restart: asyncio.TimerHandle | None = None
        self._client_stopped = False
        self._stop_event: asyncio.Event | None = None
        factory: ClientFactory = client_factory if client_factory is not None else mtls_from_bytes
        self._client = factory(
            cert_bytes=tls.certificate_pem,
            pri_key_bytes=tls.private_key_pem,
            ca_bytes=tls.root_ca_pem,
            **builder_kwargs(settings),
            on_publish_received=self._on_publish_received,
            on_lifecycle_connection_success=self._on_connection_success,
            on_lifecycle_connection_failure=self._on_connection_failure,
            on_lifecycle_disconnection=self._on_disconnection,
            on_lifecycle_stopped=self._on_stopped,
        )

    def set_listener(self, listener: TransportListener) -> None:
        """Registers the object that receives the link's events.

        Args:
            listener: The listener. It replaces any previous one.
        """
        self._listener = listener

    def start(self) -> None:
        """Starts connecting.

        Raises:
            RuntimeError: If no listener was set, since the events would have nowhere to go.
        """
        if self._listener is None:
            raise RuntimeError("the listener must be set before the transport starts")
        self._client.start()
        self._started = True

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Publishes a message, reporting its outcome through `on_done` exactly once.

        The payload is copied, so that the caller may reuse its buffer. A synchronous failure of
        the client is reported as a failed outcome rather than raised.

        Args:
            topic: The full topic.
            payload: The serialised message.
            qos: The quality of service to request.
            on_done: Called once with the outcome, on the loop thread.
        """
        packet = mqtt5.PublishPacket(
            topic=topic,
            payload=bytes(payload),
            qos=mqtt5.QoS.AT_MOST_ONCE if qos == 0 else mqtt5.QoS.AT_LEAST_ONCE,
        )
        try:
            future = self._client.publish(packet)
        except Exception as err:
            self._report(on_done, publish_outcome_of(None, err))
            return
        if on_done is not None:
            self._watch(future, _publish_settler(on_done))

    def subscribe(self, topic_filter: str, on_done: Callable[[SubscribeOutcome], None]) -> None:
        """Subscribes at QoS 1, reporting the SUBACK outcome through `on_done` exactly once.

        Args:
            topic_filter: The filter to subscribe to.
            on_done: Called once with the outcome, on the loop thread.
        """
        subscription = mqtt5.Subscription(
            topic_filter=topic_filter,
            qos=mqtt5.QoS.AT_LEAST_ONCE,
        )
        packet = mqtt5.SubscribePacket(subscriptions=[subscription])
        try:
            future = self._client.subscribe(packet)
        except Exception as err:
            self._post(on_done, subscribe_outcome_of(None, err))
            return
        self._watch(future, _subscribe_settler(on_done))

    def suspend(self, duration_ms: int) -> None:
        """Drops the link for a while, then lets the client reconnect by itself.

        A client that is still running is stopped, and the restart is scheduled when it reports
        its stop, so the restart never races the stop. A client that is already stopped gets its
        restart scheduled at once, since the SDK sends no second stop event. When a restart is
        already pending, the later of the two deadlines wins. Nothing is restarted once a shutdown
        has begun.

        Args:
            duration_ms: How long the link stays down.
        """
        if self._shutting_down:
            return
        requested = self._loop.time() + duration_ms / 1000
        deadline = requested if self._resume_at is None else max(self._resume_at, requested)
        self._resume_at = deadline
        if self._client_stopped:
            self._arm_restart(deadline)
            return
        self._client.stop()

    async def stop(self, timeout_s: float) -> None:
        """Disconnects with a normal DISCONNECT, and waits at most `timeout_s` for the broker.

        When the wait times out, a warning is logged and the call returns. Every operation still
        pending is then reported as failed, so no `on_done` is left waiting. A client that a
        suspend already stopped is not stopped again. A client that was never started is sent the
        DISCONNECT but not waited for, since the SDK sends no stop event for it: the wait would
        only end in a spurious timeout.

        Args:
            timeout_s: The upper bound of the wait, in seconds.
        """
        self._shutting_down = True
        self._resume_at = None
        self._cancel_restart()
        if self._client_stopped:
            self._fail_open()
            return
        stopped = asyncio.Event()
        self._stop_event = stopped
        self._client.stop(
            mqtt5.DisconnectPacket(reason_code=mqtt5.DisconnectReasonCode.NORMAL_DISCONNECTION)
        )
        if not self._started:
            # A client that never connected gets no stop event: waiting would only time out.
            self._fail_open()
            return
        try:
            await asyncio.wait_for(stopped.wait(), timeout=timeout_s)
        except TimeoutError:
            _LOG.warning(_STOP_TIMEOUT_EVENT, extra={"errorName": "TimeoutError"})
        finally:
            self._fail_open()

    def _watch(
        self,
        future: Future[object],
        settle: Callable[[object | None, BaseException | None], None],
    ) -> None:
        """Records a pending operation and arranges for its completion to reach the loop.

        Args:
            future: The future of the operation.
            settle: Reports the completion, given its result or its exception.
        """
        key = next(self._keys)
        self._open[key] = settle
        future.add_done_callback(lambda done: self._post(self._settle, key, *_outcome_of(done)))

    def _settle(self, key: int, result: object | None, error: BaseException | None) -> None:
        """Reports the completion of one pending operation, unless it was already reported.

        Runs on the loop thread only. The entry is removed before it is used, so a second
        completion of the same operation does nothing. A callback that raises is logged by its
        error name only, so that it cannot stop the other operations from being reported.

        Args:
            key: The operation's key.
            result: The result, when the operation completed.
            error: The exception, when the operation failed.
        """
        settle = self._open.pop(key, None)
        if settle is None:
            return
        try:
            settle(result, error)
        except Exception as err:
            _LOG.error("link.callback_failed", extra={"errorName": type(err).__name__})

    def _fail_open(self) -> None:
        """Reports every pending operation as failed, because the client has stopped."""
        for key in list(self._open):
            self._settle(key, None, ClientStoppedError())

    def _report(
        self,
        on_done: Callable[[PublishOutcome], None] | None,
        outcome: PublishOutcome,
    ) -> None:
        """Hands an outcome to the caller on the loop, when the caller asked for one.

        Args:
            on_done: The caller's callback, or None.
            outcome: The outcome to report.
        """
        if on_done is not None:
            self._post(on_done, outcome)

    def _post(self, callback: Callable[..., None], *args: object) -> None:
        """Runs a callback on the loop thread, from any thread.

        A closed loop means the process is shutting down and nothing is left to inform, so the
        call is dropped rather than raised into the SDK's thread.

        Args:
            callback: The function to run on the loop.
            *args: Its arguments, already copied by the caller.
        """
        with contextlib.suppress(RuntimeError):
            self._loop.call_soon_threadsafe(callback, *args)

    def _on_publish_received(self, data: PublishReceivedData) -> None:
        """Receives an inbound message on the SDK's thread and hands a copy to the loop.

        Args:
            data: The SDK's publish-received data, which carries the packet.
        """
        packet = data.publish_packet
        topic = str(packet.topic)
        payload = bytes(packet.payload)
        self._post(self._deliver_message, topic, payload)

    def _on_connection_success(self, data: LifecycleConnectSuccessData) -> None:
        """Records a connection on the SDK's thread and hands the event to the loop.

        Args:
            data: The SDK's connection data. Its content is not needed.
        """
        self._post(self._deliver_connected)

    def _on_connection_failure(self, data: LifecycleConnectFailureData) -> None:
        """Records a failed attempt on the SDK's thread and hands the reasons to the loop.

        Args:
            data: The SDK's failure data, with the CONNACK and the exception when present.
        """
        connack = data.connack_packet
        reason = None if connack is None else int(connack.reason_code)
        error_name = _optional_error_name(data.exception)
        self._post(self._deliver_connect_failed, error_name, reason)

    def _on_disconnection(self, data: LifecycleDisconnectData) -> None:
        """Records a lost connection on the SDK's thread and hands the reasons to the loop.

        Args:
            data: The SDK's disconnection data, with the DISCONNECT and the exception when present.
        """
        disconnect = data.disconnect_packet
        reason = None if disconnect is None else int(disconnect.reason_code)
        error_name = _optional_error_name(data.exception)
        self._post(self._deliver_disconnected, error_name, reason)

    def _on_stopped(self, data: LifecycleStoppedData) -> None:
        """Records that the client stopped on the SDK's thread and hands the event to the loop.

        Args:
            data: The SDK's stopped data, which is empty.
        """
        self._post(self._handle_stopped)

    def _handle_stopped(self) -> None:
        """Wakes a waiting stop, schedules a suspended restart, then fails the pending operations.

        The stop and the restart come before the fan-out, so that a callback that fails during the
        fan-out cannot keep a waiting stop from returning, nor a suspended link from restarting.
        """
        self._client_stopped = True
        if self._stop_event is not None:
            self._stop_event.set()
        if self._resume_at is not None and not self._shutting_down:
            self._arm_restart(self._resume_at)
        self._fail_open()

    def _arm_restart(self, deadline: float) -> None:
        """Schedules the restart of a suspended client for a deadline, replacing any pending one.

        Args:
            deadline: The loop time at which the client must restart.
        """
        self._cancel_restart()
        delay = max(0.0, deadline - self._loop.time())
        self._restart = self._loop.call_later(delay, self._restart_now)

    def _cancel_restart(self) -> None:
        """Cancels the pending restart, if there is one."""
        if self._restart is not None:
            self._restart.cancel()
            self._restart = None

    def _restart_now(self) -> None:
        """Restarts a suspended client, unless a shutdown began while the delay ran.

        The timer can fire after `stop` was requested, so the shutdown is checked when it fires,
        not only when it was scheduled. A restart during a shutdown would reconnect a robot that
        is going offline.
        """
        self._restart = None
        self._resume_at = None
        if self._shutting_down:
            return
        self._client_stopped = False
        self._client.start()

    def _deliver_message(self, topic: str, payload: bytes) -> None:
        """Hands an inbound message to the listener, on the loop thread.

        Args:
            topic: The topic the message arrived on.
            payload: The payload, copied.
        """
        if self._listener is not None:
            self._listener.on_message(topic, payload)

    def _deliver_connected(self) -> None:
        """Tells the listener that the connection is up, on the loop thread."""
        if self._listener is not None:
            self._listener.on_connected()

    def _deliver_connect_failed(self, error_name: str | None, reason_code: int | None) -> None:
        """Tells the listener that an attempt failed, on the loop thread.

        Args:
            error_name: The local error class name, if any.
            reason_code: The CONNACK reason code, if the broker sent one.
        """
        if self._listener is not None:
            self._listener.on_connect_failed(error_name, reason_code)

    def _deliver_disconnected(self, error_name: str | None, reason_code: int | None) -> None:
        """Tells the listener that the connection is lost, on the loop thread.

        Args:
            error_name: The local error class name, if any.
            reason_code: The DISCONNECT reason code, if the broker sent one.
        """
        if self._listener is not None:
            self._listener.on_disconnected(error_name, reason_code)


def build_crt_transport(
    kit: LoadedKit,
    port: int,
    loop: asyncio.AbstractEventLoop,
) -> CrtMqttTransport:
    """Builds the transport of one robot from its kit, failing early on a key the TLS refuses.

    The client identifier is the robot's thing name, and the endpoint is the one the kit names.

    Args:
        kit: The loaded kit.
        port: The broker port.
        loop: The event loop the core runs on.

    Returns:
        A transport that has not connected yet.

    Raises:
        KitError: With `KIT_KEY_INVALID` when the TLS context refuses the certificate or key.
    """
    settings = MqttSettings(
        endpoint=kit.config.iot_endpoint,
        port=port,
        client_id=kit.config.thing_name,
    )
    try:
        return CrtMqttTransport(settings, kit.tls, loop)
    except (AwsCrtError, RuntimeError, TypeError, ValueError):
        # The SDK reports a key its TLS context refuses in several ways: a native error, a runtime
        # error from the binding, or a type or value error from the builder's own checks. Every
        # one of them means the same thing here, so all of them become the same refusal.
        raise KitError("KIT_KEY_INVALID") from None


def _publish_settler(
    on_done: Callable[[PublishOutcome], None],
) -> Callable[[object | None, BaseException | None], None]:
    """Adapts a publish callback to the settlement table.

    Args:
        on_done: The caller's callback.

    Returns:
        A settler that maps the completion to a publish outcome.
    """

    def settle(result: object | None, error: BaseException | None) -> None:
        """Maps the completion, then reports it.

        Args:
            result: The completion data, if any.
            error: The exception, if any.
        """
        on_done(publish_outcome_of(result, error))

    return settle


def _subscribe_settler(
    on_done: Callable[[SubscribeOutcome], None],
) -> Callable[[object | None, BaseException | None], None]:
    """Adapts a subscribe callback to the settlement table.

    Args:
        on_done: The caller's callback.

    Returns:
        A settler that maps the completion to a subscribe outcome.
    """

    def settle(result: object | None, error: BaseException | None) -> None:
        """Maps the completion, then reports it.

        Args:
            result: The SUBACK, if any.
            error: The exception, if any.
        """
        on_done(subscribe_outcome_of(result, error))

    return settle


def _outcome_of(future: Future[object]) -> Outcome:
    """Reads a finished future without blocking, as a result or an exception.

    Args:
        future: A future that is done.

    Returns:
        The result with no exception, or no result with the exception.
    """
    if future.cancelled():
        return None, CancelledError()
    error = future.exception()
    if error is not None:
        return None, error
    return future.result(), None


def _error_name(error: BaseException) -> str:
    """Returns the name of an error for the logs: the SDK's error name, else the class name.

    The name is a fixed identifier, never the message, which can quote a value.

    Args:
        error: The exception.

    Returns:
        The error name.
    """
    name = getattr(error, "name", None)
    return name if isinstance(name, str) else type(error).__name__


def _optional_error_name(error: BaseException | None) -> str | None:
    """Returns the name of an optional exception, for the logs.

    Args:
        error: The exception, or None.

    Returns:
        The error name, or None when there is no exception.
    """
    return None if error is None else _error_name(error)
