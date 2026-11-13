"""Tests of the command line: the start-up message, the loopback-only rule and the links command."""

from __future__ import annotations

import logging
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest

from fleet_agent.demo_ui import __main__ as entry
from fleet_agent.demo_ui.__main__ import LOG_NAME, main
from tests.demo_ui.fakes import TERRAFORM_OUTPUT_JSON


@pytest.fixture
def private_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("XDG_STATE_HOME", raising=False)
    monkeypatch.delenv("SIM_N", raising=False)
    monkeypatch.delenv("SIM_SITE_ID", raising=False)
    yield home
    logger = logging.getLogger("fleet_agent.demo_ui")
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()


def test_non_loopback_host_is_refused_with_status_2(
    private_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["--host", "0.0.0.0"]) == 2  # noqa: S104 - refused, never bound

    captured = capsys.readouterr()
    assert "127.0.0.1" in captured.err
    assert captured.out == ""


class _FakeServer:
    bound_port = 4321

    def serve_forever(self) -> None:
        raise KeyboardInterrupt

    def server_close(self) -> None:
        return None


def test_start_url_with_the_token_goes_to_standard_error_only(
    private_home: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        entry, "make_server", lambda settings, controller, token, **_: _FakeServer()
    )

    assert main(["--port", "0"]) == 0

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.startswith("Demo control page: http://127.0.0.1:4321/#token=")
    token = captured.err.split("#token=", 1)[1].strip()
    log = private_home / ".local/state/fleet/demo-ui" / LOG_NAME
    assert log.exists()
    assert stat.S_IMODE(log.stat().st_mode) == 0o600
    assert token not in log.read_text(encoding="utf-8")


def _write_executable(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)


def test_links_command_prints_the_three_links(
    private_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_executable(bin_dir / "terraform", f"#!/bin/sh\necho '{TERRAFORM_OUTPUT_JSON}'\n")
    monkeypatch.setenv("PATH", str(bin_dir))

    assert main(["links"]) == 0

    lines = capsys.readouterr().out.strip().splitlines()
    assert lines[0] == "console:  https://d111aaa.cloudfront.net"
    assert lines[1].startswith("users:    https://eu-west-3.console.aws.amazon.com/cognito/")
    assert lines[2].endswith("#/thinghub")


def test_links_command_reports_a_missing_stack_with_status_1(
    private_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))

    assert main(["links"]) == 1

    assert "Deploy the stack first" in capsys.readouterr().err


def test_existing_state_directory_and_log_get_private_modes(
    private_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = private_home / ".local/state/fleet/demo-ui"
    state.mkdir(parents=True)
    state.chmod(0o755)
    log = state / LOG_NAME
    log.write_text("", encoding="utf-8")
    log.chmod(0o644)
    monkeypatch.setattr(
        entry, "make_server", lambda settings, controller, token, **_: _FakeServer()
    )

    assert main(["--port", "0"]) == 0

    assert stat.S_IMODE(state.stat().st_mode) == 0o700
    assert stat.S_IMODE(log.stat().st_mode) == 0o600
