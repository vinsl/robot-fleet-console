"""One-time claim of the local video page, and the session key that the claim grants.

The agent prints a single-use token with a 15-minute lifetime. The first page that presents it
receives a session key, held in that page's memory only. Five wrong tokens lock the claim until the
operator re-arms it with SIGUSR1. Neither the token nor the key is ever part of a representation,
a log line or an exception.
"""

from __future__ import annotations

import hmac
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal

from fleet_agent.video.constants import CLAIM_TTL_S, MAX_CLAIM_FAILURES

ClaimPhase = Literal["OPEN", "CLAIMED", "EXPIRED", "LOCKED"]
"""Where the claim stands: open, claimed, past its lifetime, or locked."""

ClaimRefusalCode = Literal["wrong", "used", "expired", "locked"]
"""Why a presented token was refused. The string names the failed check and carries no value."""

_TOKEN_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{43}")
"""The shape of a token and of a session key: 43 URL-safe characters, as `token_urlsafe(32)`.

It is used with `fullmatch`, so a trailing newline cannot slip past the anchor of `^...$`.
"""

_BEARER_PREFIX: Final = "Bearer "
"""The only authorization scheme the page accepts. It is case-sensitive, as sent by the page."""


def _new_token() -> str:
    """Generates one token or session key: 256 random bits, URL-safe.

    Returns:
        A 43-character string.
    """
    return secrets.token_urlsafe(32)


@dataclass(frozen=True, slots=True, repr=False)
class ClaimGranted:
    """The claim succeeded. It carries the session key, which the page keeps in memory.

    Attributes:
        session_key: The bearer key for the status and session routes.
    """

    session_key: str

    def __repr__(self) -> str:
        """Hides the key, so that no log line or traceback shows it.

        Returns:
            A fixed redacted marker.
        """
        return "ClaimGranted(<redacted>)"


@dataclass(frozen=True, slots=True)
class ClaimRefused:
    """The claim was refused.

    Attributes:
        code: Why the token was refused.
    """

    code: ClaimRefusalCode


ClaimResult = ClaimGranted | ClaimRefused
"""Outcome of one presentation of the token."""


class ClaimGate:
    """Holds the one-time token and the session key, and checks every presentation of them.

    The token is burnt by the first successful claim and by the lock. Comparisons use
    `hmac.compare_digest` on equal-length bytes, so their timing does not reveal a prefix.
    """

    def __init__(
        self,
        *,
        now: Callable[[], float] = time.monotonic,
        token_factory: Callable[[], str] = _new_token,
    ) -> None:
        """Creates the gate with a fresh token.

        Args:
            now: The monotonic clock, in seconds. Injected so that tests control the lifetime.
            token_factory: Generates a token or a key. Injected so that tests know the token.
        """
        self._now = now
        self._token_factory = token_factory
        self._token = ""
        self._issued_at = 0.0
        self._session_key: str | None = None
        self._claimed = False
        self._locked = False
        self._failures = 0
        self._issue()

    @property
    def token(self) -> str:
        """Returns the current token. Only the notice writer reads it, once per announcement.

        Returns:
            The token, or the empty string once it has been burnt.
        """
        return self._token

    @property
    def phase(self) -> ClaimPhase:
        """Returns where the claim stands.

        Returns:
            `LOCKED` after too many wrong tokens, `CLAIMED` after a successful claim, `EXPIRED`
            past the token lifetime, otherwise `OPEN`.
        """
        if self._locked:
            return "LOCKED"
        if self._claimed:
            return "CLAIMED"
        if self._expired():
            return "EXPIRED"
        return "OPEN"

    def claim(self, presented: str) -> ClaimResult:
        """Checks a presented token and, when it is right, grants the session key.

        The checks run in this order: locked, already used, expired, shape, then the comparison.
        A malformed or wrong token counts as a failure; at the limit the claim locks and the token
        is burnt.

        Args:
            presented: The token the page sent.

        Returns:
            The granted session key, or the reason of the refusal.
        """
        if self._locked:
            return ClaimRefused("locked")
        if self._claimed:
            return ClaimRefused("used")
        if self._expired():
            return ClaimRefused("expired")
        if _TOKEN_PATTERN.fullmatch(presented) is None:
            return self._record_failure()
        if not hmac.compare_digest(presented.encode("utf-8"), self._token.encode("utf-8")):
            return self._record_failure()
        self._token = ""
        self._claimed = True
        self._session_key = self._token_factory()
        return ClaimGranted(session_key=self._session_key)

    def authorize(self, authorization_header: str | None) -> bool:
        """Tells whether an `Authorization` header carries the current session key.

        Args:
            authorization_header: The header value, or None when the request has none.

        Returns:
            True only while claimed, and only for `Bearer <session key>` compared in constant time.
        """
        if self._session_key is None or not self._claimed:
            return False
        if authorization_header is None or not authorization_header.startswith(_BEARER_PREFIX):
            return False
        presented = authorization_header[len(_BEARER_PREFIX) :]
        if _TOKEN_PATTERN.fullmatch(presented) is None:
            return False
        return hmac.compare_digest(presented.encode("utf-8"), self._session_key.encode("utf-8"))

    def revoke(self) -> None:
        """Drops the session key, so that no page can read the status or the session any more.

        Unlike `rearm`, it issues no token and keeps the claim's phase: the token stays burnt, so a
        stopped service can never be claimed again through this gate.
        """
        self._session_key = None

    def rearm(self) -> str:
        """Revokes the session key and any lock, and issues a new token.

        Returns:
            The new token, for the notice writer.
        """
        self._session_key = None
        self._claimed = False
        self._locked = False
        self._failures = 0
        self._issue()
        return self._token

    def __repr__(self) -> str:
        """Shows the phase only, never the token or the key.

        Returns:
            The gate and its phase.
        """
        return f"ClaimGate(phase={self.phase})"

    def _issue(self) -> None:
        """Replaces the token and restarts its lifetime."""
        self._token = self._token_factory()
        self._issued_at = self._now()

    def _expired(self) -> bool:
        """Tells whether the token has outlived its lifetime.

        Returns:
            True when more than `CLAIM_TTL_S` seconds have passed since it was issued.
        """
        return self._now() - self._issued_at > CLAIM_TTL_S

    def _record_failure(self) -> ClaimRefused:
        """Counts one wrong token, and locks the claim at the limit.

        Returns:
            A `wrong` refusal.
        """
        self._failures += 1
        if self._failures >= MAX_CLAIM_FAILURES:
            self._locked = True
            self._token = ""
        return ClaimRefused("wrong")
