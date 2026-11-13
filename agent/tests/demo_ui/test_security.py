"""Tests of the request checks: Host, Origin, JSON content type, bearer token and headers."""

from __future__ import annotations

import pytest

from fleet_agent.demo_ui.security import (
    SECURITY_HEADERS,
    host_allowed,
    json_content_type,
    new_token,
    origin_allowed,
    token_ok,
)


@pytest.mark.parametrize(
    ("host", "allowed"),
    [
        ("127.0.0.1:8765", True),
        ("localhost:8765", True),
        ("LOCALHOST:8765", True),
        ("evil.com:8765", False),
        ("127.0.0.1:9999", False),
        ("127.0.0.1", False),
        (None, False),
    ],
)
def test_host_header_must_name_this_page(host: str | None, allowed: bool) -> None:
    assert host_allowed(host, 8765) is allowed


@pytest.mark.parametrize(
    ("origin", "allowed"),
    [
        ("http://127.0.0.1:8765", True),
        ("http://localhost:8765", True),
        ("https://evil.example", False),
        ("http://127.0.0.1:9999", False),
        ("null", False),
        (None, False),
    ],
)
def test_origin_must_be_this_page(origin: str | None, allowed: bool) -> None:
    assert origin_allowed(origin, 8765) is allowed


@pytest.mark.parametrize(
    ("header", "allowed"),
    [
        ("application/json", True),
        ("application/json; charset=utf-8", True),
        ("Application/JSON", True),
        ("text/plain", False),
        ("application/x-www-form-urlencoded", False),
        (None, False),
    ],
)
def test_body_must_be_declared_as_json(header: str | None, allowed: bool) -> None:
    assert json_content_type(header) is allowed


def test_token_comparison_accepts_only_the_bearer_token_of_this_run() -> None:
    expected = "tok-expected"

    assert token_ok(f"Bearer {expected}", expected)
    assert not token_ok(f"Bearer {expected}x", expected)
    assert not token_ok("Bearer wrong", expected)
    assert not token_ok(expected, expected)
    assert not token_ok(None, expected)


def test_new_token_is_long_and_unique() -> None:
    first, second = new_token(), new_token()

    assert len(first) >= 43
    assert first != second


def test_response_headers_carry_the_policy() -> None:
    assert SECURITY_HEADERS["X-Content-Type-Options"] == "nosniff"
    assert SECURITY_HEADERS["Cache-Control"] == "no-store"
    assert SECURITY_HEADERS["Referrer-Policy"] == "no-referrer"
    policy = SECURITY_HEADERS["Content-Security-Policy"]
    assert "default-src 'none'" in policy
    assert "script-src 'self'" in policy
    assert "frame-ancestors 'none'" in policy


def test_anti_framing_and_form_posting_are_blocked() -> None:
    assert "form-action 'none'" in SECURITY_HEADERS["Content-Security-Policy"]
    assert SECURITY_HEADERS["X-Frame-Options"] == "DENY"
    assert SECURITY_HEADERS["Cross-Origin-Resource-Policy"] == "same-origin"
