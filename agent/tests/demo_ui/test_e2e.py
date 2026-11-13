"""Offline end-to-end run: real server, controller, runner, spawner and the real `sim-stop.sh`.

Only what would reach AWS or the simulator is replaced: `aws` and `terraform` are stubs on the PATH,
and the consumer script and the simulator are stubs in a fake checkout. The stubs record every call,
and the test checks that no destructive subcommand ran. Nothing touches the network.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import signal
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from fleet_agent.demo_ui.accounts import AccountWriter
from fleet_agent.demo_ui.aws_reads import AwsReader
from fleet_agent.demo_ui.config import load_settings
from fleet_agent.demo_ui.demo import DemoController, SystemClock, sim_lock_held
from fleet_agent.demo_ui.outputs import StackOutputsSource
from fleet_agent.demo_ui.runner import SubprocessRunner, SubprocessSpawner
from fleet_agent.demo_ui.server import make_server
from tests.demo_ui.fakes import TERRAFORM_OUTPUT_JSON

REAL_SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"
TOKEN = "e2e-token-0123456789abcdefghijklmnopqrstuvwxyz"  # noqa: S105 - a fixed test value
SITE = "paris-01"

# The stand-in simulator: takes the lock as the agent does, writes its pid, and waits for SIGTERM.
SIM_CODE = (
    "import fcntl,os,sys,time;"
    "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600);"
    "fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);"
    "os.ftruncate(fd,0);os.write(fd,(str(os.getpid())+chr(10)).encode());"
    "time.sleep(600)"
)

AWS_STUB = """#!/usr/bin/env bash
echo "aws $*" >> "__CALLS__"
case "$*" in
  "sts get-caller-identity"*) echo '{"Account": "000000000000"}' ;;
  *"dynamodb query"*"STATE#"*) echo '{"Items": []}' ;;
  *"dynamodb query"*)
    echo '{"Items": [{"robotId": {"S": "sim-01"}, "name": {"S": "Sim 01"},'
    echo '  "simulated": {"BOOL": true}, "status": {"S": "ACTIVE"}},'
    echo ' {"robotId": {"S": "kali-01"}, "name": {"S": "Kali"},'
    echo '  "simulated": {"BOOL": false}, "status": {"S": "ACTIVE"}}]}'
    ;;
  *) echo "unexpected aws call" >&2; exit 1 ;;
esac
"""

TERRAFORM_STUB = "#!/usr/bin/env bash\necho '__OUTPUT__'\n"


def _write_executable(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)


def _fake_checkout(root: Path, calls: Path) -> None:
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    (root / "infra" / "envs" / "demo").mkdir(parents=True)
    # The real stop script, so the stop path is the one `make demo-stop` uses.
    (scripts / "sim-stop.sh").write_bytes((REAL_SCRIPTS / "sim-stop.sh").read_bytes())
    (scripts / "sim-stop.sh").chmod(0o755)
    _write_executable(
        scripts / "demo-consumer.sh",
        '#!/usr/bin/env bash\necho "consumer $*" >> "__CALLS__"\n'
        'if [ "$1" = status ]; then echo Enabled; else echo "demo-consumer: ok"; fi\n'.replace(
            "__CALLS__", str(calls)
        ),
    )
    _write_executable(
        scripts / "sim-provision.sh",
        '#!/usr/bin/env bash\necho "provision" >> "__CALLS__"\n'.replace("__CALLS__", str(calls)),
    )
    _write_executable(
        scripts / "sim.sh",
        (
            '#!/usr/bin/env bash\nset -euo pipefail\necho "sim" >> "__CALLS__"\n'
            f"exec -a fleet-agent \"{sys.executable}\" -c '{SIM_CODE}'"
            ' "$XDG_STATE_HOME/fleet/sim.lock"\n'
        ).replace("__CALLS__", str(calls)),
    )


def _bin(root: Path, calls: Path) -> Path:
    bin_dir = root / "bin"
    bin_dir.mkdir()
    _write_executable(bin_dir / "aws", AWS_STUB.replace("__CALLS__", str(calls)))
    _write_executable(
        bin_dir / "terraform", TERRAFORM_STUB.replace("__OUTPUT__", TERRAFORM_OUTPUT_JSON)
    )
    return bin_dir


def _call(
    port: int, method: str, path: str, body: dict[str, str] | None = None
) -> dict[str, object]:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers.update({"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}"})
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", method=method, data=data, headers=headers
    )
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - loopback only
        loaded: object = json.loads(response.read())
    assert isinstance(loaded, dict)
    return loaded


def _wait_for_phase(port: int, phase: str, timeout_s: float) -> dict[str, object]:
    deadline = time.monotonic() + timeout_s
    while True:
        status = _call(port, "GET", f"/api/status?site={SITE}")
        if status["phase"] == phase:
            return status
        if time.monotonic() > deadline:
            raise AssertionError(f"the phase stayed {status['phase']!r}; last status {status}")
        time.sleep(0.2)


def test_start_status_links_and_stop_run_end_to_end_without_aws(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    state = tmp_path / "state"
    calls = tmp_path / "calls.log"
    calls.touch()
    checkout = tmp_path / "checkout"
    _fake_checkout(checkout, calls)
    bin_dir = _bin(tmp_path, calls)
    for number in (1, 2):
        kit = home / ".fleet" / "robots" / f"sim-{number:02d}"
        kit.mkdir(parents=True)
        (kit / "register-response.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    settings = dataclasses.replace(
        load_settings({"HOME": str(home), "XDG_STATE_HOME": str(state), "SIM_N": "2"}, []),
        repo_root=checkout,
        port=0,
    )
    runner = SubprocessRunner()
    outputs = StackOutputsSource(runner, settings.stack_dir)
    controller = DemoController(
        runner=runner,
        spawner=SubprocessSpawner(),
        aws=AwsReader(runner, settings, outputs),
        outputs=outputs,
        settings=settings,
        clock=SystemClock(),
    )
    accounts = AccountWriter(
        runner=runner,
        aws=AwsReader(runner, settings, outputs),
        settings=settings,
        clock=SystemClock(),
    )
    server = make_server(settings, controller, TOKEN, accounts=accounts, static_dir=tmp_path)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    port = server.bound_port
    try:
        assert _call(port, "GET", f"/api/status?site={SITE}")["phase"] == "stopped"

        started = _call(port, "POST", "/api/start", {"site": SITE})
        assert started["phase"] in ("starting", "running")
        running = _wait_for_phase(port, "running", timeout_s=30)
        assert running["simulatorsRunning"] is True
        assert running["autoStopAt"] is not None
        assert running["consoleUrl"] == "https://d111aaa.cloudfront.net"
        assert running["realRobots"] == [
            {
                "robotId": "kali-01",
                "name": "Kali",
                "kind": "real",
                "registryStatus": "ACTIVE",
                "connection": "unknown",
                "lastSeen": None,
            }
        ]

        links = _call(port, "GET", "/api/links")
        assert links["console"] == "https://d111aaa.cloudfront.net"

        _call(port, "POST", "/api/stop", {"site": SITE})
        stopped = _wait_for_phase(port, "stopped", timeout_s=30)
        assert stopped["error"] is None
        assert not sim_lock_held(settings.sim_lock_path)
    finally:
        server.shutdown()
        server.server_close()
        if sim_lock_held(settings.sim_lock_path):
            pid = settings.sim_lock_path.read_text(encoding="utf-8").split()[0]
            os.kill(int(pid), signal.SIGTERM)

    lines = calls.read_text(encoding="utf-8").splitlines()
    assert lines.index("consumer enable") < lines.index("sim")
    assert lines.index("consumer disable") > lines.index("sim")
    for line in lines:
        for destructive in (
            "delete",
            "create-user",
            "admin-",
            "apply",
            "destroy",
            "update",
            "set-user",
        ):
            assert destructive not in line, line


PASSWORD = "Zm9vYmFyYmF6cXV4MTIzNDU2Aa1!"  # noqa: S105 - the stub's fixed password
EMAIL = "ada@example.test"
TERRAFORM_STUB_ACCOUNTS = """#!/usr/bin/env bash
case "$*" in
  *"output -json"*) echo '__OUTPUT__' ;;
  *"output -raw user_pool_id"*) echo "eu-west-3_AbC123" ;;
  *"output -raw region"*) echo "eu-west-3" ;;
  *) exit 1 ;;
esac
"""
OPENSSL_STUB = "#!/usr/bin/env bash\necho Zm9vYmFyYmF6cXV4MTIzNDU2\n"
# The stub keeps the account in a state directory: the create makes it exist, so a later reset
# finds it. The JSON document the script sends is copied out, to prove the password reached it.
AWS_ACCOUNTS_STUB = """#!/usr/bin/env bash
echo "aws $*" >> "__CALLS__"
state="__STATE__"
case "$*" in
  "sts get-caller-identity"*) echo '{"Account": "000000000000"}' ;;
  "cognito-idp admin-get-user"*)
    if [ -f "$state/exists" ]; then echo '{"Username": "ada@example.test"}'; exit 0; fi
    echo "An error occurred (UserNotFoundException) when calling the AdminGetUser operation" >&2
    exit 254 ;;
  "cognito-idp admin-create-user"*)
    for arg in "$@"; do case "$arg" in file://*) cp "${arg#file://}" "__SENT__" ;; esac; done
    touch "$state/exists" ;;
  "cognito-idp list-users-in-group"*)
    if [ -f "$state/exists" ] && [[ "$*" == *"--group-name Operator"* ]]; then
      echo '{"Users": [{"Username": "ada@example.test"}]}'
    else
      echo '{"Users": []}'
    fi ;;
  "cognito-idp list-users"*)
    if [ -f "$state/exists" ]; then
      echo '{"Users": [{"Username": "ada@example.test",'
      echo '  "Attributes": [{"Name": "email", "Value": "ada@example.test"}],'
      echo '  "Enabled": true, "UserStatus": "CONFIRMED"}]}'
    else
      echo '{"Users": []}'
    fi ;;
  "cognito-idp admin-add-user-to-group"*|"cognito-idp admin-set-user-password"*) ;;
  "cognito-idp admin-user-global-sign-out"*) ;;
  *) echo "unexpected aws call" >&2; exit 1 ;;
esac
"""


def _account_call(port: int, body: dict[str, object]) -> tuple[int, dict[str, object]]:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/accounts",
        method="POST",
        data=data,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{port}",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 - loopback only
        loaded: object = json.loads(response.read())
    assert isinstance(loaded, dict)
    return response.status, loaded


def test_create_then_reset_run_the_real_script_and_keep_the_password_out_of_logs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The page runs `scripts/bootstrap-admin.sh` against stub AWS tools; no call reaches AWS."""
    state = tmp_path / "pool"
    state.mkdir()
    calls = tmp_path / "calls.log"
    calls.touch()
    sent = tmp_path / "sent.json"
    checkout = tmp_path / "checkout"
    (checkout / "scripts").mkdir(parents=True)
    (checkout / "infra" / "envs" / "demo").mkdir(parents=True)
    script = checkout / "scripts" / "bootstrap-admin.sh"
    script.write_bytes((REAL_SCRIPTS / "bootstrap-admin.sh").read_bytes())
    script.chmod(0o755)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_executable(
        bin_dir / "aws",
        AWS_ACCOUNTS_STUB.replace("__CALLS__", str(calls))
        .replace("__STATE__", str(state))
        .replace("__SENT__", str(sent)),
    )
    _write_executable(
        bin_dir / "terraform",
        TERRAFORM_STUB_ACCOUNTS.replace("__OUTPUT__", TERRAFORM_OUTPUT_JSON),
    )
    _write_executable(bin_dir / "openssl", OPENSSL_STUB)
    home = tmp_path / "home"
    home.mkdir()
    state_home = tmp_path / "state"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_STATE_HOME", str(state_home))
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    settings = dataclasses.replace(
        load_settings({"HOME": str(home), "XDG_STATE_HOME": str(state_home)}, []),
        repo_root=checkout,
        port=0,
    )
    runner = SubprocessRunner()
    outputs = StackOutputsSource(runner, settings.stack_dir)
    aws = AwsReader(runner, settings, outputs)
    controller = DemoController(
        runner=runner,
        spawner=SubprocessSpawner(),
        aws=aws,
        outputs=outputs,
        settings=settings,
        clock=SystemClock(),
    )
    accounts = AccountWriter(runner=runner, aws=aws, settings=settings, clock=SystemClock())
    server = make_server(settings, controller, TOKEN, accounts=accounts, static_dir=tmp_path)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    log = logging.getLogger("fleet_agent.demo_ui")
    page_log = tmp_path / "demo-ui.log"
    handler = logging.FileHandler(page_log, encoding="utf-8")
    previous_level = log.level
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    port = server.bound_port
    try:
        status, created = _account_call(port, {"email": EMAIL, "role": "Operator"})
        assert status == 201
        assert created["temporaryPassword"] == PASSWORD
        assert _call(port, "GET", f"/api/status?site={SITE}")["phase"] == "stopped"

        status, reset = _account_call(port, {"email": EMAIL, "role": "Operator", "reset": True})
        assert status == 200
        assert reset["outcome"] == "reset"
        assert reset["temporaryPassword"] == PASSWORD
    finally:
        log.removeHandler(handler)
        handler.close()
        log.setLevel(previous_level)
        server.shutdown()
        server.server_close()

    # The password reached the Cognito call as a document, never as an argument of any call.
    assert PASSWORD in sent.read_text(encoding="utf-8")
    recorded = calls.read_text(encoding="utf-8")
    assert "cognito-idp admin-set-user-password" in recorded
    assert "cognito-idp admin-user-global-sign-out" in recorded
    assert PASSWORD not in recorded
    # The page's log names the outcome, never the address or the password.
    page_text = page_log.read_text(encoding="utf-8")
    assert "account write mode=create role=Operator outcome=created rc=0" in page_text
    assert "account write mode=reset role=Operator outcome=reset rc=0" in page_text
    assert PASSWORD not in page_text
    assert EMAIL not in page_text
