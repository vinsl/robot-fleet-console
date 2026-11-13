"""Outbound messages: every robot-to-cloud message is built, validated and sized in this module.

A message is built from a camelCase dict, validated against the protocol model that the console
also uses, and only then serialised. A message the mirror refuses is never published: the caller
gets a `MessageBuildError` with the paths that failed, and nothing about the values.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, TypeAdapter, ValidationError

from fleet_agent.core.errors import validation_paths
from fleet_agent.core.ids import uuid7
from fleet_agent.core.ports import Clock, QoS
from fleet_agent.protocol.acks import Ack, AckReason
from fleet_agent.protocol.constants import MAX_MQTT_PAYLOAD_BYTES, SCHEMA_VERSION
from fleet_agent.protocol.events import (
    BootEvent,
    FaultClearedEvent,
    FaultRaisedEvent,
    GoingOfflineEvent,
    HeartbeatEvent,
    LockFreeEvent,
    LockHeldEvent,
    StateChangedEvent,
)
from fleet_agent.protocol.primitives import FaultCode, ReportedState
from fleet_agent.protocol.telemetry import Telemetry
from fleet_agent.protocol.topics import ack_topic, events_topic, telemetry_topic
from fleet_agent.protocol.triggers import StateChangeCause
from fleet_agent.timefmt import format_iso_ms

MessageKind = Literal["telemetry", "event", "ack"]
"""Which channel of the protocol a message belongs to."""

_ACK_ADAPTER = TypeAdapter(Ack)
_BATTERY_MIN = 0.0
_BATTERY_MAX = 100.0


class MessageBuildError(Exception):
    """A message failed its schema, or was too large to publish.

    The text is fixed on purpose: the failing values never appear in a log line. The paths say
    which fields were refused, which is enough to find the bug.

    Attributes:
        paths: Dotted paths of the refused fields, or `payload` for an oversize message.
    """

    def __init__(self, paths: tuple[str, ...]) -> None:
        """Creates the error.

        Args:
            paths: Dotted paths of the refused fields.
        """
        super().__init__("message failed its schema")
        self.paths = paths


@dataclass(frozen=True, slots=True)
class OutboundMessage:
    """A serialised message, ready for the transport.

    Attributes:
        topic: The full topic to publish on.
        payload: The UTF-8 JSON body.
        qos: The quality of service to request.
        kind: The protocol channel of the message.
        label: The message type, used as the `label` log field.
        seq: The sequence number of the message within the boot.
        message_id: The UUIDv7 of the message.
    """

    topic: str
    payload: bytes
    qos: QoS
    kind: MessageKind
    label: str
    seq: int
    message_id: str


@dataclass(frozen=True, slots=True)
class TelemetryFields:
    """The values a telemetry message reports, as the model holds them.

    Attributes:
        x: Position on the x axis, in metres.
        y: Position on the y axis, in metres.
        heading: Heading in radians. It is normalised before it is sent.
        state: The reported state.
        battery: Charge in percent. It is clamped to [0, 100] before it is sent.
        speed: Speed in metres per second.
        mission_id: The mission in progress, if any.
        error_code: The active fault, if any.
    """

    x: float
    y: float
    heading: float
    state: ReportedState
    battery: float
    speed: float
    mission_id: str | None
    error_code: FaultCode | None


@dataclass(frozen=True, slots=True)
class _Header:
    """The envelope of one message, and the timestamp that its body may reuse."""

    seq: int
    message_id: str
    ts: str
    fields: dict[str, object]


class MessageFactory:
    """Builds the robot's outbound messages with one shared sequence within a boot.

    Every call takes the next sequence number, including a call that then fails validation. A gap
    in the sequence is harmless and tells the console that a message was lost. Reusing a number
    would be worse, because the console would take a second message for a duplicate.
    """

    def __init__(
        self,
        *,
        robot_id: str,
        site_id: str,
        boot_id: str,
        clock: Clock,
        new_id: Callable[[], str] = uuid7,
    ) -> None:
        """Creates a factory for one boot.

        Args:
            robot_id: The robot identifier, from the kit.
            site_id: The site identifier, from the kit.
            boot_id: The UUIDv7 of this boot.
            clock: The source of the wall time stamped on each message.
            new_id: The source of message identifiers. Injected so that tests can pin them.

        Raises:
            TypeError: If an identifier is outside the topic grammar.
        """
        self._robot_id = robot_id
        self._site_id = site_id
        self._boot_id = boot_id
        self._clock = clock
        self._new_id = new_id
        self._telemetry_topic = telemetry_topic(site_id, robot_id)
        self._events_topic = events_topic(site_id, robot_id)
        self._ack_topic = ack_topic(site_id, robot_id)
        self._next_seq = 0

    @property
    def boot_id(self) -> str:
        """The UUIDv7 of this boot.

        Returns:
            The boot identifier.
        """
        return self._boot_id

    @property
    def last_seq(self) -> int | None:
        """The sequence number of the most recent call, or None before the first one.

        Returns:
            The last number taken, whether or not its message was published.
        """
        return None if self._next_seq == 0 else self._next_seq - 1

    def telemetry(self, fields: TelemetryFields) -> OutboundMessage:
        """Builds a telemetry message. It is QoS 0, so the broker does not acknowledge it.

        Args:
            fields: The reported values.

        Returns:
            The serialised message.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {
            "x": fields.x,
            "y": fields.y,
            "heading": _normalised_heading(fields.heading),
            "state": fields.state,
            "battery": _clamped_battery(fields.battery),
            "speed": fields.speed,
            "missionId": fields.mission_id,
            "errorCode": fields.error_code,
        }
        return self._message(
            header,
            body,
            Telemetry.model_validate,
            topic=self._telemetry_topic,
            qos=0,
            kind="telemetry",
            label="TELEMETRY",
        )

    def boot(self, *, agent_version: str, simulated: bool, state: ReportedState) -> OutboundMessage:
        """Builds the first event of a boot.

        Args:
            agent_version: Dotted version of the agent software.
            simulated: Whether the robot runs as a simulator.
            state: The state the boot starts in.

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {
            "kind": "BOOT",
            "agentVersion": agent_version,
            "simulated": simulated,
            "state": state,
        }
        return self._event(header, body, BootEvent.model_validate, "BOOT")

    def state_changed(
        self,
        *,
        from_state: ReportedState,
        to_state: ReportedState,
        cause: StateChangeCause,
        command_id: str | None,
    ) -> OutboundMessage:
        """Builds a state change event. The key of the origin state is `from` on the wire.

        Args:
            from_state: The state before the change.
            to_state: The state after the change.
            cause: The trigger that caused the change.
            command_id: The command that caused it, when a command did.

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {
            "kind": "STATE_CHANGED",
            "from": from_state,
            "to": to_state,
            "cause": cause,
            "commandId": command_id,
        }
        return self._event(header, body, StateChangedEvent.model_validate, "STATE_CHANGED")

    def heartbeat(self, *, state: ReportedState, battery: float) -> OutboundMessage:
        """Builds a heartbeat, sent after a silence so that a quiet robot is not taken for dead.

        Args:
            state: The reported state.
            battery: Charge in percent. It is clamped to [0, 100].

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {
            "kind": "HEARTBEAT",
            "state": state,
            "battery": _clamped_battery(battery),
        }
        return self._event(header, body, HeartbeatEvent.model_validate, "HEARTBEAT")

    def fault_raised(self, fault: FaultCode) -> OutboundMessage:
        """Builds the event announcing a fault.

        Args:
            fault: The fault that appeared.

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {"kind": "FAULT_RAISED", "fault": fault}
        return self._event(header, body, FaultRaisedEvent.model_validate, "FAULT_RAISED")

    def fault_cleared(self, fault: FaultCode) -> OutboundMessage:
        """Builds the event announcing that a fault went away.

        Args:
            fault: The fault that cleared.

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {"kind": "FAULT_CLEARED", "fault": fault}
        return self._event(header, body, FaultClearedEvent.model_validate, "FAULT_CLEARED")

    def lock_held(self, *, holder: str, cause: Literal["ACQUIRED", "TAKEOVER"]) -> OutboundMessage:
        """Builds the event announcing that the lock was acquired or taken over.

        This is the only event that names the holder, as the protocol requires.

        Args:
            holder: The subject of the lock holder, as the console knows it.
            cause: Whether the lock was acquired freely or taken over.

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {
            "kind": "LOCK_CHANGED",
            "held": True,
            "holder": holder,
            "cause": cause,
        }
        return self._event(header, body, LockHeldEvent.model_validate, "LOCK_CHANGED")

    def lock_free(self, *, cause: Literal["RELEASED", "EXPIRED"]) -> OutboundMessage:
        """Builds the event announcing that the lock is free again. It names no holder.

        Args:
            cause: Whether the holder released the lock or it expired.

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {"kind": "LOCK_CHANGED", "held": False, "cause": cause}
        return self._event(header, body, LockFreeEvent.model_validate, "LOCK_CHANGED")

    def going_offline(self) -> OutboundMessage:
        """Builds the robot's announcement of a clean shutdown.

        The cloud, not the robot, sets the state to `OFFLINE`.

        Returns:
            The serialised event.

        Raises:
            MessageBuildError: If the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {"kind": "GOING_OFFLINE", "reason": "SHUTDOWN"}
        return self._event(header, body, GoingOfflineEvent.model_validate, "GOING_OFFLINE")

    def ack(
        self,
        *,
        command_id: str,
        correlation_id: str,
        state: ReportedState,
        result: Literal["ACK", "REJECT"],
        reason: AckReason | None,
    ) -> OutboundMessage:
        """Builds the acknowledgement of a command.

        A `REJECT` must carry a reason and an `ACK` must not. The mirror enforces both, so a
        caller that gets it wrong gets a `MessageBuildError`, not a silent answer.

        Args:
            command_id: The command being answered.
            correlation_id: The correlation identifier of the command, echoed back.
            state: The state of the robot after the command.
            result: `ACK` or `REJECT`.
            reason: Why the command was refused. None for an `ACK`.

        Returns:
            The serialised acknowledgement.

        Raises:
            MessageBuildError: If the mirror refuses a value, or the message is too large.
        """
        header = self._header()
        body: dict[str, object] = {
            "commandId": command_id,
            "correlationId": correlation_id,
            "robotTs": header.ts,
            "state": state,
            "result": result,
            "reason": reason,
        }
        return self._message(
            header,
            body,
            _ACK_ADAPTER.validate_python,
            topic=self._ack_topic,
            qos=1,
            kind="ack",
            label="ACK",
        )

    def _header(self) -> _Header:
        """Takes the next sequence number and stamps the envelope of a new message.

        Returns:
            The envelope fields and the timestamp, shared with any body field that needs it.
        """
        seq = self._next_seq
        self._next_seq += 1
        message_id = self._new_id()
        ts = format_iso_ms(self._clock.wall_ms())
        fields: dict[str, object] = {
            "schemaVersion": SCHEMA_VERSION,
            "messageId": message_id,
            "robotId": self._robot_id,
            "siteId": self._site_id,
            "ts": ts,
            "seq": seq,
            "bootId": self._boot_id,
        }
        return _Header(seq=seq, message_id=message_id, ts=ts, fields=fields)

    def _event(
        self,
        header: _Header,
        body: dict[str, object],
        validate: Callable[[dict[str, object]], BaseModel],
        label: str,
    ) -> OutboundMessage:
        """Builds an event on the events topic at QoS 1.

        Args:
            header: The envelope taken for this message.
            body: The event fields, with `None` for an absent optional field.
            validate: The protocol model of the event.
            label: The message type.

        Returns:
            The serialised event.
        """
        return self._message(
            header,
            body,
            validate,
            topic=self._events_topic,
            qos=1,
            kind="event",
            label=label,
        )

    def _message(
        self,
        header: _Header,
        body: dict[str, object],
        validate: Callable[[dict[str, object]], BaseModel],
        *,
        topic: str,
        qos: QoS,
        kind: MessageKind,
        label: str,
    ) -> OutboundMessage:
        """Validates a message against its model, serialises it and checks its size.

        Args:
            header: The envelope taken for this message.
            body: The body fields. A `None` value is left out of the wire form.
            validate: The protocol model of the message.
            topic: The topic to publish on.
            qos: The quality of service to request.
            kind: The protocol channel.
            label: The message type.

        Returns:
            The serialised message.

        Raises:
            MessageBuildError: If the model refuses the message, or it is too large.
        """
        candidate = {**header.fields, **{k: v for k, v in body.items() if v is not None}}
        try:
            model = validate(candidate)
        except ValidationError as err:
            # `from None` drops the chained error, which holds the input values.
            raise MessageBuildError(validation_paths(err)) from None
        payload = model.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8")
        if len(payload) > MAX_MQTT_PAYLOAD_BYTES:
            raise MessageBuildError(("payload",))
        return OutboundMessage(
            topic=topic,
            payload=payload,
            qos=qos,
            kind=kind,
            label=label,
            seq=header.seq,
            message_id=header.message_id,
        )


def _normalised_heading(heading: float) -> float:
    """Maps an angle onto (-pi, pi] without losing its direction.

    Args:
        heading: The angle in radians, from any source.

    Returns:
        The same direction in [-pi, pi]. NaN stays NaN, so the mirror refuses it.
    """
    return math.atan2(math.sin(heading), math.cos(heading))


def _clamped_battery(battery: float) -> float:
    """Clamps a charge to the protocol range.

    Args:
        battery: The charge in percent.

    Returns:
        The charge within [0, 100]. NaN stays NaN, so the mirror refuses it.
    """
    return min(max(battery, _BATTERY_MIN), _BATTERY_MAX)
