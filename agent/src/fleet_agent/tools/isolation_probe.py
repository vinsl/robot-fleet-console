"""Isolation probe: checks that the broker policy keeps the robot to its own topics.

The probe is the MQTT half of the M4 gate. It connects with the robot's certificate, the same
client identifier the agent uses, and runs nine checks. The robot may do its three own actions:
publish its events, publish its acknowledgements and subscribe to its commands. It must be refused
the six others: publishing on another robot's topics, subscribing to another robot's commands,
publishing its own commands, subscribing to every robot's commands with a wildcard, and connecting
under another client identifier with the same certificate. A refusal is either the broker's
NOT_AUTHORIZED answer, or a disconnection with reason 135, which the broker also sends. A refused
connection is a refusal only when its CONNACK says 0x87.

The probe takes the robot's identity, so the agent must be stopped first: two connections with one
client identifier make the broker drop one of them.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal

from fleet_agent.adapters.system_clock import SystemClock
from fleet_agent.config.kit_file import LoadedKit
from fleet_agent.core.ids import uuid7
from fleet_agent.core.messages import MessageFactory
from fleet_agent.core.ports import (
    PublishOutcome,
    SubscribeOutcome,
    Transport,
    TransportFactory,
)
from fleet_agent.protocol.topics import ack_topic, command_topic, events_topic

Expected = Literal["ALLOWED", "DENIED"]
"""What the policy must do for a check: let the action through, or refuse it."""

_NOT_AUTHORIZED: Final = "NOT_AUTHORIZED"
"""The observed status of a broker refusal, as the transport maps reason code 0x87."""

_DENIED_BY_DISCONNECT: Final = "DISCONNECT_135"
"""The observed result of a disconnection with reason 135, which the broker sends on refusal."""

_NOT_CONNECTED: Final = "NOT_CONNECTED"
_DISCONNECTED: Final = "DISCONNECTED"
_CONNECTED: Final = "CONNECTED"
_TIMEOUT: Final = "TIMEOUT"
_STOP_TIMEOUT_S: Final = 3.0
# AWS IoT allows one CONNECT per second per client identifier: a faster reconnection is throttled.
_CONNECT_SPACING_S: Final = 1.5
_PUBLISH_QOS: Final = 1
_PROBE_CORRELATION_ID: Final = "isolation-probe"
_NOT_AUTHORIZED_REASON: Final = 135
_NOT_AUTHORIZED_CONNACK: Final = 0x87
"""The CONNACK reason code of a connection the broker policy refuses."""
_PUBLISHED: Final = "OK"
_GRANTED: Final = "GRANTED"
_ANY_COMMAND_FILTER: Final = "fleet/+/+/cmd"
"""The wildcard filter that would reach every robot's commands at once."""
_OTHER_CLIENT_SUFFIX: Final = "-probe"
"""Appended to the thing name to make a second client identifier, under the same certificate."""


@dataclass(frozen=True, slots=True)
class ProbeResult:
    """The outcome of one check.

    Attributes:
        check: The check's name, for the logs.
        expected: What the policy had to do.
        observed: What the broker did, as a fixed label. Never a message or a payload.
        passed: Whether the observation matches the expectation.
    """

    check: str
    expected: Expected
    observed: str
    passed: bool


@dataclass(frozen=True, slots=True)
class _Check:
    """One action the probe attempts on one connection.

    Attributes:
        name: The check's name.
        expected: What the policy must do.
        kind: Whether the action is a publish, a subscribe, or only the connection itself.
        topic: The topic the action targets. Empty for a connection check.
        payload: The payload of a publish, empty otherwise.
        thing_name: The client identifier of the connection, or None for the robot's own.
    """

    name: str
    expected: Expected
    kind: Literal["publish", "subscribe", "connect"]
    topic: str
    payload: bytes
    thing_name: str | None = None


class _ProbeListener:
    """Records the connection outcome and the verdict of one connection, on the loop.

    The verdict is accepted only once the action was issued. A disconnection before that proves
    nothing about the policy, so it is never read as the refusal of an action. The transport calls
    the listener on the loop thread, so the futures need no lock.

    Attributes:
        connected: The result of the connection: True when it is up, False when it failed.
        verdict: The observed label of the action, set once.
        refused_code: The CONNACK reason code of a failed connection, when the broker sent one.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        """Creates the listener with no outcome yet.

        Args:
            loop: The loop the futures belong to.
        """
        self.connected: asyncio.Future[bool] = loop.create_future()
        self.verdict: asyncio.Future[str] = loop.create_future()
        self.refused_code: int | None = None
        self._issued = False

    def issue(self) -> None:
        """Marks the action as sent. Only a result from now on can be a verdict."""
        self._issued = True

    def resolve_verdict(self, observed: str) -> None:
        """Records the outcome of the action, unless one was already recorded.

        Args:
            observed: The observed label.
        """
        _resolve(self.verdict, observed)

    def on_connected(self) -> None:
        """Records that the connection is up."""
        _resolve(self.connected, True)

    def on_disconnected(self, error_name: str | None, reason_code: int | None) -> None:
        """Records a lost connection: a 135 after the action is a refusal, any other is a loss.

        Args:
            error_name: The local error class name, unused here.
            reason_code: The DISCONNECT reason code, if the broker sent one.
        """
        is_refusal = self._issued and reason_code == _NOT_AUTHORIZED_REASON
        self.resolve_verdict(_DENIED_BY_DISCONNECT if is_refusal else _DISCONNECTED)

    def on_connect_failed(self, error_name: str | None, reason_code: int | None) -> None:
        """Records a failed attempt, which ends the check as not connected.

        Args:
            error_name: The local error class name, unused here.
            reason_code: The CONNACK reason code, kept for the connection check.
        """
        self.refused_code = reason_code
        _resolve(self.connected, False)

    def on_message(self, topic: str, payload: bytes) -> None:
        """Ignores inbound messages: the probe acts on none of them.

        Args:
            topic: The topic, unused.
            payload: The payload, unused.
        """


async def run_isolation_probe(
    kit: LoadedKit,
    *,
    other_site_id: str,
    other_robot_id: str,
    port: int,
    transport_factory: TransportFactory,
    timeout_s: float = 10.0,
    spacing_s: float = _CONNECT_SPACING_S,
) -> list[ProbeResult]:
    """Runs the nine checks, each on a fresh connection, and returns their results.

    Each connection is made with the robot's identity, connected, used once, and stopped. A check
    that cannot connect fails with `NOT_CONNECTED`. The probe does not raise on a failed check;
    it reports it.

    Args:
        kit: The robot's loaded kit. Its identity is the one probed.
        other_site_id: The site of the other robot, whose topics must be refused.
        other_robot_id: The other robot, whose topics must be refused.
        port: The broker port the agent uses.
        transport_factory: Builds one transport per check.
        timeout_s: How long each wait lasts, for the connection and for the outcome.
        spacing_s: The pause between two connections. The broker throttles a client identifier that
            reconnects within a second, which would turn a check into a false `NOT_CONNECTED`.

    Returns:
        One result per check, in the order the checks run.

    Raises:
        KitError: If the transport factory refuses the kit, for example on a bad key.
    """
    loop = asyncio.get_running_loop()
    results: list[ProbeResult] = []
    for index, check in enumerate(_checks_for(kit, other_site_id, other_robot_id)):
        if index > 0:
            await asyncio.sleep(spacing_s)
        observed = await _observe(check, kit, port, transport_factory, loop, timeout_s)
        results.append(
            ProbeResult(
                check=check.name,
                expected=check.expected,
                observed=observed,
                passed=_passes(check, observed),
            )
        )
    return results


def _checks_for(kit: LoadedKit, other_site_id: str, other_robot_id: str) -> tuple[_Check, ...]:
    """Builds the nine checks, with the probe's own messages as payloads.

    The payloads are valid protocol messages from the robot's own identity. The broker decides on
    the topic alone, so the payloads only need to be well formed. The connection check uses the
    robot's thing name with a suffix as its client identifier, under the same certificate.

    Args:
        kit: The robot's loaded kit.
        other_site_id: The other robot's site.
        other_robot_id: The other robot.

    Returns:
        The checks, in the order they run.
    """
    config = kit.config
    factory = MessageFactory(
        robot_id=config.robot_id,
        site_id=config.site_id,
        boot_id=uuid7(),
        clock=SystemClock(),
    )
    heartbeat = factory.heartbeat(state="IDLE", battery=100.0).payload
    ack = factory.ack(
        command_id=uuid7(),
        correlation_id=_PROBE_CORRELATION_ID,
        state="IDLE",
        result="ACK",
        reason=None,
    ).payload
    return (
        _Check(
            "own-events-publish",
            "ALLOWED",
            "publish",
            events_topic(config.site_id, config.robot_id),
            heartbeat,
        ),
        _Check(
            "own-cmd-subscribe",
            "ALLOWED",
            "subscribe",
            command_topic(config.site_id, config.robot_id),
            b"",
        ),
        _Check(
            "own-ack-publish",
            "ALLOWED",
            "publish",
            ack_topic(config.site_id, config.robot_id),
            ack,
        ),
        _Check(
            "other-events-publish",
            "DENIED",
            "publish",
            events_topic(other_site_id, other_robot_id),
            heartbeat,
        ),
        _Check(
            "other-ack-publish",
            "DENIED",
            "publish",
            ack_topic(other_site_id, other_robot_id),
            ack,
        ),
        _Check(
            "other-cmd-subscribe",
            "DENIED",
            "subscribe",
            command_topic(other_site_id, other_robot_id),
            b"",
        ),
        _Check(
            "own-cmd-publish",
            "DENIED",
            "publish",
            command_topic(config.site_id, config.robot_id),
            heartbeat,
        ),
        _Check(
            "wildcard-cmd-subscribe",
            "DENIED",
            "subscribe",
            _ANY_COMMAND_FILTER,
            b"",
        ),
        _Check(
            "other-client-connect",
            "DENIED",
            "connect",
            "",
            b"",
            thing_name=f"{config.thing_name}{_OTHER_CLIENT_SUFFIX}",
        ),
    )


async def _observe(
    check: _Check,
    kit: LoadedKit,
    port: int,
    transport_factory: TransportFactory,
    loop: asyncio.AbstractEventLoop,
    timeout_s: float,
) -> str:
    """Runs one check on its own connection, and returns what the broker did.

    Args:
        check: The check to run.
        kit: The robot's loaded kit.
        port: The broker port.
        transport_factory: Builds the transport.
        loop: The loop the check runs on.
        timeout_s: The longest wait for the connection and for the outcome.

    Returns:
        The observed label of the check.
    """
    transport = transport_factory(_kit_for(check, kit), port, loop)
    listener = _ProbeListener(loop)
    transport.set_listener(listener)
    transport.start()
    try:
        return await _attempt(check, transport, listener, timeout_s)
    finally:
        await transport.stop(_STOP_TIMEOUT_S)


def _kit_for(check: _Check, kit: LoadedKit) -> LoadedKit:
    """Returns the kit a check connects with: the robot's own, or the same one under another name.

    The transport names its client by the kit's thing name, so a check that needs another client
    identifier copies the configuration with another thing name. The certificate and the key are
    the same, which is what the policy must refuse.

    Args:
        check: The check about to run.
        kit: The robot's loaded kit.

    Returns:
        The kit the check connects with.
    """
    if check.thing_name is None:
        return kit
    config = kit.config.model_copy(update={"thing_name": check.thing_name})
    return LoadedKit(config=config, tls=kit.tls, kit_dir=kit.kit_dir)


async def _attempt(
    check: _Check,
    transport: Transport,
    listener: _ProbeListener,
    timeout_s: float,
) -> str:
    """Waits for the connection, performs the action, and waits for its outcome.

    A connection check ends at the connection itself: a refused CONNACK with 0x87 is the refusal,
    and an accepted connection is the failure. An action that cannot be sent, because the link was
    lost before it, keeps the loss as its outcome and is never issued.

    Args:
        check: The check to run.
        transport: The connected or connecting transport.
        listener: The listener the transport reports to.
        timeout_s: The longest wait for the connection and for the outcome.

    Returns:
        The observed label of the check.
    """
    try:
        connected = await asyncio.wait_for(listener.connected, timeout=timeout_s)
    except TimeoutError:
        return _NOT_CONNECTED
    if check.kind == "connect":
        return _connection_label(connected, listener.refused_code)
    if not connected:
        return _NOT_CONNECTED
    if listener.verdict.done():
        return listener.verdict.result()
    listener.issue()
    if check.kind == "publish":
        transport.publish(
            check.topic,
            check.payload,
            _PUBLISH_QOS,
            _publish_reporter(listener),
        )
    else:
        transport.subscribe(check.topic, _subscribe_reporter(listener))
    try:
        return await asyncio.wait_for(listener.verdict, timeout=timeout_s)
    except TimeoutError:
        return _TIMEOUT


def _connection_label(connected: bool, refused_code: int | None) -> str:
    """Labels the outcome of a connection check: accepted, refused by policy, or not connected.

    Args:
        connected: Whether the connection came up.
        refused_code: The CONNACK reason code of a refused attempt, if the broker sent one.

    Returns:
        `CONNECTED`, `NOT_AUTHORIZED` for a 0x87 refusal, or `NOT_CONNECTED`.
    """
    if connected:
        return _CONNECTED
    if refused_code == _NOT_AUTHORIZED_CONNACK:
        return _NOT_AUTHORIZED
    return _NOT_CONNECTED


def _passes(check: _Check, observed: str) -> bool:
    """Tells whether the observation matches the expectation of the check.

    An allowed action must succeed: a published or granted outcome. A denied action must be
    refused, either by the broker's NOT_AUTHORIZED answer or by the disconnection with 135. Any
    other result, including a timeout or a refused connection, fails the check.

    Args:
        check: The check.
        observed: What the broker did.

    Returns:
        True when the policy behaved as the check expects.
    """
    if check.expected == "ALLOWED":
        granted = _PUBLISHED if check.kind == "publish" else _GRANTED
        return observed == granted
    return observed in (_NOT_AUTHORIZED, _DENIED_BY_DISCONNECT)


def _publish_reporter(listener: _ProbeListener) -> Callable[[PublishOutcome], None]:
    """Reports a publish outcome to the listener's verdict.

    Args:
        listener: The listener of the connection.

    Returns:
        The completion callback of the publish.
    """

    def report(outcome: PublishOutcome) -> None:
        """Records the publish outcome.

        Args:
            outcome: The mapped outcome.
        """
        listener.resolve_verdict(outcome.status)

    return report


def _subscribe_reporter(listener: _ProbeListener) -> Callable[[SubscribeOutcome], None]:
    """Reports a subscribe outcome to the listener's verdict.

    Args:
        listener: The listener of the connection.

    Returns:
        The completion callback of the subscribe.
    """

    def report(outcome: SubscribeOutcome) -> None:
        """Records the subscribe outcome.

        Args:
            outcome: The mapped outcome.
        """
        listener.resolve_verdict(outcome.status)

    return report


def _resolve[T](future: asyncio.Future[T], value: T) -> None:
    """Sets a future's result, unless it already has one.

    Args:
        future: The future to resolve.
        value: The result.
    """
    if not future.done():
        future.set_result(value)
