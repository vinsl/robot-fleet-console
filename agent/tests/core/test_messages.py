"""Outbound messages: sequencing, validation against the mirror, topics, normalisation and size."""

from __future__ import annotations

import itertools
import json
import math
from collections.abc import Callable
from typing import Any

import pytest
from pydantic import TypeAdapter

from fleet_agent.core import messages
from fleet_agent.core.ids import uuid7
from fleet_agent.core.messages import MessageBuildError, MessageFactory, TelemetryFields
from fleet_agent.protocol.acks import Ack
from fleet_agent.protocol.events import RobotEvent
from fleet_agent.protocol.primitives import FaultCode, ReportedState
from fleet_agent.protocol.telemetry import Telemetry

from .fakes import FakeClock

BOOT_ID = "0190a7c4-0000-7000-8000-000000000001"
ROBOT_ID = "kali-01"
SITE_ID = "paris-01"
COMMAND_ID = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d"
CORRELATION_ID = "corr-0001-abcdef"
HOLDER = "user-sub-42"
_EVENT_ADAPTER = TypeAdapter(RobotEvent)
_ACK_ADAPTER = TypeAdapter(Ack)


def _id_source() -> Callable[[], str]:
    """Returns a source of valid, distinct UUIDv7 strings, so tests can pin the identifiers."""
    counter = itertools.count(1)

    def rand(count: int) -> bytes:
        return next(counter).to_bytes(count, "big")

    return lambda: uuid7(now_ms=1_793_613_600_000, rand=rand)


def _factory(clock: FakeClock | None = None) -> MessageFactory:
    """Creates a factory for the reference robot, with a fixed clock and pinned identifiers."""
    return MessageFactory(
        robot_id=ROBOT_ID,
        site_id=SITE_ID,
        boot_id=BOOT_ID,
        clock=clock or FakeClock(),
        new_id=_id_source(),
    )


def _telemetry_fields(
    *,
    x: float = 1.0,
    y: float = 2.0,
    heading: float = 0.5,
    state: ReportedState = "IDLE",
    battery: float = 80.0,
    speed: float = 0.0,
    mission_id: str | None = None,
    error_code: FaultCode | None = None,
) -> TelemetryFields:
    """Builds a telemetry value with valid defaults, overridden per test."""
    return TelemetryFields(
        x=x,
        y=y,
        heading=heading,
        state=state,
        battery=battery,
        speed=speed,
        mission_id=mission_id,
        error_code=error_code,
    )


def _decode(payload: bytes) -> dict[str, Any]:
    """Decodes a payload into a JSON object."""
    decoded: dict[str, Any] = json.loads(payload)
    return decoded


def test_last_seq_is_none_before_the_first_message() -> None:
    assert _factory().last_seq is None


def test_sequence_is_shared_across_kinds_and_increments_by_one() -> None:
    factory = _factory()

    seqs = [
        factory.boot(agent_version="0.1.0", simulated=True, state="IDLE").seq,
        factory.telemetry(_telemetry_fields()).seq,
        factory.heartbeat(state="IDLE", battery=80.0).seq,
        factory.ack(
            command_id=COMMAND_ID,
            correlation_id=CORRELATION_ID,
            state="IDLE",
            result="ACK",
            reason=None,
        ).seq,
    ]

    assert seqs == [0, 1, 2, 3]
    assert factory.last_seq == 3


def test_a_refused_message_still_consumes_its_sequence_number() -> None:
    factory = _factory()

    with pytest.raises(MessageBuildError):
        factory.lock_held(holder="not a valid holder!", cause="ACQUIRED")
    next_message = factory.heartbeat(state="IDLE", battery=80.0)

    assert next_message.seq == 1


def test_boot_identifier_is_exposed() -> None:
    assert _factory().boot_id == BOOT_ID


def test_topics_and_qos_follow_the_specification() -> None:
    factory = _factory()

    telemetry = factory.telemetry(_telemetry_fields())
    event = factory.heartbeat(state="IDLE", battery=80.0)
    ack = factory.ack(
        command_id=COMMAND_ID,
        correlation_id=CORRELATION_ID,
        state="IDLE",
        result="ACK",
        reason=None,
    )

    assert telemetry.topic == "$aws/rules/mfc_demo_telemetry/fleet/paris-01/kali-01/telemetry"
    assert telemetry.qos == 0
    assert event.topic == "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/events"
    assert event.qos == 1
    assert ack.topic == "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack"
    assert ack.qos == 1


def test_kinds_and_labels_identify_each_message() -> None:
    factory = _factory()

    telemetry = factory.telemetry(_telemetry_fields())
    state = factory.state_changed(
        from_state="IDLE", to_state="PAUSED", cause="PAUSE", command_id=COMMAND_ID
    )

    assert (telemetry.kind, telemetry.label) == ("telemetry", "TELEMETRY")
    assert (state.kind, state.label) == ("event", "STATE_CHANGED")


@pytest.mark.parametrize(
    ("build", "model"),
    [
        pytest.param(lambda f: f.telemetry(_telemetry_fields()), "telemetry", id="telemetry"),
        pytest.param(
            lambda f: f.boot(agent_version="0.1.0", simulated=True, state="IDLE"),
            "event",
            id="boot",
        ),
        pytest.param(
            lambda f: f.state_changed(
                from_state="IDLE", to_state="PAUSED", cause="PAUSE", command_id=COMMAND_ID
            ),
            "event",
            id="state-changed",
        ),
        pytest.param(lambda f: f.heartbeat(state="IDLE", battery=80.0), "event", id="heartbeat"),
        pytest.param(lambda f: f.fault_raised("OBSTACLE"), "event", id="fault-raised"),
        pytest.param(lambda f: f.fault_cleared("OBSTACLE"), "event", id="fault-cleared"),
        pytest.param(
            lambda f: f.lock_held(holder=HOLDER, cause="ACQUIRED"), "event", id="lock-held"
        ),
        pytest.param(lambda f: f.lock_free(cause="EXPIRED"), "event", id="lock-free"),
        pytest.param(lambda f: f.going_offline(), "event", id="going-offline"),
        pytest.param(
            lambda f: f.ack(
                command_id=COMMAND_ID,
                correlation_id=CORRELATION_ID,
                state="PAUSED",
                result="ACK",
                reason=None,
            ),
            "ack",
            id="ack",
        ),
    ],
)
def test_every_builder_payload_validates_against_its_protocol_model(
    build: Callable[[MessageFactory], messages.OutboundMessage], model: str
) -> None:
    message = build(_factory())

    if model == "telemetry":
        Telemetry.model_validate_json(message.payload)
    elif model == "event":
        _EVENT_ADAPTER.validate_json(message.payload)
    else:
        _ACK_ADAPTER.validate_json(message.payload)
    assert "null" not in message.payload.decode("utf-8")


def test_absent_optional_fields_are_omitted_not_sent_as_null() -> None:
    message = _factory().telemetry(_telemetry_fields(mission_id=None, error_code=None))

    decoded = _decode(message.payload)

    assert "missionId" not in decoded
    assert "errorCode" not in decoded


def test_present_optional_fields_are_sent() -> None:
    message = _factory().telemetry(_telemetry_fields(mission_id="mission-7", error_code="OBSTACLE"))

    decoded = _decode(message.payload)

    assert decoded["missionId"] == "mission-7"
    assert decoded["errorCode"] == "OBSTACLE"


def test_state_changed_carries_the_origin_under_the_from_key() -> None:
    message = _factory().state_changed(
        from_state="IDLE", to_state="PAUSED", cause="PAUSE", command_id=COMMAND_ID
    )

    decoded = _decode(message.payload)

    assert decoded["from"] == "IDLE"
    assert decoded["to"] == "PAUSED"
    assert "fromState" not in decoded


def test_state_changed_without_a_command_omits_the_command_id() -> None:
    message = _factory().state_changed(
        from_state="MOVING", to_state="CHARGING", cause="ARRIVED", command_id=None
    )

    assert "commandId" not in _decode(message.payload)


@pytest.mark.parametrize(
    ("heading", "expected"),
    [(1.5 * math.pi, -0.5 * math.pi), (5.0, 5.0 - 2.0 * math.pi), (0.25, 0.25)],
    ids=["wraps-down", "wraps-into-range", "unchanged"],
)
def test_heading_is_normalised_into_minus_pi_to_pi(heading: float, expected: float) -> None:
    message = _factory().telemetry(_telemetry_fields(heading=heading))

    assert _decode(message.payload)["heading"] == pytest.approx(expected)


@pytest.mark.parametrize(("battery", "expected"), [(120.0, 100.0), (-5.0, 0.0)])
def test_battery_is_clamped_to_the_protocol_range(battery: float, expected: float) -> None:
    message = _factory().telemetry(_telemetry_fields(battery=battery))

    assert _decode(message.payload)["battery"] == expected


def test_a_nan_pose_is_refused_with_its_path_and_no_value() -> None:
    factory = _factory()

    with pytest.raises(MessageBuildError) as caught:
        factory.telemetry(_telemetry_fields(x=math.nan))

    assert caught.value.paths == ("x",)
    assert str(caught.value) == "message failed its schema"


def test_a_payload_over_the_size_cap_is_refused_without_any_value_in_the_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The protocol bounds keep every real message far below the cap, so the cap is lowered here
    # to exercise the refusal path itself.
    monkeypatch.setattr(messages, "MAX_MQTT_PAYLOAD_BYTES", 16)

    with pytest.raises(MessageBuildError) as caught:
        _factory().heartbeat(state="IDLE", battery=80.0)

    assert caught.value.paths == ("payload",)
    assert str(caught.value) == "message failed its schema"


def test_a_reject_carries_its_reason() -> None:
    message = _factory().ack(
        command_id=COMMAND_ID,
        correlation_id=CORRELATION_ID,
        state="PAUSED",
        result="REJECT",
        reason="NOT_LOCK_HOLDER",
    )

    decoded = _decode(message.payload)

    assert decoded["result"] == "REJECT"
    assert decoded["reason"] == "NOT_LOCK_HOLDER"


def test_an_ack_carries_no_reason_and_echoes_the_correlation_identifier() -> None:
    message = _factory().ack(
        command_id=COMMAND_ID,
        correlation_id=CORRELATION_ID,
        state="PAUSED",
        result="ACK",
        reason=None,
    )

    decoded = _decode(message.payload)

    assert decoded["result"] == "ACK"
    assert "reason" not in decoded
    assert decoded["correlationId"] == CORRELATION_ID


def test_a_reject_without_a_reason_is_refused() -> None:
    with pytest.raises(MessageBuildError) as caught:
        _factory().ack(
            command_id=COMMAND_ID,
            correlation_id=CORRELATION_ID,
            state="PAUSED",
            result="REJECT",
            reason=None,
        )

    assert caught.value.paths == ("REJECT.reason",)


def test_an_ack_with_a_reason_is_refused() -> None:
    with pytest.raises(MessageBuildError) as caught:
        _factory().ack(
            command_id=COMMAND_ID,
            correlation_id=CORRELATION_ID,
            state="PAUSED",
            result="ACK",
            reason="INVALID",
        )

    assert caught.value.paths == ("ACK.reason",)


def test_the_ack_robot_timestamp_is_the_envelope_timestamp() -> None:
    message = _factory().ack(
        command_id=COMMAND_ID,
        correlation_id=CORRELATION_ID,
        state="PAUSED",
        result="ACK",
        reason=None,
    )

    decoded = _decode(message.payload)

    assert decoded["robotTs"] == decoded["ts"] == "2026-11-02T10:00:00.000Z"


def test_the_envelope_carries_the_identity_and_the_boot() -> None:
    message = _factory().boot(agent_version="0.1.0", simulated=True, state="IDLE")

    decoded = _decode(message.payload)

    assert decoded["robotId"] == ROBOT_ID
    assert decoded["siteId"] == SITE_ID
    assert decoded["bootId"] == BOOT_ID
    assert decoded["schemaVersion"] == "1.0.0"
    assert decoded["agentVersion"] == "0.1.0"
    assert decoded["simulated"] is True


def test_lock_free_names_no_holder() -> None:
    decoded = _decode(_factory().lock_free(cause="RELEASED").payload)

    assert decoded["held"] is False
    assert "holder" not in decoded


def test_lock_held_names_the_holder_and_the_cause() -> None:
    decoded = _decode(_factory().lock_held(holder=HOLDER, cause="TAKEOVER").payload)

    assert decoded["held"] is True
    assert decoded["holder"] == HOLDER
    assert decoded["cause"] == "TAKEOVER"


def test_a_refused_holder_is_reported_by_path_and_its_value_is_not_in_the_error() -> None:
    with pytest.raises(MessageBuildError) as caught:
        _factory().lock_held(holder="bad holder value!", cause="ACQUIRED")

    assert caught.value.paths == ("holder",)
    assert "bad holder value" not in str(caught.value)
    assert "bad holder value" not in " ".join(caught.value.paths)


def test_going_offline_states_the_shutdown_reason() -> None:
    decoded = _decode(_factory().going_offline().payload)

    assert decoded == {
        "schemaVersion": "1.0.0",
        "messageId": decoded["messageId"],
        "robotId": ROBOT_ID,
        "siteId": SITE_ID,
        "ts": "2026-11-02T10:00:00.000Z",
        "seq": 0,
        "bootId": BOOT_ID,
        "kind": "GOING_OFFLINE",
        "reason": "SHUTDOWN",
    }


def test_message_identifier_is_the_one_the_source_gave() -> None:
    factory = MessageFactory(
        robot_id=ROBOT_ID,
        site_id=SITE_ID,
        boot_id=BOOT_ID,
        clock=FakeClock(),
        new_id=lambda: "0190a7c4-0000-7000-8000-00000000abcd",
    )

    message = factory.heartbeat(state="IDLE", battery=80.0)

    assert message.message_id == "0190a7c4-0000-7000-8000-00000000abcd"
    assert _decode(message.payload)["messageId"] == message.message_id


def test_an_identifier_outside_the_topic_grammar_is_refused_at_construction() -> None:
    with pytest.raises(TypeError):
        MessageFactory(
            robot_id="Kali_01",
            site_id=SITE_ID,
            boot_id=BOOT_ID,
            clock=FakeClock(),
        )
