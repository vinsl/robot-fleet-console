"""Tests of the credentials: provider mapping, validity checks, refresh loop and backoff."""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import shutil
import subprocess
from collections.abc import Callable
from concurrent.futures import Future
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from awscrt.exceptions import AwsCrtError

from fleet_agent.config.kit_file import TlsMaterial
from fleet_agent.core.backoff import compute_backoff_s
from fleet_agent.protocol.robot_video import VideoCredentials
from fleet_agent.video import credentials as credentials_module
from fleet_agent.video.constants import (
    CREDENTIALS_BACKOFF_BASE_S,
    CREDENTIALS_BACKOFF_CAP_S,
    CREDENTIALS_REFRESH_BEFORE_EXPIRY_S,
)
from fleet_agent.video.credentials import (
    CredentialsError,
    CredentialsKeeper,
    X509CredentialsSource,
    build_x509_provider,
)
from tests.kit_fixtures import ROBOT_ID
from tests.video.support import (
    FakeAwsCredentials,
    FakeClock,
    FakeProvider,
    FakeSource,
    aws_credentials,
    make_kit,
    valid_credentials,
)

_HALF = 0.5
"""A fixed jitter draw, so that every backoff delay is positive and the loop yields."""


def _source(
    provider: FakeProvider, clock: FakeClock, timeout_s: float = 5.0
) -> X509CredentialsSource:
    """Builds a source over a scripted provider and the fake clock.

    Args:
        provider: The scripted provider.
        clock: The wall clock.
        timeout_s: The deadline of one call.

    Returns:
        The source.
    """
    return X509CredentialsSource(
        object(),  # type: ignore[arg-type]
        provider_factory=lambda _kit: provider,
        now=clock.wall_now,
        timeout_s=timeout_s,
    )


async def _until(predicate: Callable[[], bool], attempts: int = 500) -> None:
    """Yields to the loop until the predicate holds.

    Args:
        predicate: The condition to wait for.
        attempts: The number of scheduling turns to try.

    Raises:
        AssertionError: When the condition never holds.
    """
    for _ in range(attempts):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition never held")


async def _yield_turns(turns: int) -> None:
    """Gives the loop a number of scheduling turns, without any real delay.

    Args:
        turns: The number of turns to give.
    """
    for _ in range(turns):
        await asyncio.sleep(0)


async def test_valid_credentials_map_to_the_protocol_with_a_z_expiration() -> None:
    clock = FakeClock()
    provider = FakeProvider(aws_credentials(3600, clock))
    source = _source(provider, clock)

    result = await source.fetch()

    assert result.access_key_id.startswith("ASIA")
    assert result.expiration == "2026-11-02T11:00:00Z"


@pytest.mark.parametrize(
    "overrides",
    [
        {"expiration": None},
        {"secret_access_key": "b" * 39},
        {"access_key_id": "AKIA" + "B" * 16},
    ],
)
async def test_values_outside_the_protocol_are_invalid_and_never_named(
    overrides: dict[str, object],
) -> None:
    clock = FakeClock()
    fields: dict[str, object] = {
        "access_key_id": "ASIA" + "B" * 16,
        "secret_access_key": "b" * 40,
        "session_token": "u" * 32,
        "expiration": clock.wall_now() + timedelta(hours=1),
    }
    fields.update(overrides)
    provider = FakeProvider(FakeAwsCredentials(**fields))  # type: ignore[arg-type]
    source = _source(provider, clock)

    with pytest.raises(CredentialsError) as caught:
        await source.fetch()

    assert caught.value.code == "INVALID"
    assert str(caught.value) == "INVALID"


async def test_less_than_five_minutes_of_validity_is_expiring() -> None:
    clock = FakeClock()
    provider = FakeProvider(aws_credentials(100, clock))
    source = _source(provider, clock)

    with pytest.raises(CredentialsError) as caught:
        await source.fetch()

    assert caught.value.code == "EXPIRING"


async def test_a_provider_that_never_answers_times_out() -> None:
    clock = FakeClock()
    provider = FakeProvider(None)
    source = _source(provider, clock, timeout_s=0.01)

    with pytest.raises(CredentialsError) as caught:
        await source.fetch()

    assert caught.value.code == "TIMEOUT"


async def test_a_crt_error_is_provider_failed_with_its_name_only() -> None:
    clock = FakeClock()
    error = AwsCrtError(code=1, name="AWS_IO_SOCKET_TIMEOUT", message="secret detail")
    source = _source(FakeProvider(error), clock)

    with pytest.raises(CredentialsError) as caught:
        await source.fetch()

    assert caught.value.code == "PROVIDER_FAILED"
    assert caught.value.error_name == "AWS_IO_SOCKET_TIMEOUT"
    assert "secret detail" not in str(caught.value)


async def test_another_error_is_provider_failed_with_its_class_name() -> None:
    clock = FakeClock()
    source = _source(FakeProvider(ValueError("value in message")), clock)

    with pytest.raises(CredentialsError) as caught:
        await source.fetch()

    assert caught.value.error_name == "ValueError"
    assert "value in message" not in str(caught.value)


async def test_a_provider_that_raises_when_called_is_provider_failed() -> None:
    clock = FakeClock()

    class Broken:
        """A provider whose call itself raises."""

        def get_credentials(self) -> Future[object]:
            """Raises at once.

            Returns:
                Never returns.

            Raises:
                RuntimeError: Always.
            """
            raise RuntimeError("boom")

    source = X509CredentialsSource(
        object(),  # type: ignore[arg-type]
        provider_factory=lambda _kit: Broken(),  # type: ignore[arg-type,return-value]
        now=clock.wall_now,
    )

    with pytest.raises(CredentialsError) as caught:
        await source.fetch()

    assert caught.value.code == "PROVIDER_FAILED"


async def test_keeper_backs_off_with_the_backoff_rule_then_holds_the_success() -> None:
    clock = FakeClock()
    sleeps: list[tuple[float, str]] = []
    keeper_holder: list[CredentialsKeeper] = []

    async def fake_sleep(seconds: float) -> None:
        """Records the delay and the state seen during it, and moves the clock.

        Args:
            seconds: The delay.
        """
        sleeps.append((seconds, keeper_holder[0].state))
        clock.advance(seconds)
        await asyncio.sleep(0)

    failure = CredentialsError("TIMEOUT")
    source = FakeSource(failure, failure, valid_credentials())
    keeper = CredentialsKeeper(
        source,
        now=clock.wall_now,
        rand=lambda: _HALF,
        sleep=fake_sleep,
        monotonic=clock.mono_now,
    )
    keeper_holder.append(keeper)
    keeper.start()
    await _until(lambda: keeper.state == "READY")
    await keeper.stop()

    first = compute_backoff_s(
        0, base_s=CREDENTIALS_BACKOFF_BASE_S, cap_s=CREDENTIALS_BACKOFF_CAP_S, rand=lambda: _HALF
    )
    second = compute_backoff_s(
        1, base_s=CREDENTIALS_BACKOFF_BASE_S, cap_s=CREDENTIALS_BACKOFF_CAP_S, rand=lambda: _HALF
    )
    assert sleeps[0] == (first, "FAILING")
    assert sleeps[1] == (second, "FAILING")
    assert keeper.current() is None


async def test_a_source_that_raises_a_non_credentials_error_backs_off_and_recovers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    clock = FakeClock()
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        """Records the delay and moves both clocks.

        Args:
            seconds: The delay.
        """
        sleeps.append(seconds)
        clock.advance(seconds)
        await asyncio.sleep(0)

    source = FakeSource(RuntimeError("value that must not be logged"), valid_credentials())
    keeper = CredentialsKeeper(
        source,
        now=clock.wall_now,
        rand=lambda: _HALF,
        sleep=fake_sleep,
        monotonic=clock.mono_now,
    )
    keeper.start()
    await _until(lambda: keeper.state == "READY")
    await keeper.stop()

    expected = compute_backoff_s(
        0, base_s=CREDENTIALS_BACKOFF_BASE_S, cap_s=CREDENTIALS_BACKOFF_CAP_S, rand=lambda: _HALF
    )
    failed = [r for r in caplog.records if r.getMessage() == "video.credentials_failed"]
    assert sleeps[0] == expected
    assert [r.__dict__["code"] for r in failed] == ["UNEXPECTED"]
    assert failed[0].__dict__["errorName"] == "RuntimeError"
    assert all("value that must not be logged" not in repr(r.__dict__) for r in caplog.records)
    assert "value that must not be logged" not in caplog.text


async def test_a_wall_clock_that_does_not_move_still_ends_a_backoff_wait() -> None:
    """The backoff is measured on the monotonic clock: a frozen wall clock cannot hang it."""
    clock = FakeClock()
    frozen = clock.wall_now()
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        """Advances only the monotonic clock, as a real sleep would, and records the delay.

        Args:
            seconds: The delay.
        """
        sleeps.append(seconds)
        clock.mono += seconds
        await asyncio.sleep(0)

    source = FakeSource(CredentialsError("TIMEOUT"), valid_credentials())
    keeper = CredentialsKeeper(
        source,
        now=lambda: frozen,
        rand=lambda: _HALF,
        sleep=fake_sleep,
        monotonic=clock.mono_now,
    )
    keeper.start()
    await _until(lambda: keeper.state == "READY")
    await keeper.stop()

    expected = compute_backoff_s(
        0, base_s=CREDENTIALS_BACKOFF_BASE_S, cap_s=CREDENTIALS_BACKOFF_CAP_S, rand=lambda: _HALF
    )
    assert sleeps[0] == expected


async def test_keeper_fetches_again_twenty_minutes_before_a_one_hour_expiry() -> None:
    clock = FakeClock()
    fetch_times: list[datetime] = []
    waiting = asyncio.Event()

    class Recording:
        """A source that records each call, and waits forever after the second one."""

        async def fetch(self) -> VideoCredentials:
            """Records the call time and returns credentials expiring in an hour.

            Returns:
                The credentials.
            """
            fetch_times.append(clock.wall_now())
            if len(fetch_times) >= 2:
                await waiting.wait()
            expires = clock.wall_now() + timedelta(hours=1)
            return valid_credentials(expires.strftime("%Y-%m-%dT%H:%M:%SZ"))

    async def fake_sleep(seconds: float) -> None:
        """Moves the clock, and checks that no single sleep is longer than the slice.

        Args:
            seconds: The delay.

        Raises:
            AssertionError: When a sleep is longer than 30 seconds.
        """
        if seconds > 30.0:
            raise AssertionError("sleep slice too long")
        clock.advance(seconds)
        await asyncio.sleep(0)

    keeper = CredentialsKeeper(
        Recording(),  # type: ignore[arg-type]
        now=clock.wall_now,
        sleep=fake_sleep,
        monotonic=clock.mono_now,
    )
    keeper.start()
    await _until(lambda: len(fetch_times) >= 2)
    await keeper.stop()

    gap = fetch_times[1] - fetch_times[0]
    assert gap == timedelta(seconds=3600 - CREDENTIALS_REFRESH_BEFORE_EXPIRY_S)


async def test_held_credentials_that_expire_while_fetches_fail_are_withdrawn() -> None:
    clock = FakeClock()
    expiry_at = clock.wall_now() + timedelta(seconds=400)
    expiry = expiry_at.strftime("%Y-%m-%dT%H:%M:%SZ")

    async def fake_sleep(seconds: float) -> None:
        """Moves the clock.

        Args:
            seconds: The delay.
        """
        clock.advance(seconds)
        await asyncio.sleep(0)

    source = FakeSource(valid_credentials(expiry), CredentialsError("PROVIDER_FAILED"))
    keeper = CredentialsKeeper(
        source,
        now=clock.wall_now,
        rand=lambda: _HALF,
        sleep=fake_sleep,
        monotonic=clock.mono_now,
    )
    keeper.start()
    await _until(lambda: keeper.current() is not None)
    assert keeper.state == "READY"

    await _until(lambda: keeper.state == "EXPIRED")
    await keeper.stop()

    assert clock.wall_now() >= expiry_at
    assert keeper.current() is None


async def test_stop_cancels_the_task_drops_the_credentials_and_is_idempotent() -> None:
    clock = FakeClock()
    source = FakeSource(valid_credentials())
    keeper = CredentialsKeeper(source, now=clock.wall_now)
    keeper.start()
    await _until(lambda: keeper.current() is not None)

    await keeper.stop()
    calls_at_stop = source.calls
    await _yield_turns(10)
    await keeper.stop()

    assert keeper.current() is None
    assert source.calls == calls_at_stop


def test_build_x509_provider_passes_the_robot_identity_and_the_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kit = dataclasses.replace(make_kit(tmp_path), tls=_throwaway_tls(tmp_path))
    recorded: dict[str, object] = {}

    class FakeAwsProvider:
        """Records the arguments of the x509 constructor."""

        @staticmethod
        def new_x509(**kwargs: object) -> object:
            """Records the keyword arguments.

            Args:
                **kwargs: The constructor arguments.

            Returns:
                A marker object.
            """
            recorded.update(kwargs)
            return object()

    monkeypatch.setattr(credentials_module, "AwsCredentialsProvider", FakeAwsProvider)

    build_x509_provider(kit)

    assert recorded["endpoint"] == kit.config.credentials_endpoint
    assert recorded["thing_name"] == kit.config.thing_name == f"mfc-demo-{ROBOT_ID}"
    assert recorded["role_alias"] == kit.config.role_alias


def test_the_real_tls_context_and_provider_build_with_a_real_key_pair(tmp_path: Path) -> None:
    kit = dataclasses.replace(make_kit(tmp_path), tls=_throwaway_tls(tmp_path))

    provider = build_x509_provider(kit)

    assert callable(provider.get_credentials)


def _throwaway_tls(tmp_path: Path) -> TlsMaterial:
    """Generates a self-signed EC certificate and key for one test, in the temporary directory.

    The pair is generated per run and never stored in the repository. It exists only so that the
    real TLS context of the SDK, which parses real PEM, can be built in a test.

    Args:
        tmp_path: The test's temporary directory.

    Returns:
        The TLS material, with the certificate as its root of trust.

    Raises:
        AssertionError: When openssl is not installed.
    """
    openssl = shutil.which("openssl")
    if openssl is None:
        raise AssertionError("openssl is required to build a real TLS context in tests")
    key = tmp_path / "throwaway-key.pem"
    cert = tmp_path / "throwaway-cert.pem"
    subprocess.run(  # noqa: S603 - fixed argument list, no shell, the binary resolved above
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "1",
            "-subj",
            "/CN=throwaway-test",
        ],
        check=True,
        capture_output=True,
    )
    certificate_pem = cert.read_bytes()
    return TlsMaterial(
        certificate_pem=certificate_pem,
        private_key_pem=key.read_bytes(),
        root_ca_pem=certificate_pem,
    )
