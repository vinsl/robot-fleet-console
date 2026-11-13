"""Tests of the loopback server on real sockets: bind, parser limits, deadlines, caps and stop."""

from __future__ import annotations

import asyncio
import json
import socket
import time
from collections.abc import Callable
from typing import Any

import pytest

from fleet_agent.video import http_server
from fleet_agent.video.http_server import LoopbackServer, Request, Response, problem_response
from tests.video.support import closed_by_peer
from tests.video.support import raw_exchange as _exchange
from tests.video.support import status_of as _status_of

_BASE = {"X-Base": "1"}


def _host(port: int) -> bytes:
    """Returns a Host header for the port.

    Args:
        port: The port the server listens on.

    Returns:
        The header line, with its line ending.
    """
    return f"Host: 127.0.0.1:{port}\r\n".encode("ascii")


class _Recorder:
    """A handler that records every request and answers 200 `ok`, or raises on demand."""

    def __init__(self) -> None:
        """Creates the recorder with no requests."""
        self.requests: list[Request] = []
        self.raise_next = False
        self.body = b"ok"

    async def __call__(self, request: Request) -> Response:
        """Records the request and answers it.

        Args:
            request: The request.

        Returns:
            The response.

        Raises:
            RuntimeError: When the test asked for a failure.
        """
        self.requests.append(request)
        if self.raise_next:
            self.raise_next = False
            raise RuntimeError("secret-text inside the failure")
        return Response(status=200, headers={"Content-Type": "text/plain"}, body=self.body)


async def _started(recorder: _Recorder | None = None) -> tuple[LoopbackServer, int, list[str]]:
    """Starts a server with the recorder and returns it with its port and its refusals.

    Args:
        recorder: The handler. A fresh recorder is used when omitted.

    Returns:
        The server, its port, and the list that receives the refusal reasons.
    """
    refused: list[str] = []
    server = LoopbackServer(recorder or _Recorder(), on_refused=refused.append, base_headers=_BASE)
    port = await server.start()
    return server, port, refused


async def test_the_listener_binds_loopback_on_a_nonzero_ipv4_port() -> None:
    server, port, _refused = await _started()
    try:
        assert port != 0
        assert server.port == port
        sockets = server._server.sockets  # type: ignore[union-attr]
        assert sockets[0].family == socket.AF_INET
        assert sockets[0].getsockname()[0] == "127.0.0.1"
    finally:
        await server.stop(1.0)


async def test_a_valid_get_returns_the_handler_answer_with_close_and_base_headers() -> None:
    recorder = _Recorder()
    server, port, _refused = await _started(recorder)
    try:
        raw = await _exchange(port, b"GET / HTTP/1.1\r\n" + _host(port) + b"\r\n")
    finally:
        await server.stop(1.0)

    head, _, body = raw.partition(b"\r\n\r\n")
    assert head.startswith(b"HTTP/1.1 200 OK")
    assert b"Connection: close" in head
    assert b"X-Base: 1" in head
    assert body == b"ok"
    assert recorder.requests[0].peer == "127.0.0.1"


_REFUSED_CASES = [
    pytest.param(b"GET /" + b"a" * 3000 + b" HTTP/1.1\r\n\r\n", 414, "SIZE", id="long-line"),
    pytest.param(
        b"GET / HTTP/1.1\r\nX-Pad: " + b"a" * 9000 + b"\r\n\r\n", 431, "SIZE", id="big-head"
    ),
    pytest.param(
        b"GET / HTTP/1.1\r\n" + b"".join(b"X-%d: v\r\n" % i for i in range(41)) + b"\r\n",
        400,
        "PARSE",
        id="41-headers",
    ),
    pytest.param(
        b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n",
        400,
        "PARSE",
        id="chunked",
    ),
    pytest.param(b"GET http://127.0.0.1/ HTTP/1.1\r\n\r\n", 400, "PARSE", id="absolute-form"),
    pytest.param(b"GET / HTTP/2.0\r\n\r\n", 400, "PARSE", id="http2"),
    pytest.param(b"GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n", 400, "PARSE", id="two-host"),
    pytest.param(b"GET / HTTP/1.1\r\nContent-Length: 1\r\n\r\nx", 400, "PARSE", id="get-body"),
    pytest.param(b"POST / HTTP/1.1\r\nHost: a\r\n\r\n", 411, "PARSE", id="no-length"),
    pytest.param(b"POST / HTTP/1.1\r\nContent-Length: 513\r\n\r\n", 413, "SIZE", id="too-big"),
    pytest.param(b"POST / HTTP/1.1\r\nContent-Length: abc\r\n\r\n", 400, "PARSE", id="bad-length"),
    pytest.param(b"GET / HTTP/1.1\r\nExpect: 100-continue\r\n\r\n", 400, "PARSE", id="expect"),
    pytest.param(b"GET / HTTP/1.1\r\nX-A: 1\r\n folded\r\n\r\n", 400, "PARSE", id="fold"),
    pytest.param(b"GET / HTTP/1.1\r\nbad name: 1\r\n\r\n", 400, "PARSE", id="bad-name"),
    pytest.param(b"GET / HTTP/1.1\r\nno-colon\r\n\r\n", 400, "PARSE", id="no-colon"),
    pytest.param(b"GET / HTTP/1.1\r\n\xff\xfe\r\n\r\n", 400, "PARSE", id="not-utf8"),
    pytest.param(b"GET /onlytwo HTTP/1.1 extra\r\n\r\n", 400, "PARSE", id="four-fields"),
    pytest.param(b"G@T / HTTP/1.1\r\n\r\n", 400, "PARSE", id="bad-method"),
]


@pytest.mark.parametrize(("payload", "status", "reason"), _REFUSED_CASES)
async def test_a_request_outside_the_parser_limits_is_refused_with_its_status(
    payload: bytes, status: int, reason: str
) -> None:
    server, _port, refused = await _started()
    try:
        raw = await _exchange(_port, payload)
    finally:
        await server.stop(1.0)

    assert _status_of(raw) == status
    assert reason in refused
    assert b"application/problem+json" in raw


async def test_a_refusal_body_is_a_problem_with_a_correlation_id_and_no_internals() -> None:
    server, port, _refused = await _started()
    try:
        raw = await _exchange(port, b"GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
    finally:
        await server.stop(1.0)

    document = json.loads(raw.partition(b"\r\n\r\n")[2])
    assert document["type"] == "urn:mfc:problem:bad-request"
    assert document["status"] == 400
    assert len(document["correlationId"]) >= 8


async def test_a_slow_head_is_answered_408_and_releases_its_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(http_server, "READ_HEAD_S", 0.2)
    server, port, refused = await _started()
    try:
        raw = await _exchange(port, b"GET / HTTP/1.1\r\nHost: 127", timeout_s=3.0)
        assert _status_of(raw) == 408
        assert "PARSE" in refused
        assert server._tasks == set()  # type: ignore[attr-defined]
    finally:
        await server.stop(1.0)


async def test_a_slow_body_is_answered_408(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http_server, "READ_BODY_S", 0.2)
    server, port, _refused = await _started()
    try:
        raw = await _exchange(
            port, b"POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nab", timeout_s=3.0
        )
    finally:
        await server.stop(1.0)

    assert _status_of(raw) == 408


async def test_a_post_with_its_body_reaches_the_handler_intact() -> None:
    recorder = _Recorder()
    server, port, _refused = await _started(recorder)
    try:
        raw = await _exchange(
            port,
            b"POST /api/claim HTTP/1.1\r\n" + _host(port) + b"Content-Length: 4\r\n\r\nabcd",
        )
    finally:
        await server.stop(1.0)

    assert _status_of(raw) == 200
    assert recorder.requests[0].body == b"abcd"
    assert recorder.requests[0].method == "POST"


async def test_a_client_that_disconnects_mid_head_gets_no_answer_and_no_error() -> None:
    server, port, refused = await _started()
    try:
        _reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET / HTTP/1.1\r\nHost")
        await writer.drain()
        writer.close()
        await asyncio.sleep(0.05)
    finally:
        await server.stop(1.0)

    assert refused == []


async def test_the_seventeenth_connection_is_closed_at_once_and_a_slot_frees_for_a_new_one() -> (
    None
):
    server, port, _refused = await _started()
    idle: list[tuple[asyncio.StreamReader, asyncio.StreamWriter]] = []
    try:
        for _ in range(16):
            idle.append(await asyncio.open_connection("127.0.0.1", port))
        await _settle_until(lambda: len(server._tasks) == 16)  # type: ignore[attr-defined]

        seventeenth_reader, seventeenth_writer = await asyncio.open_connection("127.0.0.1", port)
        closed = await asyncio.wait_for(seventeenth_reader.read(), timeout=2.0)
        seventeenth_writer.close()
        assert closed == b""

        _idle_reader, idle_writer = idle.pop()
        idle_writer.close()
        await _settle_until(lambda: len(server._tasks) < 16)  # type: ignore[attr-defined]
        raw = await _exchange(port, b"GET / HTTP/1.1\r\n" + _host(port) + b"\r\n")
        assert _status_of(raw) == 200
    finally:
        for _reader, writer in idle:
            writer.close()
        await server.stop(1.0)


async def test_a_handler_that_raises_is_a_500_without_its_text_and_the_server_keeps_serving() -> (
    None
):
    recorder = _Recorder()
    recorder.raise_next = True
    server, port, _refused = await _started(recorder)
    try:
        failed = await _exchange(port, b"GET / HTTP/1.1\r\n" + _host(port) + b"\r\n")
        served = await _exchange(port, b"GET / HTTP/1.1\r\n" + _host(port) + b"\r\n")
    finally:
        await server.stop(1.0)

    assert _status_of(failed) == 500
    assert b"secret-text" not in failed
    assert _status_of(served) == 200


async def test_a_handler_failure_is_reported_by_class_name_only() -> None:
    """A failed handler is reported once, by class name, and its text never leaves the server."""
    recorder = _Recorder()
    recorder.raise_next = True
    failures: list[str] = []
    server = LoopbackServer(
        recorder,
        on_refused=lambda _reason: None,
        base_headers=_BASE,
        on_handler_error=failures.append,
    )
    port = await server.start()
    try:
        failed = await _exchange(port, b"GET / HTTP/1.1\r\n" + _host(port) + b"\r\n")
    finally:
        await server.stop(1.0)

    assert _status_of(failed) == 500
    assert failures == ["RuntimeError"]
    assert b"secret-text" not in failed


async def test_a_client_that_never_reads_is_aborted_and_no_exception_escapes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(http_server, "WRITE_S", 0.2)
    recorder = _Recorder()
    recorder.body = b"x" * (8 * 1024 * 1024)
    server, port, _refused = await _started(recorder)
    try:
        _reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET / HTTP/1.1\r\n" + _host(port) + b"\r\n")
        await writer.drain()
        writer.close()
        await _settle_until(lambda: len(server._tasks) == 0, timeout_s=3.0)  # type: ignore[attr-defined]
    finally:
        await server.stop(1.0)


async def test_stop_closes_hanging_connections_within_the_budget_and_is_idempotent() -> None:
    server, port, _refused = await _started()
    hanging: list[tuple[asyncio.StreamReader, asyncio.StreamWriter]] = []
    for _ in range(3):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET / HTTP/1.1\r\nHost")
        await writer.drain()
        hanging.append((reader, writer))
    await _settle_until(lambda: len(server._tasks) == 3)  # type: ignore[attr-defined]

    started = time.monotonic()
    await server.stop(1.0)
    elapsed = time.monotonic() - started

    assert elapsed < 1.5
    for reader, writer in hanging:
        assert await closed_by_peer(reader) is True
        writer.close()
    assert server.port is None
    await server.stop(1.0)


async def test_stop_before_start_does_nothing_and_a_second_start_is_refused() -> None:
    server = LoopbackServer(_Recorder(), on_refused=lambda _reason: None, base_headers={})
    await server.stop(1.0)

    await server.start()
    with pytest.raises(RuntimeError, match="already started"):
        await server.start()
    await server.stop(1.0)


async def test_a_connection_from_a_foreign_peer_is_closed_without_an_answer() -> None:
    server = LoopbackServer(_Recorder(), on_refused=lambda _reason: None, base_headers={})
    writer = _FakeWriter(peer=("10.0.0.5", 4000))
    reader = asyncio.StreamReader()
    reader.feed_data(b"GET / HTTP/1.1\r\n\r\n")

    await server._serve(reader, writer)  # type: ignore[arg-type]

    assert writer.written == b""


def test_a_missing_peer_address_is_the_empty_string() -> None:
    writer = _FakeWriter(peer=None)

    assert http_server._peer_host(writer) == ""  # type: ignore[arg-type]


def test_problem_response_carries_the_status_type_title_and_given_correlation_id() -> None:
    response = problem_response(
        429, "rate-limited", "Too many requests", correlation_id="abcdef12", headers={"A": "b"}
    )

    document: dict[str, Any] = json.loads(response.body)
    assert document == {
        "type": "urn:mfc:problem:rate-limited",
        "title": "Too many requests",
        "status": 429,
        "correlationId": "abcdef12",
    }
    assert response.headers["Content-Type"] == "application/problem+json"
    assert response.headers["A"] == "b"


class _FakeWriter:
    """Records what is written to a connection, for the tests that need no socket."""

    def __init__(self, peer: tuple[str, int] | None) -> None:
        """Creates the writer.

        Args:
            peer: The address the transport reports, or None.
        """
        self._peer = peer
        self.written = b""

        class _Transport:
            """A transport that records an abort."""

            def abort(self) -> None:
                """Does nothing; the fake never holds a socket."""

        self.transport = _Transport()

    def get_extra_info(self, _name: str) -> object:
        """Returns the peer address the fake was given.

        Args:
            _name: The info key, always the peer name here.

        Returns:
            The address, or None.
        """
        return self._peer

    def write(self, data: bytes) -> None:
        """Records the bytes.

        Args:
            data: The bytes written.
        """
        self.written += data

    async def drain(self) -> None:
        """Returns at once."""

    def close(self) -> None:
        """Does nothing."""


async def _settle_until(predicate: Callable[[], bool], timeout_s: float = 3.0) -> None:
    """Yields to the loop until the predicate holds, or fails after the timeout.

    Args:
        predicate: The condition to wait for.
        timeout_s: The longest wait, in seconds.

    Raises:
        AssertionError: When the condition does not hold in time.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never held")
