"""Request checks of the demo control page: Host, Origin, content type and the bearer token.

The page listens on the loopback address only. Those checks defend it against the threats that
remain on a developer machine: a web page in another tab (DNS rebinding, cross-site form posts) and
another local process that guesses the port. The token is printed once at start-up and is never
stored or logged.
"""

from __future__ import annotations

import hmac
import secrets
from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from fleet_agent.demo_ui.config import LOOPBACK_HOST

TOKEN_BYTES: Final = 32
"""Entropy of the bearer token, in bytes (256 bits)."""

BEARER_PREFIX: Final = "Bearer "

SECURITY_HEADERS: Final[Mapping[str, str]] = MappingProxyType(
    {
        # No script or style from anywhere but this origin, no framing, no inline code: the page is
        # three files.
        "Content-Security-Policy": (
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        ),
        # Older browsers ignore frame-ancestors: X-Frame-Options covers them.
        "X-Frame-Options": "DENY",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
        # Responses carry account names and sites: nothing may cache them on disk or in a proxy.
        "Cache-Control": "no-store",
        # The token travels in the fragment of the start URL; it must never leave the page in a
        # Referer.
        "Referrer-Policy": "no-referrer",
    }
)
"""Headers added to every response, errors included."""


def _loopback_origins(port: int) -> frozenset[str]:
    """Lists the origins that name this page.

    Args:
        port: The port the page listens on.

    Returns:
        The origins of the loopback address and of `localhost`, on that port.
    """
    return frozenset({f"http://{LOOPBACK_HOST}:{port}", f"http://localhost:{port}"})


def host_allowed(host: str | None, port: int) -> bool:
    """Accepts only the Host headers that name this page. This blocks DNS rebinding.

    Args:
        host: The Host header of the request, or None when absent.
        port: The port the page listens on.

    Returns:
        True when the header is `127.0.0.1:PORT` or `localhost:PORT`.
    """
    if host is None:
        return False
    return host.lower() in {f"{LOOPBACK_HOST}:{port}", f"localhost:{port}"}


def origin_allowed(origin: str | None, port: int) -> bool:
    """Accepts a state-changing request only from this page. This blocks cross-site form posts.

    Args:
        origin: The Origin header, or None when absent.
        port: The port the page listens on.

    Returns:
        True when the origin is the page's own loopback origin.
    """
    if origin is None:
        return False
    return origin.lower() in _loopback_origins(port)


def json_content_type(header: str | None) -> bool:
    """Checks that a body is declared as JSON, which forces a CORS preflight for a form.

    Args:
        header: The Content-Type header, or None when absent.

    Returns:
        True for `application/json`, with or without parameters such as the charset.
    """
    if header is None:
        return False
    media_type = header.split(";", 1)[0].strip().lower()
    return media_type == "application/json"


def token_ok(header: str | None, expected: str) -> bool:
    """Compares the bearer token of a request with the token of this run, in constant time.

    Args:
        header: The Authorization header, or None when absent.
        expected: The token printed at start-up.

    Returns:
        True only for `Bearer <expected>`.
    """
    if header is None or not header.startswith(BEARER_PREFIX):
        return False
    presented = header[len(BEARER_PREFIX) :].encode("utf-8")
    return hmac.compare_digest(presented, expected.encode("utf-8"))


def new_token() -> str:
    """Creates the token of one run of the page.

    Returns:
        A URL-safe random string of 256 bits. It is kept in memory and printed once.
    """
    return secrets.token_urlsafe(TOKEN_BYTES)
