"""Screening: the checks a raw command must pass before the lock and the state machine see it.

Every inbound payload is untrusted. Screening runs the cheap, stateless checks first (size, topic,
JSON shape, identifiers, schema) and then the checks that depend on the robot (ownership, replay,
age, capability). The first failing stage decides the outcome, and each outcome says whether the
robot answers. A message that cannot be attributed to a command (wrong size, wrong topic,
unparseable, malformed identifiers) is dropped without an answer, so an attacker cannot use the
robot to probe the schema or to spend identifiers.

Nothing here logs or echoes an input value. Refusals carry the stage, the reason and the paths of
the fields that failed, never the values.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Final, Literal, NoReturn

from pydantic import TypeAdapter, ValidationError

from fleet_agent.core.errors import validation_paths
from fleet_agent.core.replay import ReplayGuard
from fleet_agent.protocol.acks import AckReason
from fleet_agent.protocol.commands import (
    Command,
    DriveCommand,
    EstopCommand,
    EstopReleaseCommand,
    HeartbeatCommand,
    PauseCommand,
    ReleaseControlCommand,
    ResumeCommand,
    ReturnToBaseCommand,
    SimulateFaultCommand,
    TakeControlCommand,
)
from fleet_agent.protocol.constants import (
    COMMAND_MAX_AGE_MS,
    COMMAND_MAX_FUTURE_SKEW_MS,
    MAX_MQTT_PAYLOAD_BYTES,
    UNSUPPORTED_COMMANDS,
)
from fleet_agent.protocol.primitives import CorrelationId, FaultCode, Uuidv7
from fleet_agent.protocol.triggers import CommandTrigger
from fleet_agent.timefmt import parse_iso_ms

Stage = Literal[
    "SIZE",
    "TOPIC",
    "PARSE",
    "IDS",
    "SCHEMA",
    "OWN_IDS",
    "DUPLICATE",
    "AGE",
    "UNSUPPORTED",
    "SIMULATED",
    "LOCK",
    "STATE",
]
"""The pipeline stage that decided an outcome. LOCK and STATE are decided after screening."""

AnyCommand = (
    PauseCommand
    | ResumeCommand
    | ReturnToBaseCommand
    | EstopCommand
    | EstopReleaseCommand
    | TakeControlCommand
    | ReleaseControlCommand
    | HeartbeatCommand
    | DriveCommand
    | SimulateFaultCommand
)
"""Any command the schema accepts, as the validated model."""

_COMMAND_ADAPTER: TypeAdapter[AnyCommand] = TypeAdapter(Command)
_UUID_ADAPTER: TypeAdapter[str] = TypeAdapter(Uuidv7)
_CORRELATION_ADAPTER: TypeAdapter[str] = TypeAdapter(CorrelationId)
_LOGGABLE_TYPE = re.compile(r"[A-Z_]{1,32}")
SIMULATE_TRIGGER: Final[dict[FaultCode, CommandTrigger]] = {
    "OBSTACLE": "SIMULATE_FAULT:OBSTACLE",
    "SENSOR_FAULT": "SIMULATE_FAULT:SENSOR_FAULT",
    "BATTERY_LOW": "SIMULATE_FAULT:BATTERY_LOW",
    "LINK_LOSS": "SIMULATE_FAULT:LINK_LOSS",
}
"""The trigger each simulated fault raises. It is the one table of fault injection: the commands
and the simulator's hooks both read it, so the two cannot drift apart."""


@dataclass(frozen=True, slots=True)
class ScreeningContext:
    """What the robot knows about itself, and checks commands against.

    Attributes:
        robot_id: The identifier of this robot, from its kit.
        site_id: The site of this robot, from its kit.
        simulated: Whether this robot is a simulator, which alone accepts fault injection.
        command_topic: The only topic commands are accepted on.
    """

    robot_id: str
    site_id: str
    simulated: bool
    command_topic: str


@dataclass(frozen=True, slots=True)
class Dropped:
    """A message discarded without an answer, because it is not attributable to a command.

    Attributes:
        stage: The stage that dropped it: SIZE, TOPIC, PARSE or IDS.
        size_bytes: The payload size, for the log.
    """

    stage: Stage
    size_bytes: int


@dataclass(frozen=True, slots=True)
class Refused:
    """A command the robot answers with a REJECT, or stays silent about when it is a heartbeat.

    Attributes:
        stage: The stage that refused it.
        reason: The reason the answer carries.
        command_id: The identifier of the command, already checked against its pattern.
        correlation_id: The correlation identifier, echoed in the answer.
        command_type: The command type, for the log, when it has a loggable shape.
        silent: True for a HEARTBEAT, which is never answered.
        error_paths: The paths of the fields that failed the schema. Never their values.
        age_ms: The command's age in milliseconds, when it could be computed.
    """

    stage: Stage
    reason: AckReason
    command_id: str
    correlation_id: str
    command_type: str | None
    silent: bool
    error_paths: tuple[str, ...] = ()
    age_ms: int | None = None


@dataclass(frozen=True, slots=True)
class Screened:
    """A command that passed every screening stage and goes on to the lock and the state machine.

    Attributes:
        command: The validated command.
        age_ms: The command's age in milliseconds. None only for an ESTOP whose issue time cannot
            be read, which is still accepted: a stop is never refused.
        silent: True for a HEARTBEAT.
    """

    command: AnyCommand
    age_ms: int | None
    silent: bool


@dataclass(frozen=True, slots=True)
class _Head:
    """The identifiers every refusal carries. They were checked before any refusal is possible."""

    command_id: str
    correlation_id: str
    command_type: str | None
    silent: bool


def screen_command(
    topic: str,
    payload: bytes,
    *,
    ctx: ScreeningContext,
    replay: ReplayGuard,
    now_wall_ms: int,
) -> Dropped | Refused | Screened:
    """Runs the screening stages in order and returns the first decision.

    The replay memory is written only at the dedupe stage, after the schema and ownership checks
    have passed, so a refused message cannot burn an identifier a legitimate command needs.

    Args:
        topic: The topic the message arrived on.
        payload: The raw payload, untrusted.
        ctx: The robot's identity and the command topic.
        replay: The replay memory. It is written to by this call.
        now_wall_ms: The current wall time, in milliseconds since the Unix epoch.

    Returns:
        `Dropped` for a message with no answer, `Refused` for one that gets a REJECT or is a
        silent heartbeat refusal, or `Screened` for a command that goes on.
    """
    size = len(payload)
    if size > MAX_MQTT_PAYLOAD_BYTES:
        return Dropped("SIZE", size)
    if topic != ctx.command_topic:
        return Dropped("TOPIC", size)
    raw = _parse_object(payload)
    if raw is None:
        return Dropped("PARSE", size)
    identifiers = _read_identifiers(raw)
    if identifiers is None:
        return Dropped("IDS", size)
    command_id, correlation_id = identifiers
    head = _Head(
        command_id=command_id,
        correlation_id=correlation_id,
        command_type=_loggable_type(raw.get("type")),
        silent=raw.get("type") == "HEARTBEAT",
    )
    return _screen_validated(raw, head, ctx=ctx, replay=replay, now_wall_ms=now_wall_ms)


def _screen_validated(
    raw: dict[str, object],
    head: _Head,
    *,
    ctx: ScreeningContext,
    replay: ReplayGuard,
    now_wall_ms: int,
) -> Refused | Screened:
    """Runs the stages that need a checked identifier: schema, ownership, replay, age, capability.

    Args:
        raw: The parsed JSON object.
        head: The identifiers and flags of the message.
        ctx: The robot's identity.
        replay: The replay memory.
        now_wall_ms: The current wall time, in milliseconds since the Unix epoch.

    Returns:
        `Refused` at the first failing stage, or `Screened`.
    """
    try:
        command = _COMMAND_ADAPTER.validate_python(raw, strict=True)
    except ValidationError as err:
        return _refused(head, "SCHEMA", "INVALID", error_paths=validation_paths(err))
    if command.robot_id != ctx.robot_id or command.site_id != ctx.site_id:
        return _refused(head, "OWN_IDS", "INVALID")
    if replay.seen_or_record(command.command_id):
        return _refused(head, "DUPLICATE", "DUPLICATE")
    age_ms = _age_ms(command.issued_at, now_wall_ms)
    if command.type != "ESTOP" and (age_ms is None or not _age_in_window(age_ms)):
        return _refused(head, "AGE", "EXPIRED", age_ms=age_ms)
    if command.type in UNSUPPORTED_COMMANDS:
        return _refused(head, "UNSUPPORTED", "INVALID")
    if command.type == "SIMULATE_FAULT" and not ctx.simulated:
        return _refused(head, "SIMULATED", "NOT_SIMULATED")
    return Screened(command=command, age_ms=age_ms, silent=head.silent)


def trigger_of(command: AnyCommand) -> CommandTrigger:
    """Returns the state machine trigger a command raises.

    Args:
        command: A command that passed screening.

    Returns:
        The trigger. A fault injection gives the trigger of its fault.

    Raises:
        TypeError: For DRIVE, which screening refuses as UNSUPPORTED and which never reaches the
            state machine.
    """
    if isinstance(command, SimulateFaultCommand):
        return SIMULATE_TRIGGER[command.params.fault]
    if isinstance(command, DriveCommand):
        raise TypeError("DRIVE has no trigger: screening refuses it as UNSUPPORTED")
    return command.type


def _parse_object(payload: bytes) -> dict[str, object] | None:
    """Decodes a payload as a JSON object, refusing duplicate keys and non-finite numbers.

    Duplicate keys are refused because two parsers can disagree on which one wins. NaN and
    Infinity are not JSON, and a parser that accepts them can carry them into a command.

    Args:
        payload: The raw bytes of the message.

    Returns:
        The object, or None if the bytes are not a JSON object.
    """
    try:
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_object_without_duplicates,
            parse_constant=_refuse_non_finite,
        )
    except (ValueError, RecursionError):
        return None
    if not isinstance(value, dict):
        return None
    return value


def _object_without_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Builds a JSON object, refusing a key that appears twice.

    Args:
        pairs: The key and value pairs in document order.

    Returns:
        The object.

    Raises:
        ValueError: If a key appears more than once.
    """
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _refuse_non_finite(_name: str) -> NoReturn:
    """Refuses the JSON constants NaN, Infinity and -Infinity.

    Args:
        _name: The constant as it appeared in the document. Not reported, to keep the text fixed.

    Raises:
        ValueError: Always.
    """
    raise ValueError("non-finite number")


def _read_identifiers(raw: dict[str, object]) -> tuple[str, str] | None:
    """Checks the command and correlation identifiers against their patterns, in strict mode.

    Args:
        raw: The parsed JSON object.

    Returns:
        The two identifiers, or None if either is missing or malformed.
    """
    try:
        command_id: str = _UUID_ADAPTER.validate_python(raw.get("commandId"), strict=True)
        correlation_id: str = _CORRELATION_ADAPTER.validate_python(
            raw.get("correlationId"), strict=True
        )
    except ValidationError:
        return None
    return command_id, correlation_id


def _loggable_type(value: object) -> str | None:
    """Returns the command type when it has the shape of a type name, for the log only.

    Args:
        value: The raw `type` member, untrusted.

    Returns:
        The type name, or None when the value is not a plain type name.
    """
    if isinstance(value, str) and _LOGGABLE_TYPE.fullmatch(value):
        return value
    return None


def _age_ms(issued_at: str, now_wall_ms: int) -> int | None:
    """Computes the age of a command from its issue time.

    The protocol pattern accepts year 0000, which the calendar does not, so a time that cannot be
    read gives None rather than an exception. The caller treats None as expired, except for a stop.

    Args:
        issued_at: The issue time, already checked against the protocol pattern.
        now_wall_ms: The current wall time, in milliseconds since the Unix epoch.

    Returns:
        The age in milliseconds, negative for a future time, or None if the time is unreadable.
    """
    try:
        return now_wall_ms - parse_iso_ms(issued_at)
    except ValueError:
        return None


def _age_in_window(age_ms: int) -> bool:
    """Tells whether an age is within the accepted window. Both bounds are inclusive.

    Args:
        age_ms: The age in milliseconds.

    Returns:
        True when the command is neither too old nor too far in the future.
    """
    return -COMMAND_MAX_FUTURE_SKEW_MS <= age_ms <= COMMAND_MAX_AGE_MS


def _refused(
    head: _Head,
    stage: Stage,
    reason: AckReason,
    *,
    error_paths: tuple[str, ...] = (),
    age_ms: int | None = None,
) -> Refused:
    """Builds a refusal from the message's identifiers.

    Args:
        head: The identifiers and flags of the message.
        stage: The stage that refused it.
        reason: The reason the answer carries.
        error_paths: The paths of failed schema fields, if any.
        age_ms: The command's age, if it was computed.

    Returns:
        The refusal.
    """
    return Refused(
        stage=stage,
        reason=reason,
        command_id=head.command_id,
        correlation_id=head.correlation_id,
        command_type=head.command_type,
        silent=head.silent,
        error_paths=error_paths,
        age_ms=age_ms,
    )
