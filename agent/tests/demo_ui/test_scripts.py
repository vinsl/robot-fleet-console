"""Tests of `scripts/demo.sh`, `scripts/links.sh` and the contract of `scripts/bootstrap-admin.sh`.

The first two run with stub `aws`, `uv` and `make` on the PATH; no stub reaches AWS, and the stubs
record their calls, so each test checks which commands ran. The account script is read as text: its
output and its failure messages are the contract the page parses (see `demo_ui/accounts.py`).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from fleet_agent.demo_ui.accounts import HEADER_TEMPLATE

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
BASH = shutil.which("bash") or "/bin/bash"
MAKE = shutil.which("make") or "/usr/bin/make"
DEMO = REPOSITORY_ROOT / "scripts" / "demo.sh"
LINKS = REPOSITORY_ROOT / "scripts" / "links.sh"
BOOTSTRAP = REPOSITORY_ROOT / "scripts" / "bootstrap-admin.sh"

_HOLDER = (
    "import fcntl,os,sys,time;"
    "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600);"
    "fcntl.flock(fd,fcntl.LOCK_EX);print('ready',flush=True);time.sleep(60)"
)


def _stub(path: Path, body: str) -> None:
    path.write_text("#!/usr/bin/env bash\nset -eu\n" + body, encoding="utf-8")
    path.chmod(0o755)


@pytest.fixture
def stubs(tmp_path: Path) -> dict[str, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls.log"
    calls.touch()
    home = tmp_path / "home"
    home.mkdir()
    state = tmp_path / "state"
    state.mkdir()
    _stub(bin_dir / "aws", f'echo "aws $*" >>"{calls}"\nexit 1\n')
    _stub(bin_dir / "uv", f'echo "uv $*" >>"{calls}"\necho "console:  https://stub.example"\n')
    return {"bin": bin_dir, "calls": calls, "home": home, "state": state}


def _env(stubs: dict[str, Path], **extra: str) -> dict[str, str]:
    env = {
        "PATH": f"{stubs['bin']}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(stubs["home"]),
        "XDG_STATE_HOME": str(stubs["state"]),
        "SIM_N": "9",
    }
    env.update(extra)
    return env


def test_demo_without_an_aws_session_stops_with_the_sso_hint(stubs: dict[str, Path]) -> None:
    result = subprocess.run(  # noqa: S603 - the repository script, with stub tools
        [BASH, str(DEMO)], env=_env(stubs), capture_output=True, text=True, check=False
    )

    assert result.returncode == 1
    assert "aws sso login" in result.stderr
    assert "uv " not in stubs["calls"].read_text(encoding="utf-8")


def test_demo_with_simulators_running_starts_nothing_and_prints_the_links(
    stubs: dict[str, Path],
) -> None:
    # A stand-in for the running simulator holds the lock the way the agent does.
    _stub(
        stubs["bin"] / "aws",
        f'echo "aws $*" >>"{stubs["calls"]}"\n'
        'case "$*" in\n'
        '  "sts get-caller-identity"*) exit 0 ;;\n'
        '  "lambda list-event-source-mappings"*) echo uuid-1 ;;\n'
        '  "lambda get-event-source-mapping"*) echo Enabled ;;\n'
        "  *) exit 1 ;;\n"
        "esac\n",
    )
    lock = stubs["state"] / "fleet" / "sim.lock"
    lock.parent.mkdir(parents=True)
    holder = subprocess.Popen(  # noqa: S603 - fixed arguments, the test's own interpreter
        [sys.executable, "-c", _HOLDER, str(lock)], stdout=subprocess.PIPE, text=True
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "ready"
        result = subprocess.run(  # noqa: S603 - the repository script, with stub tools
            [BASH, str(DEMO)], env=_env(stubs), capture_output=True, text=True, check=False
        )
    finally:
        holder.kill()
        holder.wait()

    assert result.returncode == 0, result.stderr
    assert "already run" in result.stdout
    assert "https://stub.example" in result.stdout
    calls = stubs["calls"].read_text(encoding="utf-8")
    # The consumer is enabled on every run, even when the simulators already run (idempotent).
    assert "lambda list-event-source-mappings" in calls
    assert "lambda update-event-source-mapping" not in calls
    assert "fleet_agent.demo_ui links" in calls


def test_links_without_uv_stops_with_a_hint(stubs: dict[str, Path]) -> None:
    env = _env(stubs)
    env["PATH"] = str(stubs["home"])
    result = subprocess.run(  # noqa: S603 - the repository script
        [BASH, str(LINKS)], env=env, capture_output=True, text=True, check=False
    )

    assert result.returncode == 1
    assert "uv is required" in result.stderr


def test_make_demo_defaults_to_nine_simulators() -> None:
    result = subprocess.run(  # noqa: S603 - make's dry run of a target, no recipe runs
        [MAKE, "-n", "demo"], cwd=REPOSITORY_ROOT, capture_output=True, text=True, check=False
    )

    assert result.returncode == 0, result.stderr
    assert "SIM_N=9 bash scripts/demo.sh" in result.stdout


def test_bootstrap_admin_prints_the_header_the_page_parses() -> None:
    source = BOOTSTRAP.read_text(encoding="utf-8")

    assert 'echo "' + HEADER_TEMPLATE.replace("{role}", "$role") + '"' in source
    assert 'echo "The user signs in' in source


def test_bootstrap_admin_generates_a_policy_compliant_password() -> None:
    source = BOOTSTRAP.read_text(encoding="utf-8")

    assert "openssl rand -base64 18" in source
    assert "'Aa1!'" in source


@pytest.mark.parametrize(
    "fragment",
    [
        "no AWS session",
        "Terraform outputs",
        "was created but its group",
        "sessions could not be signed out",
    ],
)
def test_bootstrap_admin_failure_messages_match_the_page_classifier(fragment: str) -> None:
    source = BOOTSTRAP.read_text(encoding="utf-8")

    assert fragment in source
