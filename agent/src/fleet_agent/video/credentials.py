"""Temporary credentials for the robot's own signalling channel, from the IoT credentials provider.

The robot presents its X.509 identity to the credentials service, which returns short-lived
credentials scoped to the robot's channel by the role alias. The agent holds them in memory only,
refreshes them before they expire, and backs off on failure. Nothing here is ever written to disk
or to a log line, and no error message carries a value.

This module is the only place in the video package that imports the AWS CRT library.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
from datetime import UTC, datetime
from typing import Final, Literal, Protocol

from awscrt.auth import AwsCredentialsProvider
from awscrt.exceptions import AwsCrtError
from awscrt.io import ClientTlsContext, TlsContextOptions
from pydantic import ValidationError

from fleet_agent.config.kit_file import LoadedKit
from fleet_agent.core.backoff import compute_backoff_s
from fleet_agent.protocol.robot_video import VideoCredentials
from fleet_agent.video.constants import (
    CREDENTIALS_BACKOFF_BASE_S,
    CREDENTIALS_BACKOFF_CAP_S,
    CREDENTIALS_CALL_TIMEOUT_S,
    CREDENTIALS_MIN_REMAINING_S,
    CREDENTIALS_REFRESH_BEFORE_EXPIRY_S,
    CREDENTIALS_SLEEP_SLICE_S,
)

_LOG: Final = logging.getLogger(__name__)

_EXPIRATION_FORMAT: Final = "%Y-%m-%dT%H:%M:%SZ"
"""The UTC form of the expiration the protocol carries, with whole seconds."""

_LOGGED_FAILURES_IN_FULL: Final = 3
"""Consecutive failures logged one by one; after this, only every tenth one is logged."""

CredentialsErrorCode = Literal["TIMEOUT", "PROVIDER_FAILED", "INVALID", "EXPIRING", "UNEXPECTED"]
"""Why a credentials fetch failed. The string form is the code alone.

`UNEXPECTED` names a failure of a source that broke its contract by raising something other
than `CredentialsError`; the keeper records it and backs off like any other failure.
"""

CredentialsState = Literal["PENDING", "READY", "FAILING", "EXPIRED"]
"""The keeper's state: no fetch yet, holding valid credentials, last fetch failed, or expired."""


class AwsCredentialsLike(Protocol):
    """The fields of the CRT credentials object that the agent reads."""

    @property
    def access_key_id(self) -> str | None:
        """The access key identifier."""
        ...

    @property
    def secret_access_key(self) -> str | None:
        """The secret access key."""
        ...

    @property
    def session_token(self) -> str | None:
        """The session token."""
        ...

    @property
    def expiration(self) -> datetime | None:
        """When the credentials expire."""
        ...


class AwsCredentialsProviderLike(Protocol):
    """The part of the CRT credentials provider that the agent calls."""

    def get_credentials(self) -> Future[AwsCredentialsLike]:
        """Starts one request for credentials.

        Returns:
            A future that resolves to the credentials.
        """
        ...


ProviderFactory = Callable[[LoadedKit], AwsCredentialsProviderLike]
"""Builds the provider of one kit. Injected so that tests need no network and no TLS material."""


class CredentialsError(Exception):
    """A credentials fetch failed. Its string form is the code alone.

    Attributes:
        code: The failed check.
        error_name: The name of the library error, when the provider raised one. Never a message.
    """

    def __init__(self, code: CredentialsErrorCode, error_name: str | None = None) -> None:
        """Creates the error.

        Args:
            code: The failed check.
            error_name: The library error name, when there is one.
        """
        super().__init__(code)
        self.code = code
        self.error_name = error_name


class CredentialsSource(Protocol):
    """Anything that fetches the credentials of the robot's channel."""

    async def fetch(self) -> VideoCredentials:
        """Fetches one set of credentials.

        Returns:
            Validated credentials, with at least `CREDENTIALS_MIN_REMAINING_S` of validity.

        Raises:
            CredentialsError: When the fetch fails for any reason.
        """
        ...


def utc_now() -> datetime:
    """Returns the current time, timezone-aware in UTC.

    Returns:
        The current instant.
    """
    return datetime.now(UTC)


def build_x509_provider(kit: LoadedKit) -> AwsCredentialsProviderLike:
    """Builds the credentials provider of a kit, which signs its requests with the robot's X.509.

    The client sends the thing name itself (`x-amzn-iot-thingname`), so the policy can scope the
    channel by the thing name. The TLS context is built from the same PEM bytes as the broker's,
    so no key is written to a file.

    Args:
        kit: The loaded kit of the robot.

    Returns:
        The provider. It performs no request until asked for credentials.

    Raises:
        awscrt errors, RuntimeError, TypeError or ValueError: If the TLS context refuses the
            material. The caller treats every one of them as a provider build failure.
    """
    tls_ctx: ClientTlsContext = _client_tls_context(kit)
    provider: AwsCredentialsProviderLike = AwsCredentialsProvider.new_x509(
        endpoint=kit.config.credentials_endpoint,
        thing_name=kit.config.thing_name,
        role_alias=kit.config.role_alias,
        tls_ctx=tls_ctx,
    )
    return provider


def _client_tls_context(kit: LoadedKit) -> ClientTlsContext:
    """Builds the client TLS context from the kit's PEM bytes, with the broker's root of trust.

    Args:
        kit: The loaded kit of the robot.

    Returns:
        The TLS context.
    """
    options = TlsContextOptions.create_client_with_mtls(
        kit.tls.certificate_pem, kit.tls.private_key_pem
    )
    options.override_default_trust_store(kit.tls.root_ca_pem)
    context: ClientTlsContext = ClientTlsContext(options)
    return context


def _error_name(err: BaseException) -> str:
    """Names a provider error without its message, which can quote a value.

    Args:
        err: The error the provider raised.

    Returns:
        The library's error name for an `AwsCrtError`, otherwise the class name.
    """
    if isinstance(err, AwsCrtError):
        return str(err.name)
    return type(err).__name__


def _as_credentials_error(err: Exception) -> CredentialsError:
    """Maps any failure of a fetch to the keeper's error, naming it without its message.

    Args:
        err: The exception the fetch raised.

    Returns:
        The error itself when it is one, otherwise an `UNEXPECTED` error named by its class.
    """
    if isinstance(err, CredentialsError):
        return err
    return CredentialsError("UNEXPECTED", type(err).__name__)


def _expires_at(credentials: VideoCredentials) -> datetime:
    """Parses the expiration of validated credentials.

    Args:
        credentials: Credentials whose expiration matched the protocol pattern.

    Returns:
        The expiration as a timezone-aware instant.
    """
    return datetime.fromisoformat(credentials.expiration.replace("Z", "+00:00"))


class X509CredentialsSource:
    """Fetches the robot's credentials from the IoT credentials provider, with a deadline.

    The provider is built once. Each fetch waits at most `timeout_s`, and a fetch that times out
    cancels its request, so a hanging call never piles up behind the next one.
    """

    def __init__(
        self,
        kit: LoadedKit,
        *,
        provider_factory: ProviderFactory = build_x509_provider,
        now: Callable[[], datetime] = utc_now,
        timeout_s: float = CREDENTIALS_CALL_TIMEOUT_S,
    ) -> None:
        """Builds the provider of the kit.

        Args:
            kit: The loaded kit of the robot.
            provider_factory: Builds the provider. Injected for tests.
            now: The wall clock, used for the validity check. Injected for tests.
            timeout_s: The deadline of one call, in seconds.

        Raises:
            Exception: Whatever the provider factory raises, when the TLS context is refused.
        """
        self._provider = provider_factory(kit)
        self._now = now
        self._timeout_s = timeout_s

    async def fetch(self) -> VideoCredentials:
        """Fetches one set of credentials and checks it.

        Returns:
            The validated credentials.

        Raises:
            CredentialsError: With `TIMEOUT`, `PROVIDER_FAILED`, `INVALID` (a value outside the
                protocol pattern, or no expiration) or `EXPIRING` (less than the minimum validity).
        """
        try:
            request = self._provider.get_credentials()
        except Exception as err:
            raise CredentialsError("PROVIDER_FAILED", _error_name(err)) from None
        try:
            fetched = await asyncio.wait_for(asyncio.wrap_future(request), timeout=self._timeout_s)
        except TimeoutError:
            request.cancel()
            raise CredentialsError("TIMEOUT") from None
        except Exception as err:
            raise CredentialsError("PROVIDER_FAILED", _error_name(err)) from None
        return self._validated(fetched)

    def _validated(self, fetched: AwsCredentialsLike) -> VideoCredentials:
        """Maps the provider's credentials to the protocol model and checks their validity.

        Args:
            fetched: The credentials the provider returned.

        Returns:
            The validated credentials.

        Raises:
            CredentialsError: With `INVALID` or `EXPIRING`.
        """
        if fetched.expiration is None:
            raise CredentialsError("INVALID")
        expires_at = fetched.expiration.astimezone(UTC)
        payload: dict[str, object] = {
            "accessKeyId": fetched.access_key_id,
            "secretAccessKey": fetched.secret_access_key,
            "sessionToken": fetched.session_token,
            "expiration": expires_at.strftime(_EXPIRATION_FORMAT),
        }
        try:
            credentials = VideoCredentials.model_validate(payload)
        except ValidationError:
            raise CredentialsError("INVALID") from None
        remaining_s = (expires_at - self._now()).total_seconds()
        if remaining_s < CREDENTIALS_MIN_REMAINING_S:
            raise CredentialsError("EXPIRING")
        return credentials


class CredentialsKeeper:
    """Keeps one set of credentials fresh in memory, and reports whether it is usable.

    One task fetches the credentials, then sleeps until 20 minutes before they expire, then
    fetches again. A failure backs off with full jitter and the cap, and is logged at a bounded
    rate. The held value is returned only while it has validity left.
    """

    def __init__(
        self,
        source: CredentialsSource,
        *,
        now: Callable[[], datetime] = utc_now,
        rand: Callable[[], float] = random.random,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        """Creates the keeper, which fetches nothing until it is started.

        Args:
            source: Fetches the credentials.
            now: The wall clock, used for expiry only. Injected for tests.
            rand: The source of the jitter draws. Injected for tests.
            sleep: Suspends the refresh loop. Injected for tests.
            monotonic: The clock that measures the waits. Injected for tests.
        """
        self._source = source
        self._now = now
        self._rand = rand
        self._sleep = sleep
        self._monotonic = monotonic
        self._held: tuple[VideoCredentials, datetime] | None = None
        self._failing = False
        self._refreshes = 0
        self._failures = 0
        self._last_logged_failure = 0
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Starts the refresh task. Calling it again while the task runs does nothing."""
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(
                self._run(), name="video-credentials"
            )

    async def stop(self) -> None:
        """Cancels the refresh task and drops the held credentials. A second call does nothing."""
        task, self._task = self._task, None
        self._held = None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    def current(self) -> VideoCredentials | None:
        """Returns the held credentials while they have validity left.

        Returns:
            The credentials, or None while none is held, or once the held ones have expired.
        """
        if self._held is None:
            return None
        credentials, expires_at = self._held
        if expires_at <= self._now():
            return None
        return credentials

    @property
    def state(self) -> CredentialsState:
        """Returns the keeper's state.

        Returns:
            `EXPIRED` once the held credentials have expired, `FAILING` while the last fetch
            failed, `READY` while holding valid credentials, otherwise `PENDING`.
        """
        if self._held is None:
            return "FAILING" if self._failing else "PENDING"
        if self._held[1] <= self._now():
            return "EXPIRED"
        return "FAILING" if self._failing else "READY"

    async def _run(self) -> None:
        """Fetches, waits, and fetches again, forever, until the task is cancelled."""
        failures = 0
        while True:
            try:
                credentials = await self._source.fetch()
                expires_at = _expires_at(credentials)
            except Exception as err:
                # Any failure, including one the source should have wrapped, must not end the
                # refresh task: the keeper backs off like a normal failure and records the class
                # name only.
                failure = _as_credentials_error(err)
                delay_s = compute_backoff_s(
                    failures,
                    base_s=CREDENTIALS_BACKOFF_BASE_S,
                    cap_s=CREDENTIALS_BACKOFF_CAP_S,
                    rand=self._rand,
                )
                failures += 1
                self._failing = True
                self._log_failure(failure, failures, delay_s)
                await self._wait(delay_s)
                continue
            failures = 0
            self._failing = False
            self._last_logged_failure = 0
            self._held = (credentials, expires_at)
            self._refreshes += 1
            _LOG.info("video.credentials_ok", extra={"count": self._refreshes})
            refresh_in_s = (
                expires_at - self._now()
            ).total_seconds() - CREDENTIALS_REFRESH_BEFORE_EXPIRY_S
            # A fetch that returns less than the refresh margin would otherwise refetch at once;
            # the backoff base is the floor between two successful fetches.
            await self._wait(max(refresh_in_s, CREDENTIALS_BACKOFF_BASE_S))

    def _log_failure(self, err: CredentialsError, failures: int, delay_s: float) -> None:
        """Logs one failed fetch. After three in a row, only every tenth one is written.

        Args:
            err: The failure.
            failures: The number of consecutive failures, including this one.
            delay_s: The delay before the next fetch, in seconds.
        """
        if failures > _LOGGED_FAILURES_IN_FULL and failures % 10 != 0:
            return
        fields: dict[str, object] = {
            "code": err.code,
            "attempt": failures,
            "delayMs": int(delay_s * 1000),
        }
        if err.error_name is not None:
            fields["errorName"] = err.error_name
        suppressed = failures - self._last_logged_failure - 1
        if suppressed > 0:
            fields["suppressed"] = suppressed
        self._last_logged_failure = failures
        _LOG.warning("video.credentials_failed", extra=fields)

    async def _wait(self, seconds: float) -> None:
        """Sleeps for a duration, in slices, so that a cancellation is seen promptly.

        The deadline is measured on the monotonic clock: a wall-clock step (NTP, a manual change)
        must neither shorten a backoff nor stretch it into a long hang.

        Args:
            seconds: The duration to wait, in seconds.
        """
        deadline = self._monotonic() + seconds
        remaining_s = deadline - self._monotonic()
        while remaining_s > 0:
            await self._sleep(min(remaining_s, CREDENTIALS_SLEEP_SLICE_S))
            remaining_s = deadline - self._monotonic()
