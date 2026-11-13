"""Screening: one test per stage, the precedence between stages, and the silent heartbeat.

The denied-access tests are named so that the security checklist can cite them. Each one asserts
the outcome a denied command must get: no answer for a message that cannot be attributed, and a
REJECT with its reason for one that can.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import pytest
from pydantic import TypeAdapter

from fleet_agent.core.replay import ReplayGuard
from fleet_agent.core.screening import (
    Dropped,
    Refused,
    Screened,
    ScreeningContext,
    screen_command,
    trigger_of,
)
from fleet_agent.protocol.commands import Command, DriveCommand
from fleet_agent.protocol.constants import COMMAND_MAX_AGE_MS, COMMAND_MAX_FUTURE_SKEW_MS
from fleet_agent.protocol.topics import command_topic

from .fakes import COMMAND_TOPIC, ROBOT_ID, SCREENING, SITE_ID, WALL_ORIGIN_MS, make_command

Body = dict[str, object]

SIMULATOR = ScreeningContext(
    robot_id=ROBOT_ID,
    site_id=SITE_ID,
    simulated=True,
    command_topic=COMMAND_TOPIC,
)
LEAK_PROBE = "probe-value-42"
"""A value no refusal may ever carry. Its absence is asserted on every schema refusal."""
LOCK_TOKEN_VALUE = "lock-token-0123456789abcdef"  # noqa: S105 - a fixed fake token, not a credential


def _payload(body: Body) -> bytes:
    """Serialises a command body as the UTF-8 JSON the broker delivers."""
    return json.dumps(body).encode("utf-8")


def _screen(
    body: Body | bytes,
    *,
    ctx: ScreeningContext = SCREENING,
    replay: ReplayGuard | None = None,
    topic: str = COMMAND_TOPIC,
    now_wall_ms: int = WALL_ORIGIN_MS,
) -> Dropped | Refused | Screened:
    """Screens one message, with a fresh replay memory unless the test passes one."""
    payload = body if isinstance(body, bytes) else _payload(body)
    return screen_command(
        topic,
        payload,
        ctx=ctx,
        replay=replay if replay is not None else ReplayGuard(),
        now_wall_ms=now_wall_ms,
    )


def _refused(result: Dropped | Refused | Screened) -> Refused:
    """Asserts that the result is a refusal, and returns it narrowed."""
    assert isinstance(result, Refused), f"expected a refusal, got {type(result).__name__}"
    return result


def test_a_valid_command_passes_every_stage() -> None:
    result = _screen(make_command("PAUSE"))

    assert isinstance(result, Screened)
    assert result.age_ms == 0
    assert result.silent is False
    assert result.command.type == "PAUSE"


@pytest.mark.parametrize(
    ("payload", "stage"),
    [
        pytest.param(
            json.dumps(make_command("PAUSE")).encode("utf-8") + b" " * 4096,
            "SIZE",
            id="oversize-valid-json",
        ),
        pytest.param(b"\xff\xfe\x00not utf-8", "PARSE", id="not-utf-8"),
        pytest.param(b"{not json", "PARSE", id="not-json"),
        pytest.param(b"[]", "PARSE", id="json-array"),
        pytest.param(b'"just a string"', "PARSE", id="json-string"),
        pytest.param(b'{"type":"PAUSE","type":"PAUSE"}', "PARSE", id="duplicate-key"),
        pytest.param(b'{"x": NaN}', "PARSE", id="nan"),
        pytest.param(b'{"x": Infinity}', "PARSE", id="infinity"),
        pytest.param(b"[" * 4000, "PARSE", id="deep-nesting"),
    ],
)
def test_drops_oversize_and_unparseable_without_ack(payload: bytes, stage: str) -> None:
    result = _screen(payload)

    assert isinstance(result, Dropped)
    assert result.stage == stage
    assert result.size_bytes == len(payload)


def test_a_payload_of_exactly_the_cap_is_not_dropped_for_size() -> None:
    body = make_command("PAUSE")
    payload = _payload(body) + b" " * (4096 - len(_payload(body)))

    result = _screen(payload)

    assert isinstance(result, Screened)


def test_a_message_on_another_topic_is_dropped_without_ack() -> None:
    result = _screen(make_command("PAUSE"), topic=command_topic(SITE_ID, "sim-99"))

    assert isinstance(result, Dropped)
    assert result.stage == "TOPIC"


@pytest.mark.parametrize(
    "mutation",
    [
        pytest.param(lambda body: body.pop("commandId"), id="missing-command-id"),
        pytest.param(
            lambda body: body.update(commandId=str(body["commandId"]).upper()),
            id="uppercase-command-id",
        ),
        pytest.param(lambda body: body.update(correlationId="x"), id="short-correlation-id"),
        pytest.param(lambda body: body.update(commandId=7), id="numeric-command-id"),
    ],
)
def test_malformed_identifiers_are_dropped_without_ack(
    mutation: Callable[[Body], object],
) -> None:
    body = make_command("PAUSE")
    mutation(body)

    result = _screen(body)

    assert isinstance(result, Dropped)
    assert result.stage == "IDS"


def test_a_schema_failure_is_refused_with_paths_and_no_input_value() -> None:
    body = make_command("PAUSE", probeField=LEAK_PROBE)

    refused = _refused(_screen(body))

    assert refused.stage == "SCHEMA"
    assert refused.reason == "INVALID"
    assert refused.command_type == "PAUSE"
    assert refused.error_paths == ("PAUSE.probeField",)
    assert LEAK_PROBE not in repr(refused)


def test_an_extra_parameter_is_a_schema_refusal() -> None:
    refused = _refused(_screen(make_command("PAUSE", params={"speed": 9})))

    assert refused.stage == "SCHEMA"
    assert refused.error_paths == ("PAUSE.params.speed",)


def test_a_major_version_two_is_a_schema_refusal() -> None:
    refused = _refused(_screen(make_command("PAUSE", schemaVersion="2.0.0")))

    assert refused.stage == "SCHEMA"
    assert refused.error_paths == ("PAUSE.schemaVersion",)


@pytest.mark.parametrize(
    "command_type",
    [
        pytest.param("pause", id="lowercase"),
        pytest.param("P" * 40, id="longer-than-the-log-shape"),
        pytest.param(7, id="not-a-string"),
    ],
)
def test_an_unloggable_command_type_is_refused_and_not_echoed(command_type: object) -> None:
    body = make_command("PAUSE", type=command_type)

    refused = _refused(_screen(body))

    assert refused.stage == "SCHEMA"
    assert refused.command_type is None


def test_a_sequence_number_is_refused_because_commands_carry_none() -> None:
    refused = _refused(_screen(make_command("PAUSE", seq=3)))

    assert refused.stage == "SCHEMA"
    assert refused.error_paths == ("PAUSE.seq",)


def test_refuses_command_for_another_robot() -> None:
    refused = _refused(_screen(make_command("PAUSE", robotId="sim-99")))

    assert refused.stage == "OWN_IDS"
    assert refused.reason == "INVALID"


def test_refuses_command_for_another_site() -> None:
    refused = _refused(_screen(make_command("PAUSE", siteId="lyon-01")))

    assert refused.stage == "OWN_IDS"
    assert refused.reason == "INVALID"


def test_refuses_replayed_command() -> None:
    replay = ReplayGuard()
    body = make_command("PAUSE")
    first = _screen(body, replay=replay)

    second = _refused(_screen(body, replay=replay))

    assert isinstance(first, Screened)
    assert second.stage == "DUPLICATE"
    assert second.reason == "DUPLICATE"


def test_a_schema_refused_identifier_is_not_recorded_as_seen() -> None:
    replay = ReplayGuard()
    body = make_command("PAUSE")
    refused_first = _refused(_screen({**body, "extra": 1}, replay=replay))

    accepted_later = _screen(body, replay=replay)

    assert refused_first.stage == "SCHEMA"
    assert isinstance(accepted_later, Screened)


def test_an_identifier_of_another_robot_is_not_recorded_as_seen() -> None:
    replay = ReplayGuard()
    body = make_command("PAUSE")
    _refused(_screen({**body, "robotId": "sim-99"}, replay=replay))

    accepted_later = _screen(body, replay=replay)

    assert isinstance(accepted_later, Screened)


@pytest.mark.parametrize(
    ("age_ms", "accepted"),
    [
        pytest.param(COMMAND_MAX_AGE_MS, True, id="oldest-accepted"),
        pytest.param(COMMAND_MAX_AGE_MS + 1, False, id="too-old"),
        pytest.param(-COMMAND_MAX_FUTURE_SKEW_MS, True, id="most-future-accepted"),
        pytest.param(-COMMAND_MAX_FUTURE_SKEW_MS - 1, False, id="too-far-future"),
    ],
)
def test_refuses_expired_command(age_ms: int, accepted: bool) -> None:
    body = make_command("PAUSE", wall_ms=WALL_ORIGIN_MS - age_ms)

    result = _screen(body)

    if accepted:
        assert isinstance(result, Screened)
        assert result.age_ms == age_ms
    else:
        refused = _refused(result)
        assert refused.stage == "AGE"
        assert refused.reason == "EXPIRED"
        assert refused.age_ms == age_ms


def test_an_emergency_stop_older_than_the_window_is_still_accepted() -> None:
    result = _screen(make_command("ESTOP", wall_ms=WALL_ORIGIN_MS - 60_000))

    assert isinstance(result, Screened)
    assert result.age_ms == 60_000


def test_an_unreadable_issue_time_is_expired_but_a_stop_is_accepted() -> None:
    # The protocol pattern accepts year 0000, which the calendar does not have.
    year_zero = "0000-02-29T00:00:00.000Z"

    expired = _refused(_screen(make_command("PAUSE", issuedAt=year_zero)))
    stop = _screen(make_command("ESTOP", issuedAt=year_zero))

    assert (expired.stage, expired.reason, expired.age_ms) == ("AGE", "EXPIRED", None)
    assert isinstance(stop, Screened)
    assert stop.age_ms is None


def test_the_topic_is_checked_before_the_payload_is_parsed() -> None:
    result = _screen(b"{not json", topic=command_topic(SITE_ID, "sim-99"))

    assert isinstance(result, Dropped)
    assert result.stage == "TOPIC"


def _without_command_id() -> Body:
    """A command missing its identifier, with an extra field that would also fail the schema."""
    body = make_command("PAUSE", extra=1)
    body.pop("commandId")
    return body


@pytest.mark.parametrize(
    ("expected_stage", "make_body", "prerecord_id"),
    [
        pytest.param("IDS", _without_command_id, False, id="ids-before-schema"),
        pytest.param(
            "SCHEMA",
            lambda: make_command("PAUSE", robotId="sim-99", extra=1),
            False,
            id="schema-before-own-ids",
        ),
        pytest.param(
            "OWN_IDS",
            lambda: make_command("PAUSE", robotId="sim-99", wall_ms=WALL_ORIGIN_MS - 9000),
            False,
            id="own-ids-before-age",
        ),
        pytest.param(
            "OWN_IDS",
            lambda: make_command("PAUSE", robotId="sim-99"),
            True,
            id="own-ids-before-duplicate",
        ),
        pytest.param(
            "DUPLICATE",
            lambda: make_command("PAUSE", wall_ms=WALL_ORIGIN_MS - 9000),
            True,
            id="duplicate-before-age",
        ),
        pytest.param(
            "AGE",
            lambda: make_command("DRIVE", wall_ms=WALL_ORIGIN_MS - 9000),
            False,
            id="age-before-unsupported",
        ),
    ],
)
def test_the_first_failing_stage_decides(
    expected_stage: str, make_body: Callable[[], Body], prerecord_id: bool
) -> None:
    body = make_body()
    replay = ReplayGuard()
    if prerecord_id:
        replay.seen_or_record(str(body["commandId"]))

    result = _screen(body, replay=replay)

    assert not isinstance(result, Screened)
    assert result.stage == expected_stage


def test_drive_is_refused_as_invalid_because_the_robot_never_builds_it() -> None:
    refused = _refused(_screen(make_command("DRIVE")))

    assert refused.stage == "UNSUPPORTED"
    assert refused.reason == "INVALID"


def test_refuses_fault_injection_on_real_robot() -> None:
    refused = _refused(_screen(make_command("SIMULATE_FAULT", params={"fault": "OBSTACLE"})))

    assert refused.stage == "SIMULATED"
    assert refused.reason == "NOT_SIMULATED"


def test_fault_injection_on_a_simulator_is_screened() -> None:
    body = make_command("SIMULATE_FAULT", params={"fault": "LINK_LOSS", "durationS": 5})

    result = _screen(body, ctx=SIMULATOR)

    assert isinstance(result, Screened)
    assert trigger_of(result.command) == "SIMULATE_FAULT:LINK_LOSS"


@pytest.mark.parametrize(
    ("stage", "make_body"),
    [
        pytest.param("SCHEMA", lambda: make_command("HEARTBEAT", extra=1), id="schema"),
        pytest.param("OWN_IDS", lambda: make_command("HEARTBEAT", robotId="sim-99"), id="own-ids"),
        pytest.param(
            "AGE",
            lambda: make_command("HEARTBEAT", wall_ms=WALL_ORIGIN_MS - COMMAND_MAX_AGE_MS - 1),
            id="age",
        ),
    ],
)
def test_a_heartbeat_refused_at_any_stage_is_silent(
    stage: str, make_body: Callable[[], Body]
) -> None:
    refused = _refused(_screen(make_body()))

    assert refused.stage == stage
    assert refused.silent is True


def test_a_heartbeat_refused_as_a_duplicate_is_silent() -> None:
    replay = ReplayGuard()
    body = make_command("HEARTBEAT")
    _screen(body, replay=replay)

    refused = _refused(_screen(body, replay=replay))

    assert refused.stage == "DUPLICATE"
    assert refused.silent is True


def test_a_command_refused_at_the_same_stage_is_not_silent() -> None:
    refused = _refused(_screen(make_command("PAUSE", robotId="sim-99")))

    assert refused.silent is False


def test_an_accepted_heartbeat_is_screened_and_flagged_silent() -> None:
    result = _screen(make_command("HEARTBEAT"))

    assert isinstance(result, Screened)
    assert result.silent is True


def test_a_refusal_echoes_the_identifiers_it_was_checked_against() -> None:
    body = make_command("PAUSE", extra=1, correlationId="corr-abcdef12")

    refused = _refused(_screen(body))

    assert refused.correlation_id == "corr-abcdef12"
    assert refused.command_id == body["commandId"]


@pytest.mark.parametrize(
    "command_type",
    ["PAUSE", "RESUME", "RETURN_TO_BASE", "ESTOP", "ESTOP_RELEASE", "RELEASE_CONTROL", "HEARTBEAT"],
)
def test_each_command_raises_the_trigger_of_its_name(command_type: str) -> None:
    result = _screen(make_command(command_type, lockToken=LOCK_TOKEN_VALUE))

    assert isinstance(result, Screened)
    assert trigger_of(result.command) == command_type


def test_take_control_raises_its_trigger_with_the_required_token() -> None:
    result = _screen(make_command("TAKE_CONTROL", lockToken=LOCK_TOKEN_VALUE))

    assert isinstance(result, Screened)
    assert trigger_of(result.command) == "TAKE_CONTROL"


def test_drive_has_no_trigger_because_it_never_reaches_the_state_machine() -> None:
    drive = TypeAdapter(Command).validate_python(make_command("DRIVE"))

    assert isinstance(drive, DriveCommand)
    with pytest.raises(TypeError):
        trigger_of(drive)
