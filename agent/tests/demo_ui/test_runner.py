"""Tests of the command runner and the spawner; the local interpreter is the only program run."""

from __future__ import annotations

import os
import stat
import sys
import time
from pathlib import Path

import pytest

from fleet_agent.demo_ui.runner import (
    MAX_STDERR_CHARS,
    SubprocessRunner,
    SubprocessSpawner,
    minimal_env,
)


def _python(code: str) -> list[str]:
    return [sys.executable, "-c", code]


def test_runner_returns_stdout_and_the_return_code() -> None:
    result = SubprocessRunner().run(_python("print('ready')"), timeout_s=20)

    assert result.returncode == 0
    assert result.stdout.strip() == "ready"
    assert result.timed_out is False


def test_runner_reports_a_failing_command_without_raising() -> None:
    result = SubprocessRunner().run(
        _python("import sys; sys.stderr.write('boom'); sys.exit(3)"), timeout_s=20
    )

    assert result.returncode == 3
    assert result.stderr == "boom"


def test_runner_truncates_stderr_for_the_caller() -> None:
    code = f"import sys; sys.stderr.write('x' * {MAX_STDERR_CHARS * 3}); sys.exit(1)"

    result = SubprocessRunner().run(_python(code), timeout_s=20)

    assert len(result.stderr) == MAX_STDERR_CHARS


def test_runner_marks_a_timeout() -> None:
    result = SubprocessRunner().run(_python("import time; time.sleep(30)"), timeout_s=0.5)

    assert result.timed_out is True
    assert result.returncode == -1


def test_runner_reports_a_missing_program_as_127() -> None:
    result = SubprocessRunner().run(["fleet-no-such-program-xyz"], timeout_s=5)

    assert result.returncode == 127


@pytest.mark.parametrize("argv", ["python -c 'print(1)'", []])
def test_runner_refuses_a_shell_string_or_an_empty_command(argv: list[str] | str) -> None:
    with pytest.raises(TypeError, match="argv"):
        SubprocessRunner().run(argv, timeout_s=5)


def test_minimal_environment_keeps_only_what_the_commands_need() -> None:
    source = {
        "PATH": "/bin",
        "HOME": "/home/op",
        "AWS_PROFILE": "demo",
        "XDG_STATE_HOME": "/state",
        "SIM_FAULT_RATE": "99",
        "SECRET_TOKEN": "never",
    }

    env = minimal_env(source, extra={"SIM_N": "3"})

    assert env == {
        "PATH": "/bin",
        "HOME": "/home/op",
        "AWS_PROFILE": "demo",
        "XDG_STATE_HOME": "/state",
        "SIM_N": "3",
    }


def test_spawner_appends_output_to_a_private_log(tmp_path: Path) -> None:
    log = tmp_path / "sim.log"
    spawner = SubprocessSpawner()

    pid = spawner.spawn(_python("print('started')"), {"PATH": os.environ["PATH"]}, log)

    assert pid > 0
    for _ in range(100):
        if "started" in log.read_text(encoding="utf-8"):
            break
        time.sleep(0.05)
    assert "started" in log.read_text(encoding="utf-8")
    assert stat.S_IMODE(log.stat().st_mode) == 0o600


def test_spawner_refuses_a_shell_string(tmp_path: Path) -> None:
    with pytest.raises(TypeError, match="argv"):
        SubprocessSpawner().spawn("echo hi", {}, tmp_path / "log")
