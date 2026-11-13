"""Shared helpers of the video tests: a kit, credentials, a static directory, clocks and requests.

No helper touches the network except `raw_exchange`, which talks to a loopback server the test
started itself. Credentials built here are fake values with the protocol's shapes.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Final

import pytest

from fleet_agent.config.kit_file import LoadedKit, load_kit
from fleet_agent.core.snapshot import AgentSnapshot, Banner
from fleet_agent.protocol.primitives import ReportedState
from fleet_agent.protocol.robot_video import VideoCredentials
from fleet_agent.video import app as app_module
from fleet_agent.video.app import VideoApp, VideoIdentity
from fleet_agent.video.assets import StaticAssets
from fleet_agent.video.claim import ClaimGate
from fleet_agent.video.credentials import CredentialsKeeper
from tests.kit_fixtures import ROBOT_ID, write_kit

FAR_FUTURE: Final = "2099-01-01T00:00:00Z"
"""An expiration far enough that no refresh happens during a test."""

PORT: Final = 49152
"""The port the fake application listens on. The Host and Origin checks name it."""

HOST_HEADER: Final = f"127.0.0.1:{PORT}"
ORIGIN: Final = f"http://127.0.0.1:{PORT}"
TOKEN: Final = "T" * 43
"""The one-time token of the fake application's claim gate."""
SESSION_KEY: Final = "S" * 43
"""The session key that the fake claim gate grants."""
BEARER: Final = f"Bearer {SESSION_KEY}"


def make_kit(tmp_path: Path) -> LoadedKit:
    """Writes the fixture robot's kit under the temporary directory and loads it.

    Args:
        tmp_path: The test's temporary directory.

    Returns:
        The loaded kit, with its real TLS material.
    """
    kit_root = tmp_path / "kits"
    write_kit(kit_root)
    return load_kit(kit_root, ROBOT_ID)


def valid_credentials(expiration: str = FAR_FUTURE) -> VideoCredentials:
    """Builds credentials with the protocol's shapes and the given expiration.

    Args:
        expiration: The UTC expiration, in the protocol's form.

    Returns:
        The credentials.
    """
    return VideoCredentials.model_validate(
        {
            "accessKeyId": "ASIA" + "A" * 16,
            "secretAccessKey": "a" * 40,
            "sessionToken": "t" * 16,
            "expiration": expiration,
        }
    )


def write_static(directory: Path, files: dict[str, bytes], *, manifest: bool = True) -> Path:
    """Writes files and a manifest of their SHA-256 digests into a directory.

    Args:
        directory: The static directory, created when missing.
        files: The file contents by relative path.
        manifest: Whether the manifest is written.

    Returns:
        The directory.
    """
    directory.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for relative, body in files.items():
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        lines.append(f"{hashlib.sha256(body).hexdigest()}  {relative}")
    if manifest:
        (directory / "MANIFEST.sha256").write_text(
            "\n".join(sorted(lines)) + "\n", encoding="utf-8"
        )
    return directory


def standard_files() -> dict[str, bytes]:
    """Returns a small valid page: the index, one script and one vendored file.

    Returns:
        The file contents by relative path.
    """
    return {
        "index.html": b"<!doctype html><title>page</title>",
        "assets/app.js": b"console.log(1);",
        "vendor/kvs.min.js": b"/* vendored */",
    }


def snapshot_of(
    *,
    state: ReportedState = "IDLE",
    banner: Banner = "NONE",
    lock_held: bool = False,
    connected: bool = True,
    simulated: bool = False,
) -> AgentSnapshot:
    """Builds a snapshot with the given fields.

    Args:
        state: The reported state.
        banner: The banner.
        lock_held: Whether the lock is held.
        connected: Whether the broker link is up.
        simulated: Whether the robot is simulated.

    Returns:
        The snapshot.
    """
    return AgentSnapshot(
        state=state,
        banner=banner,
        lock_held=lock_held,
        connected=connected,
        simulated=simulated,
        boot_id="0190c0de-0000-7000-8000-000000000001",
        latch_persisted=True,
        mission_id=None,
    )


class FakeClock:
    """A monotonic and wall clock that moves only when a test moves it."""

    def __init__(self, start: datetime | None = None) -> None:
        """Starts the clock.

        Args:
            start: The wall-clock instant. Defaults to a fixed instant in 2026.
        """
        self.wall = start or datetime(2026, 11, 2, 10, 0, 0, tzinfo=UTC)
        self.mono = 1000.0

    def advance(self, seconds: float) -> None:
        """Moves both clocks forward.

        Args:
            seconds: The number of seconds to add.
        """
        self.wall = self.wall + timedelta(seconds=seconds)
        self.mono += seconds

    def wall_now(self) -> datetime:
        """Returns the wall-clock instant.

        Returns:
            The current instant.
        """
        return self.wall

    def mono_now(self) -> float:
        """Returns the monotonic time in seconds.

        Returns:
            The current monotonic time.
        """
        return self.mono


class FakeProvider:
    """A credentials provider that answers from a script of results, one per call."""

    def __init__(self, *results: object) -> None:
        """Creates the provider.

        Args:
            results: For each call, an object with the credential fields, or an exception to raise
                through the future. The last one repeats.
        """
        self._results = list(results)
        self.calls = 0

    def get_credentials(self) -> Future[object]:
        """Answers one call from the script.

        Returns:
            A completed future, or one that never completes when the script says so.
        """
        self.calls += 1
        result = self._results[min(self.calls, len(self._results)) - 1]
        future: Future[object] = Future()
        if result is None:
            return future
        if isinstance(result, BaseException):
            future.set_exception(result)
        else:
            future.set_result(result)
        return future


@dataclass(frozen=True, slots=True)
class FakeAwsCredentials:
    """Credentials shaped like the CRT object, for the provider fake."""

    access_key_id: str | None
    secret_access_key: str | None
    session_token: str | None
    expiration: datetime | None


def aws_credentials(expires_in_s: float = 3600.0, clock: FakeClock | None = None) -> object:
    """Builds CRT-shaped credentials that expire after the given delay.

    Args:
        expires_in_s: The delay from the clock's instant to the expiration.
        clock: The clock to measure from. A fresh one is used when omitted.

    Returns:
        The credentials object.
    """
    now = (clock or FakeClock()).wall_now()
    return FakeAwsCredentials(
        access_key_id="ASIA" + "B" * 16,
        secret_access_key="b" * 40,
        session_token="u" * 32,
        expiration=now + timedelta(seconds=expires_in_s),
    )


class FakeSource:
    """A credentials source that answers from a script: credentials, or an error to raise."""

    def __init__(self, *results: VideoCredentials | BaseException) -> None:
        """Creates the source.

        Args:
            results: One result per call. The last one repeats.
        """
        self._results = list(results)
        self.calls = 0

    async def fetch(self) -> VideoCredentials:
        """Answers one call from the script.

        Returns:
            The credentials of the script.

        Raises:
            BaseException: The scripted error, when the script holds one.
        """
        self.calls += 1
        result = self._results[min(self.calls, len(self._results)) - 1]
        if isinstance(result, BaseException):
            raise result
        return result


def sequence(*values: str) -> Callable[[], str]:
    """Returns a token factory that yields the given values in order, then repeats the last.

    Args:
        values: The values to yield.

    Returns:
        The factory.
    """
    items = list(values)
    state = {"next": 0}

    def factory() -> str:
        """Yields the next value.

        Returns:
            The next value.
        """
        index = min(state["next"], len(items) - 1)
        state["next"] += 1
        return items[index]

    return factory


async def ready_keeper(source: FakeSource) -> CredentialsKeeper:
    """Starts a keeper and waits until it holds credentials.

    Args:
        source: The source the keeper fetches from.

    Returns:
        The running keeper.

    Raises:
        AssertionError: If the keeper holds nothing after many scheduling turns.
    """
    keeper = CredentialsKeeper(source)
    keeper.start()
    for _ in range(200):
        if keeper.current() is not None:
            return keeper
        await asyncio.sleep(0)
    raise AssertionError("keeper never became ready")


def build_app(
    tmp_path: Path,
    *,
    keeper: CredentialsKeeper,
    snapshot: Callable[[], AgentSnapshot | None] | None = None,
    token_factory: Callable[[], str] | None = None,
    clock: FakeClock | None = None,
    events: list[tuple[str, dict[str, object]]] | None = None,
    files: dict[str, bytes] | None = None,
) -> tuple[VideoApp, ClaimGate]:
    """Builds the application with a known token, a static page, and the given keeper.

    Args:
        tmp_path: The test's temporary directory, where the static page is written.
        keeper: The credentials keeper.
        snapshot: Reads the core's state. Defaults to a constant idle snapshot.
        token_factory: The claim gate's token source. Defaults to TOKEN then SESSION_KEY.
        clock: The clock of the claim gate. Defaults to a fresh fake clock.
        events: A list that receives every log event. Ignored when omitted.
        files: The static page. Defaults to `standard_files()`.

    Returns:
        The application and its claim gate.
    """
    static = write_static(tmp_path / "static", files or standard_files())
    assets = StaticAssets.load(static)
    now = clock or FakeClock()
    gate = ClaimGate(
        now=now.mono_now,
        token_factory=token_factory or sequence(TOKEN, SESSION_KEY),
    )
    sink: list[tuple[str, dict[str, object]]] = events if events is not None else []

    def record(event: str, fields: Mapping[str, object]) -> None:
        """Records one event.

        Args:
            event: The event name.
            fields: The fields of the event.
        """
        sink.append((event, dict(fields)))

    app = VideoApp(
        port=PORT,
        region="eu-west-3",
        assets=assets,
        claim=gate,
        keeper=keeper,
        snapshot=snapshot or (lambda: snapshot_of()),
        identity=VideoIdentity(
            robot_id=ROBOT_ID,
            region="eu-west-3",
            channel_name=f"mfc-demo-{ROBOT_ID}",
            channel_arn=(
                "arn:aws:kinesisvideo:eu-west-3:123456789012:"
                f"channel/mfc-demo-{ROBOT_ID}/1700000000000"
            ),
        ),
        on_event=record,
    )
    return app, gate


class _FrozenTime:
    """Stands in for the time module in the application, so that the rate bucket never refills."""

    @staticmethod
    def monotonic() -> float:
        """Returns a constant monotonic time.

        Returns:
            Always the same instant.
        """
        return 1000.0


def freeze_rate_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Freezes the clock of the request-rate bucket for the duration of one test.

    Args:
        monkeypatch: The fixture that restores the module afterwards.
    """
    monkeypatch.setattr(app_module, "time", _FrozenTime)


def claim_body(token: str) -> bytes:
    """Encodes a claim body exactly as the page sends it.

    Args:
        token: The presented token.

    Returns:
        The JSON body.
    """
    return json.dumps({"claim": token}, separators=(",", ":")).encode("ascii")


def api_headers(*, origin: bool = True, content_type: bool = True) -> dict[str, str]:
    """Returns the headers of a well-formed claim request.

    Args:
        origin: Whether to add the page's origin.
        content_type: Whether to add the JSON content type.

    Returns:
        The header fields, by lowercase name.
    """
    headers = {"host": HOST_HEADER}
    if origin:
        headers["origin"] = ORIGIN
    if content_type:
        headers["content-type"] = "application/json"
    return headers


async def raw_exchange(port: int, payload: bytes, timeout_s: float = 5.0) -> bytes:
    """Sends raw bytes to a loopback server and reads until the server closes the connection.

    Args:
        port: The port of the server.
        payload: The bytes to send.
        timeout_s: The longest wait for the answer.

    Returns:
        Everything the server wrote.
    """
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(payload)
    await writer.drain()
    try:
        return await asyncio.wait_for(reader.read(), timeout=timeout_s)
    finally:
        writer.close()


def status_of(raw: bytes) -> int:
    """Reads the status code of a raw answer.

    Args:
        raw: The bytes the server wrote.

    Returns:
        The status code.
    """
    return int(raw.split(b" ", 2)[1])


async def closed_by_peer(reader: asyncio.StreamReader) -> bool:
    """Tells whether the server has closed a connection, by EOF or by a reset.

    A server that closes with unread bytes in its buffer resets the connection, which is also a
    close; the test accepts either.

    Args:
        reader: The client's stream.

    Returns:
        True when the connection is closed, false when more data arrives.
    """
    try:
        data = await asyncio.wait_for(reader.read(), timeout=2.0)
    except ConnectionResetError:
        return True
    return data == b""
