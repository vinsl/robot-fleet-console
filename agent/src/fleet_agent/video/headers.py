"""Security headers of every response of the local video page.

The page is a browser application served by the robot, so it carries the policies a browser
enforces: a content security policy that only lets the page talk to its own origin and to the
robot's region of the signalling service, no framing, no referrer, and no cross-origin reads.
"""

from __future__ import annotations

from typing import get_args

from fleet_agent.protocol.primitives import Region

_CSP_TEMPLATE = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "font-src 'self'; media-src 'self'; "
    "connect-src 'self' https://kinesisvideo.{region}.amazonaws.com "
    "https://*.kinesisvideo.{region}.amazonaws.com wss://*.kinesisvideo.{region}.amazonaws.com; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
)
"""The policy. The region is bound into `connect-src`, so the page reaches only that region."""

_PERMISSIONS_POLICY = "camera=(self), microphone=(), geolocation=(), display-capture=(), payment=()"
"""The camera is allowed for this page only; every other sensor and capability is refused."""


def content_security_policy(region: str) -> str:
    """Builds the content security policy for one region.

    Args:
        region: The region the robot's channel lives in. It must be a supported region.

    Returns:
        The policy text, exactly as sent in the `Content-Security-Policy` header.

    Raises:
        ValueError: If the region is not one the protocol supports.
    """
    if region not in get_args(Region):
        raise ValueError("unsupported region")
    return _CSP_TEMPLATE.format(region=region)


def security_headers(region: str) -> dict[str, str]:
    """Returns the headers that every response of the page carries, errors included.

    Args:
        region: The region the robot's channel lives in.

    Returns:
        The header names and values. No response carries any `Access-Control-*` header.

    Raises:
        ValueError: If the region is not one the protocol supports.
    """
    return {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Permissions-Policy": _PERMISSIONS_POLICY,
        "Content-Security-Policy": content_security_policy(region),
    }
