"""Routes and request rules of the local video page.

The application answers the five routes of the page and nothing else. Each request passes the
checks in a fixed order (rate, host, fetch site, route, then the route's own origin, content type
and authorization checks), and each refusal is an RFC 7807 problem plus one log line that carries
the reason, never a header value.

The application holds the claim, the credentials and a read-only snapshot callable. It has no
reference to the core, the transport or any command path, so the page cannot command the robot.
"""

from __future__ import annotations

import dataclasses
import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final

from fleet_agent.core.ids import uuid7
from fleet_agent.core.snapshot import AgentSnapshot
from fleet_agent.protocol.robot_video import VideoClaimResponse, VideoSession, VideoStatus
from fleet_agent.video.assets import StaticAssets
from fleet_agent.video.claim import ClaimGate, ClaimGranted, ClaimRefused
from fleet_agent.video.constants import (
    LOOPBACK_HOST,
    MAX_BODY_BYTES,
    RATE_BURST,
    RATE_LOG_INTERVAL_S,
    RATE_PER_S,
)
from fleet_agent.video.credentials import CredentialsKeeper
from fleet_agent.video.headers import security_headers
from fleet_agent.video.http_server import Request, Response, problem_response

SnapshotSource = Callable[[], AgentSnapshot | None]
"""Reads the core's state without touching it. None means the core no longer runs."""

EventSink = Callable[[str, Mapping[str, object]], None]
"""Receives one log event, with its allowlisted fields."""

_API_CLAIM: Final = "/api/claim"
_API_SESSION: Final = "/api/session"
_API_STATUS: Final = "/api/status"
_JSON: Final = "application/json"
_CLAIM_CONTENT_TYPE: Final = "application/json"
_CLAIM_KEY: Final = "claim"

_CLAIM_REFUSALS: Final[Mapping[str, tuple[int, str, str]]] = {
    "wrong": (401, "claim-wrong", "The address is not valid"),
    "used": (409, "claim-used", "The address was already used"),
    "expired": (410, "claim-expired", "The address has expired"),
    "locked": (423, "claim-locked", "The address is locked"),
}
"""Status, problem type and title of each claim refusal."""


@dataclass(frozen=True, slots=True)
class VideoIdentity:
    """The robot's channel, as the session names it.

    Attributes:
        robot_id: The robot identifier.
        region: The region the channel lives in.
        channel_name: The channel name, `mfc-demo-<robot>`.
        channel_arn: The ARN of the channel, from the kit.
    """

    robot_id: str
    region: str
    channel_name: str
    channel_arn: str


class _TokenBucket:
    """A token bucket that caps the request rate of the whole page, across every client."""

    def __init__(self, rate_per_s: float, burst: int) -> None:
        """Creates a full bucket.

        Args:
            rate_per_s: Tokens added per second.
            burst: The bucket's capacity.
        """
        self._rate = rate_per_s
        self._capacity = float(burst)
        self._tokens = float(burst)
        self._last: float | None = None

    def take(self) -> bool:
        """Takes one token, if one is left.

        Returns:
            True when the request may proceed, false when the bucket is empty.
        """
        now = time.monotonic()
        if self._last is not None:
            elapsed_s = now - self._last
            self._tokens = min(self._capacity, self._tokens + elapsed_s * self._rate)
        self._last = now
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False


class VideoApp:
    """Answers the page's requests. Every answer carries the security headers, errors included."""

    def __init__(
        self,
        *,
        port: int,
        region: str,
        assets: StaticAssets,
        claim: ClaimGate,
        keeper: CredentialsKeeper,
        snapshot: SnapshotSource,
        identity: VideoIdentity,
        on_event: EventSink,
    ) -> None:
        """Creates the application.

        Args:
            port: The port the page listens on. The Host and Origin checks name it.
            region: The region, which fixes the content security policy.
            assets: The verified static files.
            claim: The one-time claim and the session key.
            keeper: The credentials the session route returns.
            snapshot: Reads the core's state, read-only.
            identity: The robot's channel.
            on_event: Receives every log event this application writes.
        """
        self._port = port
        self._assets = assets
        self._claim = claim
        self._keeper = keeper
        self._snapshot = snapshot
        self._identity = identity
        self._on_event = on_event
        self._headers = security_headers(region)
        self._origin = f"http://{LOOPBACK_HOST}:{port}"
        self._host = f"{LOOPBACK_HOST}:{port}"
        self._bucket = _TokenBucket(RATE_PER_S, RATE_BURST)
        self._rate_logged_at: float | None = None
        self._rate_suppressed = 0

    async def handle(self, request: Request) -> Response:
        """Answers one request, and adds the security headers to the answer.

        Args:
            request: The parsed request.

        Returns:
            The response.
        """
        response = await self._dispatch(request)
        return dataclasses.replace(response, headers={**self._headers, **response.headers})

    async def _dispatch(self, request: Request) -> Response:
        """Runs the checks in their fixed order, then the route.

        Args:
            request: The parsed request.

        Returns:
            The response of the first failed check, or of the route.
        """
        if not self._bucket.take():
            return self._rate_refused()
        if request.headers.get("host") != self._host:
            return self._refuse(400, "host-refused", "Host not allowed", "HOST")
        site = request.headers.get("sec-fetch-site")
        if site is not None and not self._fetch_site_allowed(request, site):
            return self._refuse(
                403, "fetch-site-refused", "Cross-site request refused", "FETCH_SITE"
            )
        allowed = self._allowed_methods(request.target)
        if not allowed:
            return problem_response(404, "not-found", "Not found")
        if request.method not in allowed:
            return problem_response(
                405,
                "method-not-allowed",
                "Method not allowed",
                headers={"Allow": ", ".join(sorted(allowed))},
            )
        if request.target == _API_CLAIM:
            return self._claim_route(request)
        if request.target == _API_SESSION:
            return self._session_route(request)
        if request.target == _API_STATUS:
            return self._status_route(request)
        return self._asset_route(request.target)

    def _fetch_site_allowed(self, request: Request, site: str) -> bool:
        """Tells whether a `Sec-Fetch-Site` value is acceptable for the request.

        Args:
            request: The request.
            site: The header value, which is present.

        Returns:
            True for `same-origin`, and for `none` only on the index page.
        """
        if site == "same-origin":
            return True
        return site == "none" and request.method == "GET" and request.target == "/"

    def _allowed_methods(self, path: str) -> frozenset[str]:
        """Returns the methods a route accepts, or none when the path is not a route.

        Args:
            path: The request target. A query string never matches a route.

        Returns:
            The accepted methods; empty for an unknown path.
        """
        if path == _API_CLAIM:
            return frozenset({"POST"})
        if path in (_API_SESSION, _API_STATUS):
            return frozenset({"GET"})
        if self._assets.lookup(path) is not None:
            return frozenset({"GET"})
        return frozenset()

    def _claim_route(self, request: Request) -> Response:
        """Checks and handles a claim: the origin, the content type, the body, then the token.

        Args:
            request: The POST request.

        Returns:
            The session key on success, or the refusal.
        """
        if request.headers.get("origin") != self._origin:
            return self._refuse(403, "origin-refused", "Origin not allowed", "ORIGIN")
        if request.headers.get("content-type") != _CLAIM_CONTENT_TYPE:
            return self._refuse(400, "content-type-refused", "Content type refused", "CONTENT_TYPE")
        if len(request.body) > MAX_BODY_BYTES:
            return self._refuse(413, "payload-too-large", "Payload too large", "SIZE")
        presented = _claim_value(request.body)
        if presented is None:
            return self._refuse(400, "bad-request", "Bad request", "PARSE")
        result = self._claim.claim(presented)
        if isinstance(result, ClaimGranted):
            body = VideoClaimResponse.model_validate(
                {"sessionKey": result.session_key}
            ).model_dump_json(by_alias=True)
            self._emit("video.claimed")
            return Response(status=200, headers={"Content-Type": _JSON}, body=body.encode("utf-8"))
        return self._claim_refused(result)

    def _session_route(self, request: Request) -> Response:
        """Returns the robot's channel and the credentials that reach it.

        Args:
            request: The GET request, already known to be a route.

        Returns:
            The session, or a refusal, or 503 while no credentials are held.
        """
        refused = self._check_api_get(request)
        if refused is not None:
            return refused
        credentials = self._keeper.current()
        if credentials is None:
            return problem_response(
                503,
                "credentials-unavailable",
                "Credentials unavailable",
                headers={"Retry-After": "5"},
            )
        session = VideoSession.model_validate(
            {
                "robotId": self._identity.robot_id,
                "region": self._identity.region,
                "channelName": self._identity.channel_name,
                "channelArn": self._identity.channel_arn,
                "credentials": credentials,
            }
        )
        return Response(
            status=200,
            headers={"Content-Type": _JSON},
            body=session.model_dump_json(by_alias=True).encode("utf-8"),
        )

    def _status_route(self, request: Request) -> Response:
        """Returns the robot's status, read from the core's snapshot.

        Args:
            request: The GET request, already known to be a route.

        Returns:
            The status, or a refusal, or 503 once the core is no longer running.
        """
        refused = self._check_api_get(request)
        if refused is not None:
            return refused
        snapshot = self._snapshot()
        if snapshot is None:
            return problem_response(503, "agent-unavailable", "Agent unavailable")
        status = VideoStatus.model_validate(
            {
                "state": snapshot.state,
                "banner": snapshot.banner,
                "lockHeld": snapshot.lock_held,
                "connected": snapshot.connected,
                "simulated": snapshot.simulated,
            }
        )
        return Response(
            status=200,
            headers={"Content-Type": _JSON},
            body=status.model_dump_json(by_alias=True).encode("utf-8"),
        )

    def _asset_route(self, path: str) -> Response:
        """Serves one verified static file.

        Args:
            path: The request target, which names a listed file.

        Returns:
            The file, with its content type.
        """
        asset = self._assets.lookup(path)
        if asset is None:
            return problem_response(404, "not-found", "Not found")
        return Response(status=200, headers={"Content-Type": asset.content_type}, body=asset.body)

    def _check_api_get(self, request: Request) -> Response | None:
        """Checks the origin and the bearer key of a session or status request.

        Args:
            request: The GET request.

        Returns:
            None when the request may proceed, otherwise the refusal.
        """
        origin = request.headers.get("origin")
        if origin is not None and origin != self._origin:
            return self._refuse(403, "origin-refused", "Origin not allowed", "ORIGIN")
        if not self._claim.authorize(request.headers.get("authorization")):
            return self._refuse(
                401,
                "unauthorised",
                "Unauthorised",
                "AUTH",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return None

    def _claim_refused(self, refusal: ClaimRefused) -> Response:
        """Builds and logs a claim refusal. The presented value is never logged.

        Args:
            refusal: The refusal of the claim gate.

        Returns:
            The problem response for the refusal.
        """
        status, suffix, title = _CLAIM_REFUSALS[refusal.code]
        correlation_id = uuid7()
        self._emit("video.claim_refused", reason=refusal.code, correlationId=correlation_id)
        return problem_response(status, suffix, title, correlation_id=correlation_id)

    def _refuse(
        self,
        status: int,
        suffix: str,
        title: str,
        reason: str,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> Response:
        """Builds and logs one request refusal.

        Args:
            status: The HTTP status.
            suffix: The problem type suffix.
            title: The problem title.
            reason: The log reason.
            headers: Extra header fields.

        Returns:
            The problem response.
        """
        correlation_id = uuid7()
        self._emit("video.request_refused", reason=reason, correlationId=correlation_id)
        return problem_response(
            status, suffix, title, correlation_id=correlation_id, headers=headers
        )

    def _rate_refused(self) -> Response:
        """Builds the 429 response. The log line is written at most once per interval.

        Returns:
            The rate-limit problem, with `Retry-After`.
        """
        correlation_id = uuid7()
        now = time.monotonic()
        if self._rate_logged_at is None or now - self._rate_logged_at >= RATE_LOG_INTERVAL_S:
            fields: dict[str, object] = {"reason": "RATE", "correlationId": correlation_id}
            if self._rate_suppressed:
                fields["suppressed"] = self._rate_suppressed
            self._rate_suppressed = 0
            self._rate_logged_at = now
            self._on_event("video.request_refused", fields)
        else:
            self._rate_suppressed += 1
        return problem_response(
            429,
            "rate-limited",
            "Too many requests",
            correlation_id=correlation_id,
            headers={"Retry-After": "1"},
        )

    def _emit(self, event: str, **fields: object) -> None:
        """Passes one log event to the sink.

        Args:
            event: The event name.
            **fields: The allowlisted fields of the event.
        """
        self._on_event(event, dict(fields))


def _claim_value(body: bytes) -> str | None:
    """Reads the token of a claim body, which must be exactly `{"claim": "<text>"}`.

    Args:
        body: The raw request body.

    Returns:
        The presented text, or None when the body has another shape.
    """
    try:
        document: object = json.loads(body)
    except (ValueError, RecursionError):
        return None
    if not isinstance(document, dict) or set(document) != {_CLAIM_KEY}:
        return None
    value = document[_CLAIM_KEY]
    return value if isinstance(value, str) else None
