"""The local video service: it runs beside the core and never stops the robot.

The service starts the credentials keeper, the loopback server and the application, prints the
one-time address on the terminal, and re-arms on SIGUSR1. Every failure in `start` degrades to one
`video.disabled` log line: the robot runs without a page, and the page never runs without the
robot. `start` and `stop` never raise.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Final

from fleet_agent.config.kit_file import LoadedKit
from fleet_agent.video.app import SnapshotSource, VideoApp, VideoIdentity
from fleet_agent.video.assets import AssetError, StaticAssets, packaged_static_dir
from fleet_agent.video.claim import ClaimGate
from fleet_agent.video.constants import LOOPBACK_HOST, STOP_BUDGET_S
from fleet_agent.video.credentials import (
    CredentialsKeeper,
    CredentialsSource,
    X509CredentialsSource,
)
from fleet_agent.video.headers import security_headers
from fleet_agent.video.http_server import LoopbackServer, Request, Response, problem_response

NoticeWriter = Callable[[str], None]
"""Writes the address notice for the operator. It is the only place the one-time token leaves."""

_LOG: Final = logging.getLogger(__name__)


def write_stderr(text: str) -> None:
    """Writes the operator notice to standard error. It never goes through the logger or stdout.

    Args:
        text: The notice, which holds the one-time address.
    """
    sys.stderr.write(f"{text}\n")
    sys.stderr.flush()


class _StartError(Exception):
    """A start step failed. Its code names the step, and goes into the `video.disabled` line.

    Attributes:
        code: The failed step.
    """

    def __init__(self, code: str) -> None:
        """Creates the error.

        Args:
            code: The failed step.
        """
        super().__init__(code)
        self.code = code


class LocalVideoService:
    """Serves the local video page beside the core. It implements the runtime's service protocol.

    The application receives the snapshot callable and nothing else from the core, so the page
    has no path to a command.
    """

    def __init__(
        self,
        kit: LoadedKit,
        snapshot: SnapshotSource,
        *,
        notice: NoticeWriter = write_stderr,
        source: CredentialsSource | None = None,
        static_dir: Path | None = None,
    ) -> None:
        """Creates the service, which binds nothing until it is started.

        Args:
            kit: The loaded kit of the robot.
            snapshot: Reads the core's state, read-only.
            notice: Writes the address notice. Injected for tests.
            source: Fetches the credentials. Defaults to the robot's IoT credentials provider.
            static_dir: The directory of the page. Defaults to the one shipped in the package.
        """
        self._kit = kit
        self._snapshot = snapshot
        self._notice = notice
        self._source = source
        self._static_dir = static_dir
        self._started = False
        self._stopped = False
        self._port: int | None = None
        self._keeper: CredentialsKeeper | None = None
        self._server: LoopbackServer | None = None
        self._claim: ClaimGate | None = None
        self._app: VideoApp | None = None
        self._signal_installed = False

    async def start(self) -> None:
        """Brings the page up. It binds the port, starts the keeper, and writes the notice.

        Never raises. A failed step logs `video.disabled` with its code and leaves the service
        inert. The call does no network I/O: the first credentials fetch runs in the keeper's task.
        """
        if self._started or self._stopped:
            return
        self._started = True
        try:
            await self._bring_up()
        except _StartError as err:
            await self._abort_start(err.code)
        except Exception as err:
            # The page is optional: no failure of it may stop the robot (C3).
            await self._abort_start("UNEXPECTED", type(err).__name__)

    async def stop(self) -> None:
        """Stops the page: removes the signal handler, closes the listener, drops the credentials.

        Never raises, is bounded by `STOP_BUDGET_S`, and does nothing when the service was never
        up or was already stopped.
        """
        if self._stopped:
            return
        self._stopped = True
        server = self._server
        if server is None:
            return
        error_name: str | None = None
        keeper = self._keeper
        claim = self._claim
        try:
            self._remove_signal_handler()
            self._app = None
            # Each step has its own `finally`, so a failing step never skips the ones after it.
            try:
                await server.stop(STOP_BUDGET_S)
            finally:
                try:
                    if keeper is not None:
                        await keeper.stop()
                finally:
                    if claim is not None:
                        claim.revoke()
        except Exception as err:
            error_name = type(err).__name__
        self._claim = None
        self._keeper = None
        self._server = None
        fields: dict[str, object] = {}
        if error_name is not None:
            fields["errorName"] = error_name
        _LOG.info("video.stopped", extra=fields)

    async def _bring_up(self) -> None:
        """Runs the start steps in order. Each failure raises a `_StartError` with its code.

        Raises:
            _StartError: With the code of the first step that failed.
        """
        directory = self._static_dir if self._static_dir is not None else packaged_static_dir()
        try:
            assets = StaticAssets.load(directory)
        except AssetError as err:
            raise _StartError(err.code) from None
        try:
            source: CredentialsSource = (
                self._source if self._source is not None else X509CredentialsSource(self._kit)
            )
        except Exception:
            raise _StartError("PROVIDER_BUILD") from None
        keeper = CredentialsKeeper(source)
        self._keeper = keeper
        keeper.start()
        claim = ClaimGate()
        self._claim = claim
        server = LoopbackServer(
            self._route,
            on_refused=self._on_refused,
            base_headers=security_headers(self._kit.config.region),
            on_handler_error=self._on_handler_error,
        )
        try:
            port = await server.start()
        except OSError:
            raise _StartError("BIND_FAILED") from None
        self._server = server
        self._port = port
        config = self._kit.config
        self._app = VideoApp(
            port=port,
            region=config.region,
            assets=assets,
            claim=claim,
            keeper=keeper,
            snapshot=self._snapshot,
            identity=VideoIdentity(
                robot_id=config.robot_id,
                region=config.region,
                channel_name=config.kvs_channel_name,
                channel_arn=config.kvs_channel_arn,
            ),
            on_event=_emit_app_event,
        )
        self._install_signal_handler()
        _LOG.info("video.listening", extra={"port": port})
        self._announce(port, claim.token)

    async def _abort_start(self, code: str, error_name: str | None = None) -> None:
        """Undoes a failed start, and logs why the page is disabled.

        Args:
            code: The failed step.
            error_name: The class name of an unexpected error, when there is one.
        """
        self._remove_signal_handler()
        server, self._server = self._server, None
        if server is not None:
            await server.stop(STOP_BUDGET_S)
        keeper, self._keeper = self._keeper, None
        if keeper is not None:
            await keeper.stop()
        self._claim = None
        self._app = None
        fields: dict[str, object] = {"code": code}
        if error_name is not None:
            fields["errorName"] = error_name
        _LOG.warning("video.disabled", extra=fields)

    async def _route(self, request: Request) -> Response:
        """Hands a request to the application, or answers 503 while the application is not built.

        The server is bound before the application exists, because the application needs the
        bound port. A request in that short window is answered as unavailable.

        Args:
            request: The parsed request.

        Returns:
            The application's response, or the 503 problem.
        """
        app = self._app
        if app is None:
            return problem_response(503, "agent-unavailable", "Agent unavailable")
        return await app.handle(request)

    def _install_signal_handler(self) -> None:
        """Re-arms the page on SIGUSR1. Where the signal cannot be installed, nothing is."""
        with contextlib.suppress(NotImplementedError, RuntimeError):
            asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, self._rearm)
            self._signal_installed = True

    def _remove_signal_handler(self) -> None:
        """Removes the SIGUSR1 handler, if this service installed one."""
        if self._signal_installed:
            with contextlib.suppress(NotImplementedError, RuntimeError, ValueError):
                asyncio.get_running_loop().remove_signal_handler(signal.SIGUSR1)
            self._signal_installed = False

    def _rearm(self) -> None:
        """Issues a new token, revokes the old session key, and prints the new address."""
        claim = self._claim
        port = self._port
        if claim is None or port is None or self._stopped:
            return
        token = claim.rearm()
        _LOG.info("video.rearmed")
        self._announce(port, token)

    def _announce(self, port: int, token: str) -> None:
        """Writes the operator notice with the one-time address and the re-arm instructions.

        Args:
            port: The port the page listens on.
            token: The one-time token of the address.
        """
        self._notice(
            "Local video page. Open this address in the browser on this machine "
            "(valid 15 minutes, single use):\n"
            f"http://{LOOPBACK_HOST}:{port}/#claim={token}\n"
            "Lost the page or reloaded it? Run: kill -USR1 "
            f"{os.getpid()}   (prints a new address and closes the old page)"
        )

    def _on_refused(self, reason: str) -> None:
        """Logs one parser refusal by its reason only.

        Args:
            reason: The refusal reason.
        """
        _LOG.info("video.request_refused", extra={"reason": reason})

    def _on_handler_error(self, error_name: str) -> None:
        """Logs one failure of the application as a refused request, by its class name only.

        Args:
            error_name: The class name of the exception the application raised.
        """
        _LOG.error("video.request_refused", extra={"reason": "HANDLER", "errorName": error_name})


def _emit_app_event(event: str, fields: Mapping[str, object]) -> None:
    """Writes one application event to the log.

    Args:
        event: The event name, one of the closed list.
        fields: The allowlisted fields of the event.
    """
    _LOG.info(event, extra=dict(fields))
