"""Tests of the HTTP server: the denied-access table, headers, errors and static files.

The server runs on port 0 with a fake controller, so no request reaches AWS or a script.
"""

from __future__ import annotations

import dataclasses
import http.client
import json
import socket
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from fleet_agent.demo_ui.accounts import AccountBody, AccountResult
from fleet_agent.demo_ui.aws_reads import RobotRow, UserRow
from fleet_agent.demo_ui.config import load_settings
from fleet_agent.demo_ui.demo import DemoStatus
from fleet_agent.demo_ui.errors import ERROR_MESSAGES, DemoError, ProblemInfo
from fleet_agent.demo_ui.outputs import StackOutputs
from fleet_agent.demo_ui.security import SECURITY_HEADERS
from fleet_agent.demo_ui.server import MAX_BODY_BYTES, _Handler, make_server
from tests.demo_ui.fakes import STACK

TOKEN = "test-token-0123456789abcdefghijklmnopqrstuvwxyz"  # noqa: S105 - a fixed test value
SITE = "paris-01"
PASSWORD = "Zm9vYmFyYmF6cXV4MTIzNDU2Aa1!"  # noqa: S105 - a fixed test value: 24 base64 chars + suffix
ACCOUNT_BODY = b'{"email": "ada@example.test", "role": "Operator"}'
ACCOUNT_KEYS = {"outcome", "role", "temporaryPassword", "expiresInHours"}


def _status(phase: str = "running", error: ProblemInfo | None = None) -> DemoStatus:
    return DemoStatus(
        phase=phase,  # type: ignore[arg-type]
        consumer="Enabled",
        simulators_running=phase == "running",
        sim_count=9,
        auto_stop_at="2026-11-04T10:00:00Z",
        real_robots=(
            RobotRow("kali-01", "Kali", "real", "ACTIVE", "online", "2026-11-04T09:00:00Z"),
        ),
        step=None,
        error=error,
        console_url=STACK.console_origin,
    )


@dataclass
class FakeController:
    """Answers the server's calls with canned values and records them."""

    start_phase: str = "running"
    fail_with: dict[str, DemoError] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    started_counts: list[int | None] = field(default_factory=list)

    def _check(self, name: str, site_id: str) -> None:
        self.calls.append(name)
        if name in self.fail_with:
            raise self.fail_with[name]
        if site_id != SITE:
            raise DemoError("UNKNOWN_SITE")

    def status(self, site_id: str) -> DemoStatus:
        self._check("status", site_id)
        return _status()

    def start(self, site_id: str, count: int | None = None) -> DemoStatus:
        self._check("start", site_id)
        self.started_counts.append(count)
        return _status(self.start_phase)

    def stop(self, site_id: str) -> DemoStatus:
        self._check("stop", site_id)
        return _status("stopping")

    def stack_outputs(self) -> StackOutputs:
        self.calls.append("stack_outputs")
        return STACK

    def users(self, site_id: str) -> list[UserRow]:
        self._check("users", site_id)
        return [UserRow("ada@example.test", "Admin", "CONFIRMED", True)]

    def robots(self, site_id: str) -> list[RobotRow]:
        self._check("robots", site_id)
        return [RobotRow("sim-01", "Sim", "simulated", "ACTIVE", "unknown", None)]


@dataclass
class FakeAccounts:
    """Answers the account writer's calls with a canned password and records the bodies."""

    fail_with: DemoError | None = None
    calls: list[AccountBody] = field(default_factory=list)

    def write(self, body: AccountBody) -> AccountResult:
        self.calls.append(body)
        if self.fail_with is not None:
            raise self.fail_with
        outcome = "reset" if body.reset else "created"
        return AccountResult(outcome=outcome, role=body.role, temporary_password=PASSWORD)


@dataclass
class Running:
    port: int
    controller: FakeController
    accounts: FakeAccounts


@pytest.fixture
def running(tmp_path: Path) -> Iterator[Running]:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>demo</title>", encoding="utf-8")
    (static / "app.js").write_text("console.log('demo');", encoding="utf-8")
    (static / "app.css").write_text("body{}", encoding="utf-8")
    settings = dataclasses.replace(load_settings({"HOME": str(tmp_path)}, []), port=0)
    controller = FakeController()
    accounts = FakeAccounts()
    server = make_server(
        settings,
        controller,
        TOKEN,
        accounts=accounts,
        static_dir=static,  # type: ignore[arg-type]
    )
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    try:
        yield Running(port=server.bound_port, controller=controller, accounts=accounts)
    finally:
        server.shutdown()
        server.server_close()


def _request(
    port: int,
    method: str,
    path: str,
    *,
    host: str | None = None,
    token: str | None = TOKEN,
    origin: str | None = None,
    content_type: str | None = "application/json",
    body: bytes | None = None,
) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    connection.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
    if token is not None:
        connection.putheader("Authorization", f"Bearer {token}")
    if method == "POST":
        connection.putheader("Origin", origin if origin is not None else f"http://127.0.0.1:{port}")
    if content_type is not None:
        connection.putheader("Content-Type", content_type)
    if body is not None:
        connection.putheader("Content-Length", str(len(body)))
    connection.endheaders()
    if body is not None:
        connection.send(body)
    response = connection.getresponse()
    data = response.read()
    headers = {name.lower(): value for name, value in response.getheaders()}
    connection.close()
    return response.status, headers, data


def _json(data: bytes) -> dict[str, object]:
    loaded: object = json.loads(data)
    assert isinstance(loaded, dict)
    return loaded


API_CASES: list[tuple[str, str, bytes | None]] = [
    ("GET", "/api/config", None),
    ("GET", "/api/status?site=paris-01", None),
    ("POST", "/api/start", b'{"site": "paris-01"}'),
    ("POST", "/api/stop", b'{"site": "paris-01"}'),
    ("GET", "/api/links", None),
    ("GET", "/api/users", None),
    ("GET", "/api/robots?site=paris-01", None),
    ("POST", "/api/accounts", ACCOUNT_BODY),
]


@pytest.mark.parametrize(("method", "path", "body"), API_CASES)
def test_api_without_a_token_is_401_and_reaches_no_controller(
    running: Running, method: str, path: str, body: bytes | None
) -> None:
    status, headers, data = _request(running.port, method, path, token=None, body=body)

    assert status == 401
    assert headers["www-authenticate"] == "Bearer"
    assert _json(data)["code"] == "UNAUTHORIZED"
    assert running.controller.calls == []


@pytest.mark.parametrize(("method", "path", "body"), API_CASES)
def test_api_with_a_wrong_token_is_401(
    running: Running, method: str, path: str, body: bytes | None
) -> None:
    status, _, _ = _request(running.port, method, path, token="wrong-token", body=body)  # noqa: S106

    assert status == 401
    assert running.controller.calls == []


@pytest.mark.parametrize(("method", "path", "body"), API_CASES)
def test_api_with_a_foreign_host_is_421(
    running: Running, method: str, path: str, body: bytes | None
) -> None:
    status, _, _ = _request(
        running.port, method, path, host="evil.example:" + str(running.port), body=body
    )

    assert status == 421
    assert running.controller.calls == []


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [case for case in API_CASES if case[0] == "POST"],
)
def test_post_with_a_foreign_origin_is_403(
    running: Running, method: str, path: str, body: bytes | None
) -> None:
    status, _, _ = _request(running.port, method, path, origin="https://evil.example", body=body)

    assert status == 403
    assert running.controller.calls == []


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [case for case in API_CASES if case[0] == "POST"],
)
def test_post_with_a_form_content_type_is_415(
    running: Running, method: str, path: str, body: bytes | None
) -> None:
    status, _, _ = _request(running.port, method, path, content_type="text/plain", body=body)

    assert status == 415
    assert running.controller.calls == []


@pytest.mark.parametrize("path", ["/", "/app.js", "/app.css"])
def test_static_files_need_no_token_but_still_need_the_right_host(
    running: Running, path: str
) -> None:
    status, _, _ = _request(running.port, "GET", path, token=None)
    foreign, _, _ = _request(running.port, "GET", path, token=None, host="evil.example")

    assert status == 200
    assert foreign == 421


def test_every_response_carries_the_security_headers(running: Running) -> None:
    answers = [
        _request(running.port, "GET", "/"),
        _request(running.port, "GET", "/api/config"),
        _request(running.port, "GET", "/api/config", token=None),
        _request(running.port, "POST", "/api/start", content_type="text/plain", body=b"x"),
    ]

    for status, headers, _ in answers:
        assert status in (200, 401, 415)
        for name, value in SECURITY_HEADERS.items():
            assert headers[name.lower()] == value


def test_config_lists_the_site_read_only_without_any_aws_call(running: Running) -> None:
    status, headers, data = _request(running.port, "GET", "/api/config")

    assert status == 200
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert _json(data) == {
        "sites": [{"id": SITE, "readOnly": True}],
        "simCount": 9,
        "maxSimCount": 20,
        "maxRuntimeS": 7200,
    }
    assert running.controller.calls == []


def test_status_answers_the_controller_payload_with_named_fields(running: Running) -> None:
    status, _, data = _request(running.port, "GET", f"/api/status?site={SITE}")
    body = _json(data)

    assert status == 200
    assert body["phase"] == "running"
    assert body["simulatorsRunning"] is True
    assert body["consoleUrl"] == STACK.console_origin
    assert body["realRobots"] == [
        {
            "robotId": "kali-01",
            "name": "Kali",
            "kind": "real",
            "registryStatus": "ACTIVE",
            "connection": "online",
            "lastSeen": "2026-11-04T09:00:00Z",
        }
    ]
    assert set(body) == {
        "phase",
        "consumer",
        "simulatorsRunning",
        "simCount",
        "autoStopAt",
        "consoleUrl",
        "step",
        "error",
        "realRobots",
    }


def test_status_without_the_site_parameter_is_400(running: Running) -> None:
    status, _, data = _request(running.port, "GET", "/api/status")

    assert status == 400
    assert _json(data)["code"] == "SITE_REQUIRED"


def test_unknown_site_is_a_404_problem_without_internals(running: Running) -> None:
    status, headers, data = _request(running.port, "GET", "/api/status?site=..%2Fx")

    assert status == 404
    assert headers["content-type"] == "application/problem+json"
    assert _json(data)["code"] == "UNKNOWN_SITE"
    assert b"Traceback" not in data


def test_start_answers_202_while_the_worker_runs(running: Running) -> None:
    running.controller.start_phase = "starting"

    status, _, data = _request(running.port, "POST", "/api/start", body=b'{"site": "paris-01"}')

    assert status == 202
    assert _json(data)["phase"] == "starting"


def test_start_answers_200_when_nothing_had_to_launch(running: Running) -> None:
    status, _, data = _request(running.port, "POST", "/api/start", body=b'{"site": "paris-01"}')

    assert status == 200
    assert _json(data)["phase"] == "running"


def test_start_passes_the_number_of_robots_to_the_controller(running: Running) -> None:
    status, _, _ = _request(
        running.port, "POST", "/api/start", body=b'{"site": "paris-01", "count": 12}'
    )

    assert status == 200
    assert running.controller.started_counts == [12]


def test_start_without_a_count_keeps_the_current_size(running: Running) -> None:
    _request(running.port, "POST", "/api/start", body=b'{"site": "paris-01"}')

    assert running.controller.started_counts == [None]


@pytest.mark.parametrize("count", [b"0", b"21", b"-1", b'"5"', b"5.5", b"true", b"null1"], ids=str)
def test_start_refuses_a_count_that_is_not_a_whole_number_in_range(
    running: Running, count: bytes
) -> None:
    body = b'{"site": "paris-01", "count": ' + count + b"}"

    status, _, data = _request(running.port, "POST", "/api/start", body=body)

    assert status == 400
    assert _json(data)["code"] == "INVALID_BODY"
    assert running.controller.started_counts == []


def test_config_names_the_largest_fleet(running: Running) -> None:
    _, _, data = _request(running.port, "GET", "/api/config")

    assert _json(data)["maxSimCount"] == 20


def test_stop_answers_202_while_the_worker_runs(running: Running) -> None:
    status, _, data = _request(running.port, "POST", "/api/stop", body=b'{"site": "paris-01"}')

    assert status == 202
    assert _json(data)["phase"] == "stopping"


def test_in_progress_is_a_409_problem(running: Running) -> None:
    running.controller.fail_with["start"] = DemoError("IN_PROGRESS")

    status, headers, data = _request(
        running.port, "POST", "/api/start", body=b'{"site": "paris-01"}'
    )

    assert status == 409
    assert headers["content-type"] == "application/problem+json"
    assert _json(data)["code"] == "IN_PROGRESS"


def test_dependency_failure_is_a_503_with_the_fixed_text_only(running: Running) -> None:
    running.controller.fail_with["users"] = DemoError(
        "PERMISSION_DENIED", "The AWS session lacks the permission cognito-idp:ListUsers."
    )

    status, _, data = _request(running.port, "GET", "/api/users")

    assert status == 503
    body = _json(data)
    assert body["code"] == "PERMISSION_DENIED"
    assert body["detail"] == "The AWS session lacks the permission cognito-idp:ListUsers."
    assert b"arn:" not in data
    assert b"stderr" not in data


def test_users_and_robots_payloads_use_display_fields(running: Running) -> None:
    _, _, users = _request(running.port, "GET", "/api/users")
    _, _, robots = _request(running.port, "GET", f"/api/robots?site={SITE}")

    assert _json(users) == {
        "users": [
            {
                "displayName": "ada@example.test",
                "role": "Admin",
                "status": "CONFIRMED",
                "enabled": True,
            }
        ]
    }
    assert _json(robots)["robots"] == [
        {
            "robotId": "sim-01",
            "name": "Sim",
            "kind": "simulated",
            "registryStatus": "ACTIVE",
            "connection": "unknown",
            "lastSeen": None,
        }
    ]


def test_links_are_served_from_the_stack_outputs(running: Running) -> None:
    status, _, data = _request(running.port, "GET", "/api/links")
    body = _json(data)

    assert status == 200
    assert body["console"] == STACK.console_origin
    assert str(body["cognitoUsers"]).startswith("https://eu-west-3.console.aws.amazon.com/cognito/")
    assert str(body["iotThings"]).endswith("#/thinghub")


def test_body_over_the_cap_is_413(running: Running) -> None:
    body = b'{"site": "' + b"a" * (MAX_BODY_BYTES + 10) + b'"}'

    status, _, data = _request(running.port, "POST", "/api/start", body=body)

    assert status == 413
    assert running.controller.calls == []
    assert _json(data)["code"] == "BODY_TOO_LARGE"


def test_post_without_a_content_length_is_411(running: Running) -> None:
    connection = http.client.HTTPConnection("127.0.0.1", running.port, timeout=10)
    connection.putrequest("POST", "/api/start", skip_host=True, skip_accept_encoding=True)
    connection.putheader("Host", f"127.0.0.1:{running.port}")
    connection.putheader("Authorization", f"Bearer {TOKEN}")
    connection.putheader("Origin", f"http://127.0.0.1:{running.port}")
    connection.putheader("Content-Type", "application/json")
    connection.endheaders()
    response = connection.getresponse()
    data = response.read()
    connection.close()

    assert response.status == 411
    assert _json(data)["code"] == "LENGTH_REQUIRED"


def test_invalid_body_is_400_and_never_echoed(running: Running) -> None:
    hostile = b'{"site": "paris-01", "extra": "<script>alert(1)</script>"}'

    status, _, data = _request(running.port, "POST", "/api/start", body=hostile)

    assert status == 400
    assert _json(data)["code"] == "INVALID_BODY"
    assert b"<script>" not in data
    assert running.controller.calls == []


def test_malformed_json_is_400(running: Running) -> None:
    status, _, _ = _request(running.port, "POST", "/api/stop", body=b"{not json")

    assert status == 400


@pytest.mark.parametrize(
    "path",
    ["/../settings", "/app.js/../index.html", "/%2e%2e/app.js", "/static/app.js", "/nope"],
)
def test_paths_outside_the_allow_list_are_404(running: Running, path: str) -> None:
    # The token is sent: without it the answer is 401, which tells an unknown path from a known one.
    status, headers, _ = _request(running.port, "GET", path)

    assert status == 404
    assert headers["content-type"] == "application/problem+json"


def test_known_path_with_the_wrong_method_is_405(running: Running) -> None:
    status, _, data = _request(running.port, "GET", "/api/start")

    assert status == 405
    assert _json(data)["code"] == "METHOD"


def test_static_page_is_served_as_html(running: Running) -> None:
    status, headers, data = _request(running.port, "GET", "/", token=None)

    assert status == 200
    assert headers["content-type"] == "text/html; charset=utf-8"
    assert b"<title>demo</title>" in data


def test_token_never_appears_in_a_response(running: Running) -> None:
    answers = [
        _request(running.port, "GET", "/api/config"),
        _request(running.port, "GET", f"/api/status?site={SITE}"),
        _request(running.port, "POST", "/api/start", token="wrong", body=b"{}"),  # noqa: S106
        _request(running.port, "GET", "/nope"),
    ]

    for _, headers, data in answers:
        assert TOKEN.encode() not in data
        assert TOKEN not in json.dumps(headers)


def test_error_bodies_carry_no_stack_trace(running: Running) -> None:
    status, _, data = _request(running.port, "POST", "/api/start", body=b"{}")

    assert status == 400
    assert b"Traceback" not in data
    assert b"pydantic" not in data


def _iterate(value: object) -> Iterator[object]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _iterate(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iterate(item)


def test_no_forbidden_key_reaches_the_browser(running: Running) -> None:
    forbidden = {"password", "privatekey", "token", "arn", "accountid"}
    answers = [
        _request(running.port, "GET", "/api/users"),
        _request(running.port, "GET", f"/api/robots?site={SITE}"),
        _request(running.port, "GET", f"/api/status?site={SITE}"),
    ]

    for _, _, data in answers:
        for key in _iterate(json.loads(data)):
            assert str(key).lower() not in forbidden
    # The temporary password is the one secret the page sends, and only the account route does.
    _, _, account = _request(running.port, "POST", "/api/accounts", body=ACCOUNT_BODY)
    assert set(_iterate(json.loads(account))) == ACCOUNT_KEYS


def test_content_length_must_be_plain_ascii_digits(running: Running) -> None:
    # A superscript two passes str.isdigit but is not ASCII; the header is refused, not parsed.
    raw = (
        f"POST /api/start HTTP/1.1\r\nHost: 127.0.0.1:{running.port}\r\n"
        f"Authorization: Bearer {TOKEN}\r\nOrigin: http://127.0.0.1:{running.port}\r\n"
        "Content-Type: application/json\r\nContent-Length: \xb2\r\n\r\n"
    ).encode("latin-1")
    with socket.create_connection(("127.0.0.1", running.port), timeout=10) as connection:
        connection.sendall(raw)
        # The status line and the body may arrive in separate segments: read until the close.
        answer = b""
        while chunk := connection.recv(65536):
            answer += chunk

    assert answer.split(b" ", 2)[1] == b"400"
    assert b"BAD_LENGTH" in answer
    assert running.controller.calls == []


@pytest.mark.parametrize("length", ["+5", "5x", "-1"])
def test_signed_or_mixed_content_length_is_400(running: Running, length: str) -> None:
    connection = http.client.HTTPConnection("127.0.0.1", running.port, timeout=10)
    connection.putrequest("POST", "/api/start", skip_host=True, skip_accept_encoding=True)
    connection.putheader("Host", f"127.0.0.1:{running.port}")
    connection.putheader("Authorization", f"Bearer {TOKEN}")
    connection.putheader("Origin", f"http://127.0.0.1:{running.port}")
    connection.putheader("Content-Type", "application/json")
    connection.putheader("Content-Length", length)
    connection.endheaders()
    response = connection.getresponse()
    response.read()
    connection.close()

    assert response.status == 400


def test_handler_socket_timeout_is_ten_seconds() -> None:
    assert _Handler.timeout == 10


def test_account_route_without_a_token_is_401_and_the_writer_is_not_called(
    running: Running,
) -> None:
    status, headers, data = _request(
        running.port, "POST", "/api/accounts", token=None, body=ACCOUNT_BODY
    )

    assert status == 401
    assert headers["www-authenticate"] == "Bearer"
    assert _json(data)["code"] == "UNAUTHORIZED"
    assert running.accounts.calls == []


def test_account_route_with_a_foreign_host_is_421_and_the_writer_is_not_called(
    running: Running,
) -> None:
    status, _, _ = _request(
        running.port,
        "POST",
        "/api/accounts",
        host="evil.example:" + str(running.port),
        body=ACCOUNT_BODY,
    )

    assert status == 421
    assert running.accounts.calls == []


def test_account_route_with_a_foreign_origin_is_403_and_the_writer_is_not_called(
    running: Running,
) -> None:
    status, _, _ = _request(
        running.port, "POST", "/api/accounts", origin="https://evil.example", body=ACCOUNT_BODY
    )

    assert status == 403
    assert running.accounts.calls == []


def test_account_route_with_a_form_content_type_is_415_and_the_writer_is_not_called(
    running: Running,
) -> None:
    status, _, _ = _request(
        running.port, "POST", "/api/accounts", content_type="text/plain", body=ACCOUNT_BODY
    )

    assert status == 415
    assert running.accounts.calls == []


def test_a_new_account_answers_201_with_the_password_and_no_store(running: Running) -> None:
    status, headers, data = _request(running.port, "POST", "/api/accounts", body=ACCOUNT_BODY)

    assert status == 201
    assert headers["cache-control"] == "no-store"
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert _json(data) == {
        "outcome": "created",
        "role": "Operator",
        "temporaryPassword": PASSWORD,
        "expiresInHours": 24,
    }
    assert running.accounts.calls == [AccountBody(email="ada@example.test", role="Operator")]


def test_a_reset_answers_200_with_a_new_password(running: Running) -> None:
    body = b'{"email": "ada@example.test", "role": "Viewer", "reset": true}'

    status, headers, data = _request(running.port, "POST", "/api/accounts", body=body)

    assert status == 200
    assert headers["cache-control"] == "no-store"
    assert _json(data)["outcome"] == "reset"
    assert _json(data)["temporaryPassword"] == PASSWORD


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (b'{"email": "<script>x</script>@example.test", "role": "Operator"}', "INVALID_EMAIL"),
        (b'{"email": "-ada@example.test", "role": "Operator"}', "INVALID_EMAIL"),
        (b'{"email": "ada@example.test", "role": "Admin"}', "INVALID_ROLE"),
        (b'{"email": "ada@example.test", "role": "admin"}', "INVALID_ROLE"),
        (b'{"email": "ada@example.test", "role": "Operator", "group": "Admin"}', "INVALID_BODY"),
        (b'{"email": "ada@example.test"}', "INVALID_ROLE"),
    ],
    ids=["email-markup", "email-dash", "role-admin", "role-lower", "extra-field", "no-role"],
)
def test_a_refused_account_body_is_400_with_a_code_and_never_echoed(
    running: Running, body: bytes, code: str
) -> None:
    status, headers, data = _request(running.port, "POST", "/api/accounts", body=body)

    assert status == 400
    assert headers["content-type"] == "application/problem+json"
    assert _json(data)["code"] == code
    assert b"<script>" not in data
    assert b"Admin" not in data
    assert b"group" not in data
    assert running.accounts.calls == []


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("USER_EXISTS", 409),
        ("USER_NOT_FOUND", 404),
        ("ROLE_MISMATCH", 409),
        ("ACCOUNT_PROTECTED", 403),
        ("RATE_LIMITED", 429),
    ],
)
def test_account_refusals_are_problems_with_fixed_text(
    running: Running, code: str, status: int
) -> None:
    running.accounts.fail_with = DemoError(code)  # type: ignore[arg-type]

    answer_status, headers, data = _request(
        running.port, "POST", "/api/accounts", body=ACCOUNT_BODY
    )

    assert answer_status == status
    assert headers["content-type"] == "application/problem+json"
    body = _json(data)
    assert body["code"] == code
    assert body["detail"] == ERROR_MESSAGES[code]
    assert PASSWORD.encode() not in data


def test_the_password_never_reaches_the_status_or_the_user_list(running: Running) -> None:
    _request(running.port, "POST", "/api/accounts", body=ACCOUNT_BODY)

    _, _, status = _request(running.port, "GET", f"/api/status?site={SITE}")
    _, _, users = _request(running.port, "GET", "/api/users")

    assert PASSWORD.encode() not in status
    assert PASSWORD.encode() not in users
