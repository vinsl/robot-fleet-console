"""Tests of the application: host, origin and fetch-site checks, the claim, the protected routes,
the status and session bodies, the rate limit, and the structure that keeps the page away from
the robot's commands.
"""

from __future__ import annotations

import ast
import inspect
import json
from pathlib import Path

import pytest

from fleet_agent.protocol.robot_video import VideoSession, VideoStatus
from fleet_agent.video import app as app_module
from fleet_agent.video.app import VideoApp
from fleet_agent.video.claim import ClaimGate
from fleet_agent.video.credentials import CredentialsKeeper
from fleet_agent.video.http_server import Request, Response
from tests.video.support import (
    BEARER,
    HOST_HEADER,
    TOKEN,
    FakeSource,
    api_headers,
    build_app,
    claim_body,
    freeze_rate_clock,
    ready_keeper,
    snapshot_of,
    valid_credentials,
)

_PEER = "127.0.0.1"
_CLAIM_URN = "urn:mfc:problem:"


def _get(target: str, headers: dict[str, str]) -> Request:
    """Builds a GET request from the loopback peer.

    Args:
        target: The request target.
        headers: The header fields, by lowercase name.

    Returns:
        The request.
    """
    return Request("GET", target, headers, b"", _PEER)


def _post_claim(body: bytes, headers: dict[str, str] | None = None) -> Request:
    """Builds a claim POST from the loopback peer.

    Args:
        body: The raw body.
        headers: The header fields. The well-formed set is used when omitted.

    Returns:
        The request.
    """
    return Request("POST", "/api/claim", headers or api_headers(), body, _PEER)


def _problem_type(response: Response) -> str:
    """Reads the problem type of a response body.

    Args:
        response: A problem response.

    Returns:
        The type URN.
    """
    document: dict[str, str] = json.loads(response.body)
    return document["type"]


async def _app_with_keeper(tmp_path: Path, **kwargs: object) -> tuple[VideoApp, ClaimGate]:
    """Builds an application whose keeper already holds credentials.

    Args:
        tmp_path: The test's temporary directory.
        **kwargs: Extra arguments for `build_app`.

    Returns:
        The application and its claim gate.
    """
    keeper = await ready_keeper(FakeSource(valid_credentials()))
    return build_app(tmp_path, keeper=keeper, **kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "host",
    ["evil.example", "localhost:49152", "127.0.0.1", "127.0.0.1:1", ""],
)
async def test_a_host_other_than_the_loopback_address_and_port_is_refused(
    tmp_path: Path, host: str
) -> None:
    app, _gate = await _app_with_keeper(tmp_path)

    response = await app.handle(_get("/", {"host": host}))

    assert response.status == 400
    assert _problem_type(response) == _CLAIM_URN + "host-refused"


async def test_a_claim_without_or_with_a_foreign_origin_is_refused_and_keeps_the_token(
    tmp_path: Path,
) -> None:
    app, gate = await _app_with_keeper(tmp_path)
    body = claim_body(TOKEN)
    refused = [
        await app.handle(_post_claim(body, api_headers(origin=False))),
        await app.handle(_post_claim(body, {**api_headers(), "origin": "http://evil.example"})),
        await app.handle(_post_claim(body, {**api_headers(), "origin": "http://localhost:49152"})),
    ]

    assert [response.status for response in refused] == [403, 403, 403]
    granted = await app.handle(_post_claim(body))
    assert granted.status == 200
    assert gate.phase == "CLAIMED"


async def test_a_claim_with_the_wrong_body_shape_is_refused_and_keeps_the_token(
    tmp_path: Path,
) -> None:
    app, gate = await _app_with_keeper(tmp_path)
    form = {**api_headers(), "content-type": "application/x-www-form-urlencoded"}
    with_charset = {**api_headers(), "content-type": "application/json; charset=utf-8"}
    text = {**api_headers(), "content-type": "text/plain"}
    extra_key = json.dumps({"claim": TOKEN, "extra": 1}).encode("ascii")
    too_big = b'{"claim":"' + b"x" * 510 + b'"}'

    responses = [
        await app.handle(_post_claim(claim_body(TOKEN), form)),
        await app.handle(_post_claim(claim_body(TOKEN), with_charset)),
        await app.handle(_post_claim(claim_body(TOKEN), text)),
        await app.handle(_post_claim(extra_key)),
        await app.handle(_post_claim(too_big)),
        await app.handle(_post_claim(b"")),
    ]

    assert [response.status for response in responses] == [400, 400, 400, 400, 413, 400]
    assert gate.phase == "OPEN"
    assert (await app.handle(_post_claim(claim_body(TOKEN)))).status == 200


async def test_any_request_with_cross_site_fetch_metadata_is_refused(tmp_path: Path) -> None:
    app, _gate = await _app_with_keeper(tmp_path)
    cross = {"host": HOST_HEADER, "sec-fetch-site": "cross-site"}
    claim_headers = {**api_headers(), "sec-fetch-site": "cross-site"}

    responses = [
        await app.handle(_get("/", cross)),
        await app.handle(_get("/api/status", {**cross, "authorization": BEARER})),
        await app.handle(_post_claim(claim_body(TOKEN), claim_headers)),
    ]

    assert [response.status for response in responses] == [403, 403, 403]
    assert all(
        _problem_type(response) == _CLAIM_URN + "fetch-site-refused" for response in responses
    )


async def test_the_none_fetch_site_is_accepted_for_the_index_page_only(tmp_path: Path) -> None:
    app, _gate = await _app_with_keeper(tmp_path)

    index = await app.handle(_get("/", {"host": HOST_HEADER, "sec-fetch-site": "none"}))
    status = await app.handle(_get("/api/status", {"host": HOST_HEADER, "sec-fetch-site": "none"}))

    assert index.status == 200
    assert status.status == 403


async def test_session_and_status_without_or_with_a_wrong_bearer_are_unauthorised(
    tmp_path: Path,
) -> None:
    app, _gate = await _app_with_keeper(tmp_path)
    await app.handle(_post_claim(claim_body(TOKEN)))
    wrong = {"host": HOST_HEADER, "authorization": f"Bearer {'Z' * 43}"}

    denied = [
        await app.handle(_get("/api/session", {"host": HOST_HEADER})),
        await app.handle(_get("/api/status", {"host": HOST_HEADER})),
        await app.handle(_get("/api/session", wrong)),
        await app.handle(_get("/api/status", wrong)),
    ]

    assert [response.status for response in denied] == [401, 401, 401, 401]
    assert all(response.headers["WWW-Authenticate"] == "Bearer" for response in denied)
    assert all(_problem_type(r) == _CLAIM_URN + "unauthorised" for r in denied)


async def test_session_and_status_with_the_right_bearer_return_the_protocol_bodies(
    tmp_path: Path,
) -> None:
    app, _gate = await _app_with_keeper(tmp_path)
    await app.handle(_post_claim(claim_body(TOKEN)))
    headers = {"host": HOST_HEADER, "authorization": BEARER}

    status = await app.handle(_get("/api/status", headers))
    session = await app.handle(_get("/api/session", headers))

    assert status.status == 200
    assert session.status == 200
    VideoStatus.model_validate_json(status.body)
    VideoSession.model_validate_json(session.body)


async def test_session_without_held_credentials_is_503_with_retry_after(tmp_path: Path) -> None:
    keeper = CredentialsKeeper(FakeSource())
    app, _gate = build_app(tmp_path, keeper=keeper)
    await app.handle(_post_claim(claim_body(TOKEN)))

    response = await app.handle(
        _get("/api/session", {"host": HOST_HEADER, "authorization": BEARER})
    )

    assert response.status == 503
    assert response.headers["Retry-After"] == "5"
    assert _problem_type(response) == _CLAIM_URN + "credentials-unavailable"


async def test_status_reports_the_snapshot_in_camel_case_and_503_without_one(
    tmp_path: Path,
) -> None:
    snapshot = snapshot_of(state="ESTOP", banner="ESTOP", lock_held=True, connected=False)
    app, _gate = await _app_with_keeper(tmp_path, snapshot=lambda: snapshot)
    await app.handle(_post_claim(claim_body(TOKEN)))
    headers = {"host": HOST_HEADER, "authorization": BEARER}

    response = await app.handle(_get("/api/status", headers))

    assert json.loads(response.body) == {
        "state": "ESTOP",
        "banner": "ESTOP",
        "lockHeld": True,
        "connected": False,
        "simulated": False,
    }

    gone_app, _gone_gate = await _app_with_keeper(tmp_path / "gone", snapshot=lambda: None)
    await gone_app.handle(_post_claim(claim_body(TOKEN)))
    missing = await gone_app.handle(_get("/api/status", headers))
    assert missing.status == 503
    assert _problem_type(missing) == _CLAIM_URN + "agent-unavailable"


async def test_the_session_names_the_robots_own_channel_and_the_keepers_credentials(
    tmp_path: Path,
) -> None:
    keeper = await ready_keeper(FakeSource(valid_credentials()))
    app, _gate = build_app(tmp_path, keeper=keeper)
    await app.handle(_post_claim(claim_body(TOKEN)))

    response = await app.handle(
        _get("/api/session", {"host": HOST_HEADER, "authorization": BEARER})
    )
    session = VideoSession.model_validate_json(response.body)

    assert session.channel_name == "mfc-demo-kali-01"
    assert session.channel_arn.endswith("channel/mfc-demo-kali-01/1700000000000")
    assert session.credentials == keeper.current()


async def test_the_rate_limit_answers_429_with_retry_after_on_the_sixty_first_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    freeze_rate_clock(monkeypatch)
    app, _gate = await _app_with_keeper(tmp_path)
    request = _get("/", {"host": HOST_HEADER})

    statuses = [(await app.handle(request)).status for _ in range(61)]

    assert statuses[:60] == [200] * 60
    assert statuses[60] == 429
    limited = await app.handle(request)
    assert limited.headers["Retry-After"] == "1"


async def test_repeated_rate_refusals_are_logged_once_within_the_interval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    freeze_rate_clock(monkeypatch)
    events: list[tuple[str, dict[str, object]]] = []
    app, _gate = await _app_with_keeper(tmp_path, events=events)
    request = _get("/", {"host": HOST_HEADER})

    for _ in range(70):
        await app.handle(request)

    rate_lines = [fields for event, fields in events if fields.get("reason") == "RATE"]
    assert len(rate_lines) == 1


def test_the_application_takes_no_core_type_in_its_constructor() -> None:
    parameters = inspect.signature(VideoApp.__init__).parameters
    annotations = " ".join(str(p.annotation) for p in parameters.values())

    for forbidden in ("AgentCore", "Transport", "Link"):
        assert forbidden not in annotations


def test_the_application_imports_neither_the_core_agent_nor_the_transport() -> None:
    source = Path(app_module.__file__).read_text(encoding="utf-8")
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)

    assert "fleet_agent.core.agent" not in imported
    assert "fleet_agent.core.ports" not in imported
    assert "fleet_agent.adapters.mqtt_crt" not in imported


async def test_the_answered_routes_are_exactly_the_five_of_the_page(tmp_path: Path) -> None:
    claimed_app, _gate = await _app_with_keeper(tmp_path / "claimed")
    await claimed_app.handle(_post_claim(claim_body(TOKEN)))
    fresh_app, _fresh_gate = await _app_with_keeper(tmp_path / "fresh")
    bearer = {"host": HOST_HEADER, "authorization": BEARER}
    methods = ["GET", "POST", "PUT", "HEAD", "OPTIONS", "DELETE"]
    paths = [
        "/",
        "/index.html",
        "/assets/app.js",
        "/vendor/kvs.min.js",
        "/api/claim",
        "/api/session",
        "/api/status",
        "/nowhere",
        "/api/status?x=1",
    ]

    answered: set[tuple[str, str]] = set()
    for method in methods:
        for path in paths:
            response = await claimed_app.handle(Request(method, path, bearer, b"", _PEER))
            if 200 <= response.status < 300:
                answered.add((method, path))
    granted = await fresh_app.handle(_post_claim(claim_body(TOKEN)))
    if 200 <= granted.status < 300:
        answered.add(("POST", "/api/claim"))

    assert answered == {
        ("GET", "/"),
        ("GET", "/assets/app.js"),
        ("GET", "/vendor/kvs.min.js"),
        ("POST", "/api/claim"),
        ("GET", "/api/session"),
        ("GET", "/api/status"),
    }
