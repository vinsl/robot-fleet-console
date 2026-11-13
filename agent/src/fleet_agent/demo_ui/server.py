"""HTTP server of the demo control page: static files, the JSON API and their request checks.

The standard library server is enough for one operator on one machine. Every request passes the same
checks in the same order: the Host header, then (for POST) the Origin and the JSON content type,
then the bearer token for the API. The three static files need no token: they hold no secret, and a
browser cannot send a header on the first navigation. Errors are RFC 7807 problems with fixed texts,
so no stack trace or tool output reaches the browser.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final, Literal
from urllib.parse import parse_qs, urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from fleet_agent.demo_ui.accounts import (
    TEMPORARY_PASSWORD_HOURS,
    AccountBody,
    AccountWriter,
)
from fleet_agent.demo_ui.aws_reads import RobotRow, UserRow
from fleet_agent.demo_ui.config import LOOPBACK_HOST, MAX_SIM_COUNT, Settings
from fleet_agent.demo_ui.demo import DemoController, DemoStatus
from fleet_agent.demo_ui.errors import ERROR_MESSAGES, DemoError
from fleet_agent.demo_ui.links import build_links
from fleet_agent.demo_ui.security import (
    SECURITY_HEADERS,
    host_allowed,
    json_content_type,
    origin_allowed,
    token_ok,
)

logger = logging.getLogger(__name__)

MAX_BODY_BYTES: Final = 1024
"""Largest request body accepted. The API bodies hold one site identifier."""

STATIC_DIR: Final = Path(__file__).resolve().parent / "static"
STATIC_FILES: Final[Mapping[str, tuple[str, str]]] = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
}
"""The only files the page serves: a fixed allow-list, so no path can reach outside the static
directory.
"""

API_ROUTES: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        ("GET", "/api/config"),
        ("GET", "/api/status"),
        ("POST", "/api/start"),
        ("POST", "/api/stop"),
        ("GET", "/api/links"),
        ("GET", "/api/users"),
        ("GET", "/api/robots"),
        ("POST", "/api/accounts"),
    }
)
"""Every API route, by method and path. Anything else is a 404, or a 405 on a known path."""

PROBLEM_TYPE: Final = "application/problem+json"
JSON_TYPE: Final = "application/json; charset=utf-8"

_STATUS_BY_CODE: Final[Mapping[str, int]] = {
    "UNKNOWN_SITE": 404,
    "IN_PROGRESS": 409,
    "INTERNAL": 500,
    "USER_EXISTS": 409,
    "ROLE_MISMATCH": 409,
    "USER_NOT_FOUND": 404,
    "ACCOUNT_PROTECTED": 403,
    "RATE_LIMITED": 429,
}
"""HTTP status of the error codes that are not a dependency failure. Every other code is 503."""


class _SiteBody(BaseModel):
    """Body of the start and stop requests. Unknown fields are refused.

    `count` is the number of simulated robots a start launches. A stop ignores it.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    site: str
    count: int | None = Field(default=None, ge=1, le=MAX_SIM_COUNT)


@dataclass(frozen=True)
class _Context:
    """Everything a request handler needs. It is set once per server."""

    settings: Settings
    controller: DemoController
    accounts: AccountWriter
    token: str
    static_dir: Path


class DemoHTTPServer(ThreadingHTTPServer):
    """The server bound to the loopback address. Its handlers read the context from it."""

    daemon_threads = True

    def __init__(self, port: int, context: _Context) -> None:
        """Binds the server.

        Args:
            port: The port. 0 asks the system for a free one.
            context: The settings, the controller, the token and the static directory.
        """
        super().__init__((LOOPBACK_HOST, port), _Handler)
        self.context = context
        self.bound_port: int = int(self.server_address[1])


def make_server(
    settings: Settings,
    controller: DemoController,
    token: str,
    *,
    accounts: AccountWriter,
    static_dir: Path = STATIC_DIR,
) -> DemoHTTPServer:
    """Creates the server, bound to the loopback address on the configured port. It is not started.

    Args:
        settings: The validated settings (the port and the site).
        controller: The demo controller.
        token: The bearer token of this run.
        accounts: The writer of the operator accounts.
        static_dir: Where the three static files are. Tests point it at a temporary directory.

    Returns:
        The bound server. Call `serve_forever` to run it, and read `bound_port` for the actual
        port.
    """
    context = _Context(
        settings=settings,
        controller=controller,
        accounts=accounts,
        token=token,
        static_dir=static_dir,
    )
    return DemoHTTPServer(settings.port, context)


def _status_payload(status: DemoStatus) -> dict[str, object]:
    """Converts a status to the JSON of the page. Every field is named here, so nothing else leaks.

    Args:
        status: The status.

    Returns:
        The JSON-ready mapping.
    """
    error = status.error
    return {
        "phase": status.phase,
        "consumer": status.consumer,
        "simulatorsRunning": status.simulators_running,
        "simCount": status.sim_count,
        "autoStopAt": status.auto_stop_at,
        "consoleUrl": status.console_url,
        "step": status.step,
        "error": None if error is None else {"code": error.code, "message": error.message},
        "realRobots": [_robot_payload(row) for row in status.real_robots],
    }


def _robot_payload(row: RobotRow) -> dict[str, object]:
    """Converts a robot row to JSON.

    Args:
        row: The row.

    Returns:
        The JSON-ready mapping.
    """
    return {
        "robotId": row.robot_id,
        "name": row.name,
        "kind": row.kind,
        "registryStatus": row.registry_status,
        "connection": row.connection,
        "lastSeen": row.last_seen,
    }


def _user_payload(row: UserRow) -> dict[str, object]:
    """Converts a user row to JSON.

    Args:
        row: The row.

    Returns:
        The JSON-ready mapping.
    """
    return {
        "displayName": row.username_display,
        "role": row.role,
        "status": row.status,
        "enabled": row.enabled,
    }


def _refusal_code(
    failure: ValidationError,
) -> Literal["INVALID_EMAIL", "INVALID_ROLE", "INVALID_BODY"]:
    """Names the field a refused body failed on, so the page can say what to correct.

    Only the first error's location is read: the code is a fixed word, never the input.

    Args:
        failure: The validation error of the body.

    Returns:
        The code of the field, or `INVALID_BODY` for any other field.
    """
    errors = failure.errors()
    location = errors[0]["loc"] if errors else ()
    if location == ("email",):
        return "INVALID_EMAIL"
    if location == ("role",):
        return "INVALID_ROLE"
    return "INVALID_BODY"


def _problem_body(status: int, code: str, message: str) -> bytes:
    """Builds an RFC 7807 body. The `code` member is a stable extension for the page.

    Args:
        status: The HTTP status.
        code: The stable code.
        message: The fixed message.

    Returns:
        The UTF-8 JSON body.
    """
    return json.dumps(
        {
            "type": "about:blank",
            "title": HTTPStatus(status).phrase,
            "status": status,
            "detail": message,
            "code": code,
        }
    ).encode("utf-8")


class _Handler(BaseHTTPRequestHandler):
    """Handles one request; the run state is read from the server it belongs to."""

    server_version = "demo-ui"
    sys_version = ""
    # A client that stalls mid-request holds a thread for at most this many seconds.
    timeout = 10

    @property
    def _demo(self) -> DemoHTTPServer:
        """The server this handler belongs to.

        Returns:
            The demo server.

        Raises:
            RuntimeError: When the handler runs on a server that is not a `DemoHTTPServer`.
        """
        server = self.server
        if not isinstance(server, DemoHTTPServer):
            raise RuntimeError("the handler runs on a server without the demo context")
        return server

    @property
    def _context(self) -> _Context:
        """The context of the server this handler belongs to.

        Returns:
            The context.
        """
        return self._demo.context

    def log_message(self, format: str, *args: object) -> None:
        """Silences the default access log: request lines hold the site and must not reach a file.

        Args:
            format: The format string of the base class.
            args: Its arguments.
        """

    def do_GET(self) -> None:
        """Handles a GET request."""
        self._dispatch("GET")

    def do_POST(self) -> None:
        """Handles a POST request."""
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        """Runs the checks, then the route. An unexpected error becomes a generic 500.

        Args:
            method: The HTTP method.
        """
        try:
            self._handle(method)
        except Exception as failure:
            # The class name only: the message of an unexpected error may hold a path or a value.
            logger.error("unhandled request error: %s", type(failure).__name__)
            self._problem(500, "INTERNAL", "Unexpected error. The local log has the details.")

    def _handle(self, method: str) -> None:
        """Applies the checks in order and routes the request.

        Args:
            method: The HTTP method.
        """
        port = self._demo.bound_port
        if not host_allowed(self.headers.get("Host"), port):
            self._problem(421, "HOST", "The Host header is not allowed.")
            return
        if method == "POST":
            if not origin_allowed(self.headers.get("Origin"), port):
                self._problem(403, "ORIGIN", "The Origin header is not allowed.")
                return
            if not json_content_type(self.headers.get("Content-Type")):
                self._problem(415, "CONTENT_TYPE", "The request body must be application/json.")
                return
        route = urlsplit(self.path)
        if method == "GET" and route.path in STATIC_FILES:
            self._serve_static(route.path)
            return
        if not token_ok(self.headers.get("Authorization"), self._context.token):
            self._problem(
                401,
                "UNAUTHORIZED",
                "The access token is missing or wrong.",
                extra={"WWW-Authenticate": "Bearer"},
            )
            return
        if (method, route.path) not in API_ROUTES:
            if any(path == route.path for _, path in API_ROUTES):
                self._problem(405, "METHOD", "The method is not allowed on this path.")
            else:
                self._problem(404, "NOT_FOUND", "No such page or endpoint.")
            return
        query = parse_qs(route.query, keep_blank_values=True)
        try:
            self._route_api(method, route.path, query)
        except DemoError as failure:
            status = _STATUS_BY_CODE.get(failure.code, 503)
            self._problem(status, failure.code, failure.message)

    def _route_api(self, method: str, path: str, query: Mapping[str, list[str]]) -> None:
        """Calls the handler of an authenticated, known API route.

        Args:
            method: The HTTP method.
            path: The request path.
            query: The parsed query string.

        Raises:
            DemoError: From the controller, for the codes the response mapping knows.
        """
        if method == "GET" and path == "/api/config":
            self._get_config()
        elif method == "GET" and path == "/api/status":
            self._get_status(query)
        elif method == "POST" and path == "/api/start":
            self._post_start()
        elif method == "POST" and path == "/api/stop":
            self._post_stop()
        elif method == "GET" and path == "/api/links":
            self._get_links()
        elif method == "GET" and path == "/api/users":
            self._get_users()
        elif method == "POST" and path == "/api/accounts":
            self._post_account()
        else:
            self._get_robots(query)

    def _query_site(self, query: Mapping[str, list[str]]) -> str | None:
        """Reads the one `site` parameter of a query.

        Args:
            query: The parsed query string.

        Returns:
            The site, as sent, or None when the parameter is missing or repeated. The
            controller checks it.
        """
        values = query.get("site", [])
        return values[0] if len(values) == 1 else None

    def _get_config(self) -> None:
        """Serves the site list and the simulator settings. No AWS call."""
        settings = self._context.settings
        self._json(
            200,
            {
                "sites": [{"id": settings.site_id, "readOnly": True}],
                "simCount": settings.sim_count,
                "maxSimCount": MAX_SIM_COUNT,
                "maxRuntimeS": settings.max_runtime_s,
            },
        )

    def _get_status(self, query: Mapping[str, list[str]]) -> None:
        """Serves the status of the demo for a site.

        Args:
            query: The parsed query string, with `site`.
        """
        site_id = self._query_site(query)
        if site_id is None:
            self._problem(400, "SITE_REQUIRED", "The site parameter is required once.")
            return
        self._json(200, _status_payload(self._context.controller.status(site_id)))

    def _post_start(self) -> None:
        """Starts the simulators: 202 while the worker runs, 200 when nothing had to start."""
        body = self._read_body(_SiteBody)
        if body is None:
            return
        status = self._context.controller.start(body.site, body.count)
        self._json(202 if status.phase == "starting" else 200, _status_payload(status))

    def _post_stop(self) -> None:
        """Stops the simulators. Answers 202 while the worker runs."""
        body = self._read_body(_SiteBody)
        if body is None:
            return
        status = self._context.controller.stop(body.site)
        self._json(202 if status.phase == "stopping" else 200, _status_payload(status))

    def _get_links(self) -> None:
        """Serves the three console links, built from the stack outputs."""
        links = build_links(self._context.controller.stack_outputs())
        self._json(
            200,
            {
                "console": links.console_url,
                "cognitoUsers": links.cognito_users_url,
                "iotThings": links.iot_things_url,
            },
        )

    def _get_users(self) -> None:
        """Serves the operator accounts of the pool. The users are global to the pool."""
        rows = self._context.controller.users(self._context.settings.site_id)
        self._json(200, {"users": [_user_payload(row) for row in rows]})

    def _get_robots(self, query: Mapping[str, list[str]]) -> None:
        """Serves the robots of a site.

        Args:
            query: The parsed query string, with `site`.
        """
        site_id = self._query_site(query)
        if site_id is None:
            self._problem(400, "SITE_REQUIRED", "The site parameter is required once.")
            return
        rows = self._context.controller.robots(site_id)
        self._json(200, {"robots": [_robot_payload(row) for row in rows]})

    def _post_account(self) -> None:
        """Creates an operator account or resets one, and answers the temporary password once.

        The answer is the only place the password appears. It is sent with `Cache-Control:
        no-store` like every answer, and nothing else in the page keeps it.
        """
        body = self._read_body(AccountBody)
        if body is None:
            return
        result = self._context.accounts.write(body)
        self._json(
            201 if result.outcome == "created" else 200,
            {
                "outcome": result.outcome,
                "role": result.role,
                "temporaryPassword": result.temporary_password,
                "expiresInHours": TEMPORARY_PASSWORD_HOURS,
            },
        )

    def _read_body[ModelT: BaseModel](self, model: type[ModelT]) -> ModelT | None:
        """Reads and validates the JSON body of a request against its model.

        Answers the problem itself when the body is refused, so the caller only stops.

        Args:
            model: The request model. Unknown fields are refused by every model.

        Returns:
            The validated body, or None when the request was refused and answered.
        """
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            self._problem(411, "LENGTH_REQUIRED", "The request must state its Content-Length.")
            return None
        # isdigit alone accepts digits of other scripts: the header must be plain ASCII.
        if not (length_text.isascii() and length_text.isdigit()):
            self._problem(400, "BAD_LENGTH", "The Content-Length header is not a number.")
            return None
        length = int(length_text)
        if length > MAX_BODY_BYTES:
            # The unread body would confuse the next request on this connection, so it is closed.
            self.close_connection = True
            self._problem(413, "BODY_TOO_LARGE", "The request body is too large.")
            return None
        raw = self.rfile.read(length)
        try:
            return model.model_validate_json(raw)
        except ValidationError as failure:
            # The body is never echoed: it is user input, and its validation details add nothing.
            code = _refusal_code(failure)
            self._problem(400, code, ERROR_MESSAGES[code])
            return None

    def _serve_static(self, path: str) -> None:
        """Serves one of the three allow-listed static files.

        Args:
            path: The request path, already known to be in `STATIC_FILES`.
        """
        file_name, content_type = STATIC_FILES[path]
        try:
            body = (self._context.static_dir / file_name).read_bytes()
        except OSError:
            self._problem(404, "NOT_FOUND", "No such page or endpoint.")
            return
        self._send(200, body, content_type)

    def _json(self, status: int, payload: Mapping[str, object]) -> None:
        """Sends a JSON answer.

        Args:
            status: The HTTP status.
            payload: The JSON-ready body.
        """
        self._send(status, json.dumps(payload).encode("utf-8"), JSON_TYPE)

    def _problem(
        self,
        status: int,
        code: str,
        message: str,
        *,
        extra: Mapping[str, str] | None = None,
    ) -> None:
        """Sends an RFC 7807 problem with a fixed message.

        Args:
            status: The HTTP status.
            code: The stable code.
            message: The fixed message.
            extra: Additional headers, such as `WWW-Authenticate`.
        """
        self._send(status, _problem_body(status, code, message), PROBLEM_TYPE, extra)

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str,
        extra: Mapping[str, str] | None = None,
    ) -> None:
        """Writes a response with the security headers on every answer.

        Args:
            status: The HTTP status.
            body: The body.
            content_type: The Content-Type header.
            extra: Additional headers.
        """
        self.send_response(status)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)
