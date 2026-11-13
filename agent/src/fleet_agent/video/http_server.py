"""Minimal HTTP/1.x server on the loopback interface, with strict parser limits.

The core runs on one asyncio loop, so the page is served on that loop too: no thread shares the
snapshot. The server speaks one request per connection, always answers `Connection: close`, and
refuses every framing that a proxy could disagree about (chunked bodies, duplicate length or host
headers, absolute-form targets). Every deadline and every cap is in `constants`.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import socket
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from http import HTTPStatus
from typing import Final

from fleet_agent.core.ids import uuid7
from fleet_agent.protocol.problem import Problem
from fleet_agent.video.constants import (
    CONNECTION_MAX_S,
    LOOPBACK_HOST,
    MAX_BODY_BYTES,
    MAX_CONNECTIONS,
    MAX_HEADER_BYTES,
    MAX_HEADER_COUNT,
    MAX_REQUEST_LINE,
    READ_BODY_S,
    READ_HEAD_S,
    WRITE_S,
)

_TOKEN: Final = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
"""An RFC 9110 token: the form of a method and of a header name."""

_DIGITS: Final = re.compile(r"[0-9]+")
"""A decimal length: ASCII digits only, so no sign, space or Unicode digit passes."""

_SINGLE_VALUED: Final = frozenset(
    {"host", "content-length", "origin", "authorization", "content-type"}
)
"""Headers that may appear once. A repeated one is a framing or identity ambiguity: refused."""

_ALLOWED_VERSIONS: Final = frozenset({"HTTP/1.1", "HTTP/1.0"})
"""The only protocol versions answered. Anything else is refused at the request line."""


@dataclass(frozen=True, slots=True)
class Request:
    """One parsed request, as the application sees it.

    Attributes:
        method: The request method, as sent.
        target: The request target. It starts with `/` (or is a CONNECT authority, refused later).
        headers: The header fields by lowercase name. Repeated names are joined with `, `.
        body: The request body. Empty for every method but POST.
        peer: The address of the client, always the loopback address.
    """

    method: str
    target: str
    headers: Mapping[str, str]
    body: bytes
    peer: str


@dataclass(frozen=True, slots=True)
class Response:
    """One response, before the server adds the transport headers.

    Attributes:
        status: The HTTP status code.
        headers: The header fields, by name. The server adds the base headers and the framing.
        body: The response body.
    """

    status: int
    headers: Mapping[str, str]
    body: bytes


RequestHandler = Callable[[Request], Awaitable[Response]]
"""Answers one parsed request. It must not raise; a raised exception becomes a 500."""


def problem_response(
    status: int,
    type_suffix: str,
    title: str,
    *,
    correlation_id: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> Response:
    """Builds an RFC 7807 response. It names no internal identifier and no stack trace.

    Args:
        status: The HTTP status code, from 400 to 599.
        type_suffix: The problem type, as the part after `urn:mfc:problem:`.
        title: A short English title.
        correlation_id: The identifier to report, so that a log line can be matched. A new one is
            generated when omitted.
        headers: Extra header fields, such as `Retry-After`.

    Returns:
        The response, with the `application/problem+json` content type.
    """
    problem = Problem.model_validate(
        {
            "type": f"urn:mfc:problem:{type_suffix}",
            "title": title,
            "status": status,
            "correlationId": correlation_id or uuid7(),
        }
    )
    merged: dict[str, str] = {"Content-Type": "application/problem+json"}
    merged.update(headers or {})
    return Response(
        status=status,
        headers=merged,
        body=problem.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8"),
    )


class _RefusedError(Exception):
    """The parser refuses a request before the application sees it.

    Attributes:
        status: The HTTP status to answer.
        suffix: The problem type suffix.
        title: The problem title.
        reason: The log reason of the refusal.
    """

    def __init__(self, status: int, suffix: str, title: str, reason: str) -> None:
        """Creates the refusal.

        Args:
            status: The HTTP status to answer.
            suffix: The problem type suffix.
            title: The problem title.
            reason: The log reason of the refusal.
        """
        super().__init__(suffix)
        self.status = status
        self.suffix = suffix
        self.title = title
        self.reason = reason


def _bad_request() -> _RefusedError:
    """Builds the refusal of a malformed request.

    Returns:
        A 400 refusal with the `PARSE` reason.
    """
    return _RefusedError(400, "bad-request", "Bad request", "PARSE")


def _ignore_handler_error(_error_name: str) -> None:
    """Drops a handler failure. It is the default when no one reports the failures.

    Args:
        _error_name: The class name of the failure. Unused.
    """


class LoopbackServer:
    """Serves the page on `127.0.0.1` with an ephemeral port, one request per connection.

    The server enforces the connection cap, the deadlines and the parser limits, and renders its
    own parser refusals. Everything else goes to the handler.
    """

    def __init__(
        self,
        handler: RequestHandler,
        *,
        on_refused: Callable[[str], None],
        base_headers: Mapping[str, str],
        on_handler_error: Callable[[str], None] = _ignore_handler_error,
    ) -> None:
        """Creates the server, which is not listening yet.

        Args:
            handler: Answers every request that passes the parser.
            on_refused: Called with the reason of every parser refusal, for the log.
            base_headers: Added to every response, parser refusals included.
            on_handler_error: Called with the class name of an exception the handler raised, for
                the log. The exception itself is never passed on: its text can quote a value.
        """
        self._handler = handler
        self._on_refused = on_refused
        self._on_handler_error = on_handler_error
        self._base_headers: dict[str, str] = dict(base_headers)
        self._server: asyncio.Server | None = None
        self._port: int | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def port(self) -> int | None:
        """Returns the bound port, or None while the server is not listening.

        Returns:
            The port number.
        """
        return self._port

    async def start(self) -> int:
        """Binds the loopback address on an ephemeral port and starts accepting connections.

        Returns:
            The bound port.

        Raises:
            OSError: When the address cannot be bound.
            RuntimeError: When the server was already started.
        """
        if self._server is not None:
            raise RuntimeError("server already started")
        server = await asyncio.start_server(
            self._accept,
            host=LOOPBACK_HOST,
            port=0,
            family=socket.AF_INET,
            backlog=8,
            limit=MAX_HEADER_BYTES,
        )
        port = int(server.sockets[0].getsockname()[1])
        self._server = server
        self._port = port
        return port

    async def stop(self, budget_s: float) -> None:
        """Closes the listener, cancels the requests in flight, and waits at most `budget_s`.

        A second call does nothing.

        Args:
            budget_s: The longest wait for the cancelled requests to finish, in seconds.
        """
        server, self._server = self._server, None
        if server is None:
            return
        self._port = None
        server.close()
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=budget_s)

    async def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Serves one connection, or closes it at once when the cap is reached.

        Args:
            reader: The client's stream.
            writer: The client's stream writer.
        """
        task = asyncio.current_task()
        if task is None or len(self._tasks) >= MAX_CONNECTIONS:
            writer.close()
            return
        self._tasks.add(task)
        try:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._serve(reader, writer), timeout=CONNECTION_MAX_S)
        finally:
            self._tasks.discard(task)
            writer.close()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Reads one request, passes it to the handler, and writes the response.

        A connection from a non-loopback peer is closed without an answer.

        Args:
            reader: The client's stream.
            writer: The client's stream writer.
        """
        peer = _peer_host(writer)
        if peer != LOOPBACK_HOST:
            return
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=READ_HEAD_S)
            method, target, headers = _parse_head(head)
            body = await self._read_body(reader, method, headers)
        except _RefusedError as refusal:
            await self._answer_refusal(writer, refusal)
            return
        except TimeoutError:
            timeout = _RefusedError(408, "request-timeout", "Request timeout", "PARSE")
            await self._answer_refusal(writer, timeout)
            return
        except asyncio.LimitOverrunError:
            await self._answer_refusal(
                writer, _RefusedError(431, "headers-too-large", "Request headers too large", "SIZE")
            )
            return
        except (asyncio.IncompleteReadError, ConnectionError):
            return
        request = Request(method=method, target=target, headers=headers, body=body, peer=peer)
        try:
            response = await self._handler(request)
        except Exception as err:
            # The handler's exception text can quote a value, so only the status and the class
            # name of the failure leave this function.
            self._on_handler_error(type(err).__name__)
            response = problem_response(500, "internal", "Internal error")
        await self._write(writer, response)

    async def _read_body(
        self,
        reader: asyncio.StreamReader,
        method: str,
        headers: Mapping[str, str],
    ) -> bytes:
        """Reads the body of a POST, under its deadline. Any other method has no body.

        Args:
            reader: The client's stream.
            method: The request method.
            headers: The parsed header fields.

        Returns:
            The body, empty for every method but POST.

        Raises:
            _RefusedError: When the length is missing, malformed or too large.
        """
        length_text = headers.get("content-length")
        if method != "POST":
            if length_text is not None:
                raise _bad_request()
            return b""
        if length_text is None:
            raise _RefusedError(411, "length-required", "Length required", "PARSE")
        if _DIGITS.fullmatch(length_text) is None:
            raise _bad_request()
        length = int(length_text)
        if length > MAX_BODY_BYTES:
            raise _RefusedError(413, "payload-too-large", "Payload too large", "SIZE")
        return await asyncio.wait_for(reader.readexactly(length), timeout=READ_BODY_S)

    async def _answer_refusal(self, writer: asyncio.StreamWriter, refusal: _RefusedError) -> None:
        """Logs a parser refusal and writes its problem response.

        Args:
            writer: The client's stream writer.
            refusal: The refusal to answer.
        """
        self._on_refused(refusal.reason)
        await self._write(
            writer,
            problem_response(refusal.status, refusal.suffix, refusal.title),
        )

    async def _write(self, writer: asyncio.StreamWriter, response: Response) -> None:
        """Writes one response with the base headers, then drains it under the write deadline.

        A slow reader is aborted at the deadline, and a reset client is ignored: neither may
        escape the connection.

        Args:
            writer: The client's stream writer.
            response: The response to write.
        """
        headers: dict[str, str] = {**self._base_headers, **response.headers}
        headers["Content-Length"] = str(len(response.body))
        headers["Connection"] = "close"
        phrase = HTTPStatus(response.status).phrase
        lines = [f"HTTP/1.1 {response.status} {phrase}"]
        lines.extend(f"{name}: {value}" for name, value in headers.items())
        head = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")
        writer.write(head + response.body)
        try:
            await asyncio.wait_for(writer.drain(), timeout=WRITE_S)
        except TimeoutError:
            writer.transport.abort()
        except (ConnectionError, OSError):
            return


def _peer_host(writer: asyncio.StreamWriter) -> str:
    """Returns the address of the client of a connection.

    Args:
        writer: The client's stream writer.

    Returns:
        The IP address of the peer, or the empty string when the peer is unknown.
    """
    peer: object = writer.get_extra_info("peername")
    if isinstance(peer, tuple) and peer and isinstance(peer[0], str):
        return peer[0]
    return ""


def _parse_head(head: bytes) -> tuple[str, str, dict[str, str]]:
    """Parses the request line and the header fields, and enforces the head limits.

    Args:
        head: The bytes up to and including the blank line that ends the head.

    Returns:
        The method, the target, and the header fields by lowercase name.

    Raises:
        _RefusedError: With 431 for a head over the byte limit, 414 for a long request line, and 400
            for any malformed or ambiguous framing.
    """
    if len(head) > MAX_HEADER_BYTES:
        raise _RefusedError(431, "headers-too-large", "Request headers too large", "SIZE")
    try:
        text = head[:-4].decode("utf-8")
    except UnicodeDecodeError:
        raise _bad_request() from None
    lines = text.split("\r\n")
    request_line = lines[0]
    if len(request_line) > MAX_REQUEST_LINE:
        raise _RefusedError(414, "uri-too-long", "Request line too long", "SIZE")
    method, target = _parse_request_line(request_line)
    field_lines = lines[1:]
    if len(field_lines) > MAX_HEADER_COUNT:
        raise _bad_request()
    return method, target, _parse_fields(field_lines)


def _parse_request_line(request_line: str) -> tuple[str, str]:
    """Splits and checks the request line.

    A CONNECT target is an authority, not a path, so it is passed on; the application answers it
    with 405. Every other target must be origin-form.

    Args:
        request_line: The first line of the head.

    Returns:
        The method and the target.

    Raises:
        _RefusedError: With 400 for a line that is not three fields, a bad method, an unknown
            version, or an absolute-form target.
    """
    parts = request_line.split(" ")
    if len(parts) != 3:
        raise _bad_request()
    method, target, version = parts
    if _TOKEN.fullmatch(method) is None or version not in _ALLOWED_VERSIONS:
        raise _bad_request()
    if method != "CONNECT" and not target.startswith("/"):
        raise _bad_request()
    return method, target


def _parse_fields(field_lines: list[str]) -> dict[str, str]:
    """Parses the header fields and refuses the framing and identity ambiguities.

    Args:
        field_lines: The header lines, without the request line.

    Returns:
        The fields by lowercase name, with repeated names joined by `, `.

    Raises:
        _RefusedError: With 400 for an obsolete line fold, an invalid name, a repeated single-valued
            field, or a `Transfer-Encoding` or `Expect` field.
    """
    fields: dict[str, str] = {}
    for line in field_lines:
        if not line or line[0] in (" ", "\t"):
            raise _bad_request()
        name, separator, value = line.partition(":")
        if not separator or _TOKEN.fullmatch(name) is None:
            raise _bad_request()
        key = name.lower()
        if key in ("transfer-encoding", "expect"):
            raise _bad_request()
        stripped = value.strip(" \t")
        if key in fields:
            if key in _SINGLE_VALUED:
                raise _bad_request()
            fields[key] = f"{fields[key]}, {stripped}"
        else:
            fields[key] = stripped
    return fields
