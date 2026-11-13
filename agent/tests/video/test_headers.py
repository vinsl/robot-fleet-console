"""Tests of the security headers: the exact policy, the region binding, and every response."""

from __future__ import annotations

from pathlib import Path

import pytest

from fleet_agent.video.headers import content_security_policy, security_headers
from fleet_agent.video.http_server import Request
from tests.video.support import (
    HOST_HEADER,
    FakeSource,
    build_app,
    freeze_rate_clock,
    ready_keeper,
    valid_credentials,
)

_CSP_TEMPLATE = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "font-src 'self'; media-src 'self'; "
    "connect-src 'self' https://kinesisvideo.{r}.amazonaws.com "
    "https://*.kinesisvideo.{r}.amazonaws.com wss://*.kinesisvideo.{r}.amazonaws.com; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
)

_REQUIRED = (
    "Cache-Control",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "X-Frame-Options",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
    "Permissions-Policy",
    "Content-Security-Policy",
)


@pytest.mark.parametrize("region", ["eu-west-3", "eu-west-1"])
def test_the_csp_text_is_exact_for_each_supported_region(region: str) -> None:
    assert content_security_policy(region) == _CSP_TEMPLATE.format(r=region)


def test_an_unsupported_region_is_refused() -> None:
    with pytest.raises(ValueError, match="unsupported region"):
        content_security_policy("us-east-1")
    with pytest.raises(ValueError, match="unsupported region"):
        security_headers("us-east-1")


def test_the_permissions_policy_allows_only_the_camera_and_only_to_this_page() -> None:
    assert security_headers("eu-west-3")["Permissions-Policy"] == (
        "camera=(self), microphone=(), geolocation=(), display-capture=(), payment=()"
    )


def test_security_headers_are_a_fresh_mapping_on_each_call() -> None:
    first = security_headers("eu-west-3")
    first["Cache-Control"] = "public"

    assert security_headers("eu-west-3")["Cache-Control"] == "no-store"


async def test_every_status_the_app_answers_carries_the_headers_and_no_cors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    freeze_rate_clock(monkeypatch)
    keeper = await ready_keeper(FakeSource(valid_credentials()))
    app, _gate = build_app(tmp_path, keeper=keeper)
    host = {"host": HOST_HEADER}
    cases = {
        200: Request("GET", "/", host, b"", "127.0.0.1"),
        404: Request("GET", "/nowhere", host, b"", "127.0.0.1"),
        401: Request("GET", "/api/status", host, b"", "127.0.0.1"),
        400: Request("GET", "/", {"host": "evil.example"}, b"", "127.0.0.1"),
    }

    for expected_status, request in cases.items():
        response = await app.handle(request)
        assert response.status == expected_status
        for name in _REQUIRED:
            assert name in response.headers
        assert not any(name.lower().startswith("access-control-") for name in response.headers)

    for _ in range(60):
        await app.handle(Request("GET", "/", host, b"", "127.0.0.1"))
    limited = await app.handle(Request("GET", "/", host, b"", "127.0.0.1"))

    assert limited.status == 429
    for name in _REQUIRED:
        assert name in limited.headers
