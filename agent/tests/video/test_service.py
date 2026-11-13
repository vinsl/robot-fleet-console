"""Tests of the service: its start and stop, the notice, the logs, the re-arm, and the rule that
no failure of the page is ever raised into the robot.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import signal
import time
from pathlib import Path

import pytest

from fleet_agent.video import service as service_module
from fleet_agent.video.claim import ClaimGate
from fleet_agent.video.constants import STOP_BUDGET_S
from fleet_agent.video.credentials import CredentialsKeeper
from fleet_agent.video.http_server import LoopbackServer
from fleet_agent.video.service import LocalVideoService, write_stderr
from tests.video.support import (
    FakeSource,
    closed_by_peer,
    make_kit,
    raw_exchange,
    snapshot_of,
    standard_files,
    status_of,
    valid_credentials,
    write_static,
)

_NOTICE = re.compile(r"http://127\.0\.0\.1:(\d+)/#claim=([A-Za-z0-9_-]{43})")
_LOGGER = "fleet_agent.video.service"
_TURNS = 500
"""Scheduling turns a wait gives the loop before it gives up. Turns cost no real time."""


def _service(
    tmp_path: Path,
    notices: list[str],
    *,
    source: FakeSource | None = None,
    static_dir: Path | None = None,
) -> LocalVideoService:
    """Builds a service with a real kit, a recording notice writer, and a fake credentials source.

    Args:
        tmp_path: The test's temporary directory.
        notices: The list that receives the notices.
        source: The credentials source. A source with valid credentials when omitted.
        static_dir: The static page. A valid page is written when omitted.

    Returns:
        The service.
    """
    static = static_dir or write_static(tmp_path / "static", standard_files())
    return LocalVideoService(
        make_kit(tmp_path),
        lambda: snapshot_of(),
        notice=notices.append,
        source=source or FakeSource(valid_credentials()),
        static_dir=static,
    )


def _address(notices: list[str]) -> tuple[int, str]:
    """Reads the port and the one-time token from the last notice.

    Args:
        notices: The notices written so far.

    Returns:
        The port and the token.

    Raises:
        AssertionError: When the notice does not carry an address.
    """
    match = _NOTICE.search(notices[-1])
    if match is None:
        raise AssertionError("no address in the notice")
    return int(match.group(1)), match.group(2)


def _log_text(records: list[logging.LogRecord]) -> str:
    """Joins every log record's message and fields, for a secrecy check.

    Args:
        records: The captured records.

    Returns:
        One string with everything the records carry.
    """
    return "\n".join(f"{record.getMessage()} {record.__dict__!r}" for record in records)


async def test_start_binds_writes_the_notice_once_and_logs_the_port_only(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    notices: list[str] = []
    service = _service(tmp_path, notices)

    await service.start()
    try:
        port, token = _address(notices)
        listening = [r for r in caplog.records if r.getMessage() == "video.listening"]
    finally:
        await service.stop()

    assert len(notices) == 1
    assert port > 0
    assert len(token) == 43
    assert len(listening) == 1
    assert listening[0].__dict__["port"] == port
    assert "claim" not in str(listening[0].__dict__)


async def test_no_log_record_carries_the_token_the_key_or_a_credential(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, token = _address(notices)
    try:
        await _wait_until_held(service._keeper)  # type: ignore[attr-defined]
        granted = await raw_exchange(port, _claim_request(port, token))
        session_key = json.loads(granted.partition(b"\r\n\r\n")[2])["sessionKey"]
        await raw_exchange(port, _bearer_request(port, "/api/status", session_key))
        await raw_exchange(port, _bearer_request(port, "/api/session", session_key))
        await raw_exchange(port, _claim_request(port, "Z" * 43))
    finally:
        await service.stop()

    text = _log_text(caplog.records)
    assert token not in text
    assert session_key not in text
    assert "claim=" not in text
    assert "a" * 40 not in text
    assert "t" * 16 not in text
    assert "video.claimed" in text


def test_the_default_notice_writer_writes_to_stderr_and_never_to_stdout(
    capsys: pytest.CaptureFixture[str],
) -> None:
    write_stderr("address line")

    captured = capsys.readouterr()
    assert captured.err == "address line\n"
    assert captured.out == ""


async def test_a_broken_manifest_disables_the_page_without_raising(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    notices: list[str] = []
    static = write_static(tmp_path / "static", standard_files())
    (static / "index.html").write_bytes(b"changed")
    service = _service(tmp_path, notices, static_dir=static)

    await service.start()
    await service.stop()

    disabled = [r for r in caplog.records if r.getMessage() == "video.disabled"]
    assert notices == []
    assert [r.__dict__["code"] for r in disabled] == ["HASH_MISMATCH"]
    assert not [r for r in caplog.records if r.getMessage() == "video.stopped"]


async def test_a_bind_failure_disables_the_page_stops_the_keeper_and_does_not_raise(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.DEBUG)

    async def refuse_bind(_self: LoopbackServer) -> int:
        """Fails the bind as the operating system would when the port is taken.

        Returns:
            Never returns.

        Raises:
            OSError: Always.
        """
        raise OSError("address in use")

    monkeypatch.setattr(LoopbackServer, "start", refuse_bind)
    notices: list[str] = []
    service = _service(tmp_path, notices)

    await service.start()
    await service.stop()

    disabled = [r for r in caplog.records if r.getMessage() == "video.disabled"]
    assert [r.__dict__["code"] for r in disabled] == ["BIND_FAILED"]
    assert notices == []
    assert service._keeper is None  # type: ignore[attr-defined]


async def test_an_unexpected_start_error_is_logged_with_its_class_name_and_not_raised(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.DEBUG)

    def explode(_directory: Path) -> object:
        """Fails the asset load with an unexpected error.

        Args:
            _directory: The directory, unused.

        Raises:
            RuntimeError: Always.
        """
        raise RuntimeError("unexpected")

    monkeypatch.setattr(service_module.StaticAssets, "load", explode)
    service = _service(tmp_path, [])

    await service.start()

    disabled = [r for r in caplog.records if r.getMessage() == "video.disabled"]
    assert disabled[0].__dict__["code"] == "UNEXPECTED"
    assert disabled[0].__dict__["errorName"] == "RuntimeError"


async def test_a_provider_that_cannot_be_built_disables_the_page(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.DEBUG)

    def refuse(_kit: object) -> object:
        """Fails to build the credentials source.

        Args:
            _kit: The kit, unused.

        Raises:
            ValueError: Always.
        """
        raise ValueError("bad key")

    monkeypatch.setattr(service_module, "X509CredentialsSource", refuse)
    notices: list[str] = []
    static = write_static(tmp_path / "static", standard_files())
    service = LocalVideoService(
        make_kit(tmp_path), lambda: snapshot_of(), notice=notices.append, static_dir=static
    )

    await service.start()

    disabled = [r for r in caplog.records if r.getMessage() == "video.disabled"]
    assert disabled[0].__dict__["code"] == "PROVIDER_BUILD"
    assert notices == []


async def test_sigusr1_issues_a_new_token_and_revokes_the_previous_key(
    tmp_path: Path,
) -> None:
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, first_token = _address(notices)
    try:
        granted = await raw_exchange(port, _claim_request(port, first_token))
        old_key = json.loads(granted.partition(b"\r\n\r\n")[2])["sessionKey"]

        signal.raise_signal(signal.SIGUSR1)
        await _wait_for_notices(notices, 2)

        _new_port, new_token = _address(notices)
        refused = await raw_exchange(port, _bearer_request(port, "/api/status", old_key))
        replay = await raw_exchange(port, _claim_request(port, first_token))
        accepted = await raw_exchange(port, _claim_request(port, new_token))
    finally:
        await service.stop()

    assert len(notices) == 2
    assert new_token != first_token
    assert status_of(refused) == 401
    assert status_of(replay) == 401
    assert status_of(accepted) == 200


async def test_the_full_flow_claims_then_reads_session_and_status_and_refuses_a_replay(
    tmp_path: Path,
) -> None:
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, token = _address(notices)
    try:
        await _wait_until_held(service._keeper)  # type: ignore[attr-defined]
        granted = await raw_exchange(port, _claim_request(port, token))
        key = json.loads(granted.partition(b"\r\n\r\n")[2])["sessionKey"]
        status = await raw_exchange(port, _bearer_request(port, "/api/status", key))
        replay = await raw_exchange(port, _claim_request(port, token))
    finally:
        await service.stop()

    assert status_of(granted) == 200
    assert status_of(status) == 200
    assert json.loads(status.partition(b"\r\n\r\n")[2]) == {
        "state": "IDLE",
        "banner": "NONE",
        "lockHeld": False,
        "connected": True,
        "simulated": False,
    }
    assert status_of(replay) == 409


async def test_stop_finishes_within_the_budget_drops_the_credentials_and_closes_the_listener(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, _token = _address(notices)
    keeper = service._keeper  # type: ignore[attr-defined]
    assert keeper is not None
    await _wait_until_held(keeper)
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"GET / HTTP/1.1\r\nHost")
    await writer.drain()

    started = time.monotonic()
    await service.stop()
    elapsed = time.monotonic() - started

    assert elapsed < STOP_BUDGET_S
    assert keeper.current() is None
    with pytest.raises(ConnectionRefusedError):
        await asyncio.open_connection("127.0.0.1", port)
    assert await closed_by_peer(reader) is True
    writer.close()
    await service.stop()
    stopped = [r for r in caplog.records if r.getMessage() == "video.stopped"]
    assert len(stopped) == 1


async def test_stop_before_start_keeps_the_service_down_and_stop_is_idempotent(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    notices: list[str] = []
    service = _service(tmp_path, notices)

    await service.stop()
    await service.start()

    assert notices == []
    assert [r for r in caplog.records if r.getMessage() == "video.stopped"] == []


async def test_start_is_idempotent_and_stop_logs_once(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    notices: list[str] = []
    service = _service(tmp_path, notices)

    await service.start()
    await service.start()
    await service.stop()
    await service.stop()

    assert len(notices) == 1
    assert len([r for r in caplog.records if r.getMessage() == "video.stopped"]) == 1


async def test_a_failing_server_stop_still_stops_the_keeper_and_revokes_the_key(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The server's failure is logged by class name, and the later steps still run; no token is
    issued, because stop revokes the key rather than re-arming the claim.
    """
    caplog.set_level(logging.DEBUG)
    revoked: list[bool] = []
    rearmed: list[bool] = []
    original_revoke = ClaimGate.revoke
    original_server_stop = LoopbackServer.stop

    def recording_revoke(self: ClaimGate) -> None:
        """Records the call, then revokes as the real method does.

        Args:
            self: The claim gate.
        """
        revoked.append(True)
        original_revoke(self)

    def recording_rearm(_self: ClaimGate) -> str:
        """Records a forbidden re-arm and fails the test through the logged error.

        Args:
            _self: The claim gate. Unused.

        Returns:
            Never returns.

        Raises:
            AssertionError: Always, because stop must never re-arm.
        """
        rearmed.append(True)
        raise AssertionError("stop must not re-arm")

    async def failing_stop(_self: LoopbackServer, _budget_s: float) -> None:
        """Fails the listener shutdown.

        Args:
            _self: The server. Unused.
            _budget_s: The budget. Unused.

        Raises:
            RuntimeError: Always.
        """
        raise RuntimeError("listener refused to close")

    monkeypatch.setattr(ClaimGate, "revoke", recording_revoke)
    monkeypatch.setattr(ClaimGate, "rearm", recording_rearm)
    monkeypatch.setattr(LoopbackServer, "stop", failing_stop)
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    keeper = service._keeper  # type: ignore[attr-defined]
    server = service._server  # type: ignore[attr-defined]
    assert keeper is not None
    assert server is not None
    task = keeper._task
    await _wait_until_held(keeper)

    await service.stop()

    stopped = [r for r in caplog.records if r.getMessage() == "video.stopped"]
    assert [r.__dict__["errorName"] for r in stopped] == ["RuntimeError"]
    assert revoked == [True]
    assert rearmed == []
    assert len(notices) == 1
    assert task is not None
    assert task.done()
    assert keeper.current() is None
    # The real shutdown still runs, so that the listener does not outlive the test.
    await original_server_stop(server, STOP_BUDGET_S)


async def test_a_failing_keeper_stop_still_closes_the_listener_and_revokes_the_key(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failing keeper stop never leaves the listener open, and the key is still revoked."""
    caplog.set_level(logging.DEBUG)
    revoked: list[bool] = []
    original_revoke = ClaimGate.revoke
    original_keeper_stop = CredentialsKeeper.stop

    def recording_revoke(self: ClaimGate) -> None:
        """Records the call, then revokes as the real method does.

        Args:
            self: The claim gate.
        """
        revoked.append(True)
        original_revoke(self)

    async def failing_keeper_stop(_self: CredentialsKeeper) -> None:
        """Fails the keeper's shutdown.

        Args:
            _self: The keeper. Unused.

        Raises:
            ValueError: Always.
        """
        raise ValueError("keeper refused to stop")

    monkeypatch.setattr(ClaimGate, "revoke", recording_revoke)
    monkeypatch.setattr(CredentialsKeeper, "stop", failing_keeper_stop)
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, _token = _address(notices)
    keeper = service._keeper  # type: ignore[attr-defined]
    assert keeper is not None

    await service.stop()

    stopped = [r for r in caplog.records if r.getMessage() == "video.stopped"]
    assert [r.__dict__["errorName"] for r in stopped] == ["ValueError"]
    assert revoked == [True]
    with pytest.raises(ConnectionRefusedError):
        await asyncio.open_connection("127.0.0.1", port)
    # The real stop still runs, so that the keeper's task does not outlive the test.
    await original_keeper_stop(keeper)


async def test_a_failing_revoke_does_not_stop_the_listener_or_the_keeper(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The last step failing is logged, and the two steps before it have already run."""
    caplog.set_level(logging.DEBUG)

    def failing_revoke(_self: ClaimGate) -> None:
        """Fails the revocation.

        Args:
            _self: The claim gate. Unused.

        Raises:
            KeyError: Always.
        """
        raise KeyError("revoke failed")

    monkeypatch.setattr(ClaimGate, "revoke", failing_revoke)
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, _token = _address(notices)
    keeper = service._keeper  # type: ignore[attr-defined]
    assert keeper is not None
    await _wait_until_held(keeper)

    await service.stop()

    stopped = [r for r in caplog.records if r.getMessage() == "video.stopped"]
    assert [r.__dict__["errorName"] for r in stopped] == ["KeyError"]
    assert keeper.current() is None
    with pytest.raises(ConnectionRefusedError):
        await asyncio.open_connection("127.0.0.1", port)


async def test_a_refused_request_is_logged_by_its_reason_only(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, _token = _address(notices)
    try:
        await raw_exchange(port, b"GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
    finally:
        await service.stop()

    refused = [r for r in caplog.records if r.getMessage() == "video.request_refused"]
    assert [r.__dict__["reason"] for r in refused] == ["PARSE"]
    assert "chunked" not in _log_text(refused)


async def test_an_application_failure_is_logged_as_a_handler_refusal_without_its_text(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failure in the application answers 500 and logs reason HANDLER with the class name only."""
    caplog.set_level(logging.DEBUG)

    async def failing(_self: object, _request: object) -> object:
        """Stands in for the application, failing with a message that must never be logged.

        Args:
            _self: The application. Unused.
            _request: The request. Unused.

        Raises:
            RuntimeError: Always, with a message the log must not carry.
        """
        raise RuntimeError("secret-application-text")

    monkeypatch.setattr(service_module.VideoApp, "handle", failing)
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    port, _token = _address(notices)
    try:
        raw = await raw_exchange(port, b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    finally:
        await service.stop()

    assert status_of(raw) == 500
    failed = [r for r in caplog.records if r.getMessage() == "video.request_refused"]
    assert [(r.__dict__["reason"], r.__dict__["errorName"]) for r in failed] == [
        ("HANDLER", "RuntimeError")
    ]
    assert "secret-application-text" not in _log_text(caplog.records)


async def test_a_rearm_after_stop_is_ignored(tmp_path: Path) -> None:
    notices: list[str] = []
    service = _service(tmp_path, notices)
    await service.start()
    await service.stop()

    service._rearm()  # type: ignore[attr-defined]

    assert len(notices) == 1


def _claim_request(port: int, token: str) -> bytes:
    """Builds a claim request as the page sends it.

    Args:
        port: The port of the page.
        token: The presented token.

    Returns:
        The raw request.
    """
    body = json.dumps({"claim": token}, separators=(",", ":")).encode("ascii")
    return (
        b"POST /api/claim HTTP/1.1\r\n"
        + f"Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n".encode("ascii")
        + b"Content-Type: application/json\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        + body
    )


def _bearer_request(port: int, path: str, key: str) -> bytes:
    """Builds a GET request with a bearer key.

    Args:
        port: The port of the page.
        path: The route.
        key: The session key.

    Returns:
        The raw request.
    """
    return (
        f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {key}\r\n\r\n"
    ).encode("ascii")


async def _wait_until_held(keeper: CredentialsKeeper | None) -> None:
    """Waits until a keeper holds credentials, so that the session route can answer.

    Args:
        keeper: The keeper of the running service.

    Raises:
        AssertionError: When there is no keeper, or it never holds credentials.
    """
    if keeper is None:
        raise AssertionError("the service has no keeper")
    for _ in range(_TURNS):
        if keeper.current() is not None:
            return
        await asyncio.sleep(0)
    raise AssertionError("keeper never held credentials")


async def _wait_for_notices(notices: list[str], count: int) -> None:
    """Gives the loop scheduling turns, with no real delay, until the notices reach a count.

    Args:
        notices: The notices written so far.
        count: The number of notices to wait for.

    Raises:
        AssertionError: When the notices never reach the count.
    """
    for _ in range(_TURNS):
        if len(notices) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError("the expected notice was never written")
