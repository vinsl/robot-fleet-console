"""Tests of the simulator's shell scripts, with stub `aws`, `uv` and `robots-admin` executables.

No test reaches AWS: every AWS call goes to a stub on the PATH, which records the calls and answers
from a state file. The scripts run for real, with a private HOME and state directory.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import signal
import stat
import subprocess
from pathlib import Path

import pytest

from tests.sim.support import REPOSITORY_ROOT

SCRIPTS = REPOSITORY_ROOT / "scripts"
SAMPLE_MAP = REPOSITORY_ROOT / "packages/protocol/test/fixtures/site-map/sample-warehouse.geojson"

_AWS_STUB = r"""#!/usr/bin/env bash
set -eu
echo "$*" >>"$AWS_STUB_LOG"
case "$1 $2" in
  "sts get-caller-identity")
    if [ "${AWS_STUB_NO_CREDS:-0}" = 1 ]; then exit 255; fi
    echo '{"Account":"000000000000"}'
    ;;
  "lambda list-event-source-mappings")
    if [ "${AWS_STUB_NO_MAPPING:-0}" = 1 ]; then echo None; else echo uuid-test; fi
    ;;
  "lambda get-event-source-mapping")
    cat "$AWS_STUB_STATE"
    ;;
  "lambda update-event-source-mapping")
    case " $* " in
      *" --no-enabled "*) target=Disabled ;;
      *) target=Enabled ;;
    esac
    if [ "${AWS_STUB_STUCK:-0}" = 1 ]; then
      echo "Disabling" >"$AWS_STUB_STATE"
    else
      echo "$target" >"$AWS_STUB_STATE"
    fi
    echo '{}'
    ;;
  "dynamodb get-item")
    case "$*" in
      *'"META"'*) cat "$AWS_STUB_SITE_ITEM" ;;
      *) cat "$AWS_STUB_MAP_ITEM" ;;
    esac
    ;;
  "s3api get-object")
    for last; do :; done
    cp "$AWS_STUB_OBJECT" "$last"
    echo '{}'
    ;;
  *)
    echo "unexpected aws call: $*" >&2
    exit 99
    ;;
esac
"""

_TERRAFORM_STUB = r"""#!/usr/bin/env bash
# Prints the stack outputs the test names, or fails the way a stack that is not deployed does.
if [ -z "${TF_STUB_OUTPUTS:-}" ]; then exit 1; fi
cat "$TF_STUB_OUTPUTS"
"""

_UV_STUB = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >"$UV_STUB_LOG"
"""

_ROBOTS_ADMIN_STUB = r"""#!/usr/bin/env bash
set -eu
echo "$*" >>"$ROBOTS_ADMIN_LOG"
robot=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--robot-id" ]; then robot="$2"; fi
  shift
done
if [ "$robot" = "${STUB_FAIL_ID:-}" ]; then exit 1; fi
dir="$HOME/.fleet/robots/$robot"
mkdir -p "$dir"
echo "{}" >"$dir/register-response.json"
"""

_FAILING_AWS = "#!/usr/bin/env bash\nexit 255\n"


def _executable(path: Path, text: str) -> Path:
    """Writes a script and makes it executable.

    Args:
        path: Where to write it.
        text: The script's text.

    Returns:
        The path.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)
    return path


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """Gives the scripts a private home directory, with owner-only permissions.

    Args:
        tmp_path: The test's private directory.

    Returns:
        The home directory.
    """
    directory = tmp_path / "home"
    directory.mkdir(mode=0o700)
    return directory


@pytest.fixture
def stubs(tmp_path: Path) -> Path:
    """Puts stub `aws`, `uv`, `terraform` and `robots-admin` executables in a bin directory.

    Args:
        tmp_path: The test's private directory.

    Returns:
        The stub bin directory.
    """
    bin_dir = tmp_path / "bin"
    _executable(bin_dir / "aws", _AWS_STUB)
    _executable(bin_dir / "uv", _UV_STUB)
    _executable(bin_dir / "terraform", _TERRAFORM_STUB)
    return bin_dir


@pytest.fixture
def environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, home: Path, stubs: Path
) -> dict[str, str]:
    """Builds the environment of a script run: the stubs first on the PATH, private home and state.

    Args:
        monkeypatch: The fixture that restores the process environment.
        tmp_path: The test's private directory.
        home: The private home directory.
        stubs: The stub bin directory.

    Yields:
        The environment of the run.
    """
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    values = {
        "PATH": f"{stubs}:{os.environ['PATH']}",
        "HOME": str(home),
        "XDG_STATE_HOME": str(state),
        "AWS_STUB_LOG": str(tmp_path / "aws.log"),
        "AWS_STUB_STATE": str(tmp_path / "mapping-state"),
        "UV_STUB_LOG": str(tmp_path / "uv.log"),
        "ROBOTS_ADMIN_LOG": str(tmp_path / "robots-admin.log"),
    }
    # The sample map by default: a run must not depend on a deployed stack unless a test says so.
    values["SIM_MAP"] = "sample"
    for key in (
        "AWS_STUB_NO_CREDS",
        "AWS_STUB_NO_MAPPING",
        "AWS_STUB_STUCK",
        "DEMO_CONSUMER_WAIT_S",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    (tmp_path / "mapping-state").write_text("Enabled\n", encoding="utf-8")
    return values


def _run(
    script: str, *args: str, env: dict[str, str] | None = None, **extra: str
) -> subprocess.CompletedProcess[str]:
    """Runs one script with the given arguments and environment, and captures its output.

    Args:
        script: The script's file name in the scripts directory.
        *args: The arguments of the script.
        env: The environment of the run. Defaults to the current process environment.
        **extra: Variables added to the environment.

    Returns:
        The completed process.
    """
    merged = dict(os.environ if env is None else env)
    merged.update(extra)
    return subprocess.run(
        ["bash", str(SCRIPTS / script), *args],
        env=merged,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


def _state(environment: dict[str, str]) -> str:
    """Reads the state the stub mapping is in.

    Args:
        environment: The run's environment, which names the state file.

    Returns:
        The state, without its line end.
    """
    return Path(environment["AWS_STUB_STATE"]).read_text(encoding="utf-8").strip()


def _aws_calls(environment: dict[str, str]) -> list[str]:
    """Lists the AWS calls the stub recorded.

    Args:
        environment: The run's environment, which names the log.

    Returns:
        The calls, one per entry.
    """
    path = Path(environment["AWS_STUB_LOG"])
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


# demo-consumer.sh ---------------------------------------------------------------------------------


def test_status_reports_the_state_of_the_mapping(environment: dict[str, str]) -> None:
    """Given an enabled mapping, when its status is asked,
    then the state is printed and nothing changes."""
    result = _run("demo-consumer.sh", "status", env=environment)

    assert result.returncode == 0
    assert result.stdout.strip() == "Enabled"
    assert not any("update-event-source-mapping" in call for call in _aws_calls(environment))


def test_disable_turns_an_enabled_mapping_off_and_waits_for_the_state(
    environment: dict[str, str],
) -> None:
    """Given an enabled mapping, when disabled,
    then the update is sent with --no-enabled and the state is Disabled."""
    result = _run("demo-consumer.sh", "disable", env=environment)

    assert result.returncode == 0, result.stderr
    assert _state(environment) == "Disabled"
    assert any(
        "update-event-source-mapping" in c and "--no-enabled" in c for c in _aws_calls(environment)
    )


def test_disabling_a_disabled_mapping_is_a_no_op(environment: dict[str, str]) -> None:
    """Given a disabled mapping, when disabled again,
    then no update is sent and the run succeeds."""
    Path(environment["AWS_STUB_STATE"]).write_text("Disabled\n", encoding="utf-8")

    result = _run("demo-consumer.sh", "disable", env=environment)

    assert result.returncode == 0
    assert "already Disabled" in result.stdout
    assert not any("update-event-source-mapping" in c for c in _aws_calls(environment))


def test_enable_turns_a_disabled_mapping_on(environment: dict[str, str]) -> None:
    """Given a disabled mapping, when enabled,
    then the update is sent with --enabled and the state is Enabled."""
    Path(environment["AWS_STUB_STATE"]).write_text("Disabled\n", encoding="utf-8")

    result = _run("demo-consumer.sh", "enable", env=environment)

    assert result.returncode == 0, result.stderr
    assert _state(environment) == "Enabled"
    assert any(
        "--enabled" in c and "update-event-source-mapping" in c for c in _aws_calls(environment)
    )


def test_a_mapping_stuck_in_a_transition_fails_after_the_wait(environment: dict[str, str]) -> None:
    """Given a mapping that never settles, when disabled with a one-second wait,
    then the run fails and names the state."""
    result = _run(
        "demo-consumer.sh",
        "disable",
        env=environment,
        AWS_STUB_STUCK="1",
        DEMO_CONSUMER_WAIT_S="1",
    )

    assert result.returncode == 1
    assert "still Disabling" in result.stderr


def test_a_missing_mapping_fails(environment: dict[str, str]) -> None:
    """Given no event source mapping for the function, when asked,
    then the run fails and says so."""
    result = _run("demo-consumer.sh", "status", env=environment, AWS_STUB_NO_MAPPING="1")

    assert result.returncode == 1
    assert "no event source mapping" in result.stderr


def test_missing_credentials_fail_with_the_sso_hint_and_print_nothing_secret(
    environment: dict[str, str],
) -> None:
    """Given no AWS credentials, when the consumer is asked for,
    then the run fails with the login hint and no AWS call is made."""
    result = _run("demo-consumer.sh", "enable", env=environment, AWS_STUB_NO_CREDS="1")

    assert result.returncode == 1
    assert "aws sso login" in result.stderr
    assert all(call.startswith("sts ") for call in _aws_calls(environment))


@pytest.mark.parametrize("argument", ["", "restart", "enable extra"])
def test_an_unknown_action_is_a_usage_error(environment: dict[str, str], argument: str) -> None:
    """Given an action that is not enable, disable or status, when run,
    then it is a usage error (2)."""
    args = argument.split() if argument else []

    result = _run("demo-consumer.sh", *args, env=environment)

    assert result.returncode == 2


def test_a_wait_that_is_not_a_whole_number_is_a_usage_error(environment: dict[str, str]) -> None:
    """Given a wait that is not a whole number, when run, then it is a usage error (2)."""
    result = _run("demo-consumer.sh", "status", env=environment, DEMO_CONSUMER_WAIT_S="soon")

    assert result.returncode == 2


# sim.sh -------------------------------------------------------------------------------------------


def _kits(home: Path, count: int, *, first: int = 1) -> None:
    """Creates the kits of `count` simulated robots from the first index under the private home.

    Args:
        home: The private home directory.
        count: How many kits to create.
        first: The index of the first kit.
    """
    for index in range(first, first + count):
        directory = home / ".fleet" / "robots" / f"sim-{index:02d}"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "register-response.json").write_text("{}", encoding="utf-8")


@pytest.mark.parametrize("value", ["", "0", "21", "two", "-1"])
def test_sim_refuses_a_count_outside_one_to_twenty(environment: dict[str, str], value: str) -> None:
    """Given an N outside 1 to 20 or not a number, when the simulator is started,
    then it exits 2 before anything runs."""
    result = _run("sim.sh", env=environment, SIM_N=value)

    assert result.returncode == 2
    assert not Path(environment["UV_STUB_LOG"]).exists()


def test_sim_names_the_missing_kits_and_the_provision_command(
    environment: dict[str, str], home: Path
) -> None:
    """Given kits missing for some robots, when started,
    then the missing ones are named and the fix printed, exit 2."""
    _kits(home, 1)

    result = _run("sim.sh", env=environment, SIM_N="3")

    assert result.returncode == 2
    assert "sim-02 sim-03" in result.stderr
    assert "scripts/sim-provision.sh 3 --site-id paris-01" in result.stderr
    assert not Path(environment["UV_STUB_LOG"]).exists()


def test_sim_hands_over_to_the_agent_with_the_run_parameters(
    environment: dict[str, str], home: Path
) -> None:
    """Given every kit, when started, then the agent runs with the count, site, map, rate,
    timeout and seed."""
    _kits(home, 2)

    result = _run("sim.sh", env=environment, SIM_N="2", SIM_FAULT_RATE="3", SIM_SEED="5")

    assert result.returncode == 0, result.stderr
    line = Path(environment["UV_STUB_LOG"]).read_text(encoding="utf-8")
    assert "fleet-agent sim" in line
    assert "fleet-agent sim" in line
    assert "--count=2" in line
    assert "--site-id=paris-01" in line
    assert "--fault-rate-per-hour=3" in line
    assert "--max-runtime-seconds=7200" in line
    assert "--seed=5" in line
    assert "--map=" in line
    assert "sample-warehouse.geojson" in line


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("SIM_MAX_RUNTIME_S", "0"),
        ("SIM_MAX_RUNTIME_S", "14401"),
        ("SIM_MAX_RUNTIME_S", "7200s"),
        ("SIM_MAX_RUNTIME_S", "-1"),
        ("SIM_MAX_RUNTIME_S", "1e3"),
        ("SIM_FAULT_RATE", "abc"),
        ("SIM_FAULT_RATE", "-1"),
        ("SIM_FAULT_RATE", "1e3"),
        ("SIM_FAULT_RATE", "1,5"),
        ("SIM_SEED", "x"),
        ("SIM_SEED", "1.5"),
        ("SIM_SEED", "--help"),
        ("SIM_MAP", "-x.geojson"),
    ],
)
def test_sim_refuses_a_malformed_parameter_before_the_agent_runs(
    environment: dict[str, str], home: Path, variable: str, value: str
) -> None:
    """Given a malformed or out-of-range parameter, when the simulator is started,
    then it exits 2 and the agent is never run."""
    _kits(home, 1)

    result = _run("sim.sh", env=environment, SIM_N="1", **{variable: value})

    assert result.returncode == 2, result.stderr
    assert not Path(environment["UV_STUB_LOG"]).exists()


def test_sim_accepts_the_four_hour_cap_and_a_negative_seed(
    environment: dict[str, str], home: Path
) -> None:
    """Given the cap itself and a negative seed, when started, then the agent runs with them."""
    _kits(home, 1)

    result = _run("sim.sh", env=environment, SIM_N="1", SIM_MAX_RUNTIME_S="14400", SIM_SEED="-7")

    assert result.returncode == 0, result.stderr
    line = Path(environment["UV_STUB_LOG"]).read_text(encoding="utf-8")
    assert "--max-runtime-seconds=14400" in line
    assert "--seed=-7" in line


def test_sim_refuses_a_map_that_is_a_symlink(
    environment: dict[str, str], home: Path, tmp_path: Path
) -> None:
    """Given a map path that is a symbolic link, when started, then it exits 2 before the agent."""
    _kits(home, 1)
    link = tmp_path / "link.geojson"
    link.symlink_to(SAMPLE_MAP)

    result = _run("sim.sh", env=environment, SIM_N="1", SIM_MAP=str(link))

    assert result.returncode == 2
    assert not Path(environment["UV_STUB_LOG"]).exists()


def test_sim_reminds_the_operator_when_the_consumer_is_off(
    environment: dict[str, str], home: Path
) -> None:
    """Given credentials and a disabled consumer, when started,
    then a reminder is printed and the run still starts."""
    _kits(home, 1)
    Path(environment["AWS_STUB_STATE"]).write_text("Disabled\n", encoding="utf-8")

    result = _run("sim.sh", env=environment, SIM_N="1")

    assert result.returncode == 0
    assert "make demo-start" in result.stderr
    assert Path(environment["UV_STUB_LOG"]).exists()


def test_sim_without_credentials_starts_without_the_reminder(
    environment: dict[str, str], home: Path
) -> None:
    """Given no AWS credentials, when started,
    then the consumer is not queried and the run starts."""
    _kits(home, 1)

    result = _run("sim.sh", env=environment, SIM_N="1", AWS_STUB_NO_CREDS="1")

    assert result.returncode == 0
    assert "make demo-start" not in result.stderr


def test_sim_needs_uv(environment: dict[str, str], home: Path, tmp_path: Path) -> None:
    """Given no uv on the PATH, when started, then it exits 1 with the install hint."""
    _kits(home, 1)
    bare = tmp_path / "bare"
    bare.mkdir()
    for tool in ("bash", "sed", "seq", "printf", "dirname", "cat", "cut"):
        found = shutil.which(tool)
        if found is not None:
            (bare / tool).symlink_to(found)
    env = dict(environment)
    env["PATH"] = str(bare)

    result = _run("sim.sh", env=env, SIM_N="1")

    assert result.returncode == 1
    assert "uv is required" in result.stderr


# fetch-active-map.sh and the active map of sim.sh -----------------------------------------------


def _map_item(version: int, body: bytes, *, sha256: str | None = None) -> dict[str, object]:
    """Builds the DynamoDB item of one validated map version, as the API stores it.

    Args:
        version: The map version.
        body: The bytes the version was validated on.
        sha256: The recorded checksum. Defaults to the checksum of `body`.

    Returns:
        The item in the DynamoDB JSON shape that `aws dynamodb get-item` prints.
    """
    padded = f"{version:06d}"
    return {
        "Item": {
            "version": {"N": str(version)},
            "status": {"S": "VALID"},
            "s3Key": {"S": f"sites/paris-01/maps/{padded}.geojson"},
            "s3VersionId": {"S": "version-1"},
            "sha256": {"S": sha256 or hashlib.sha256(body).hexdigest()},
        }
    }


def _deployed_stack(
    tmp_path: Path,
    *,
    site: dict[str, object],
    version: dict[str, object],
    body: bytes,
) -> dict[str, str]:
    """Writes the stack outputs and the stubbed DynamoDB and S3 answers of one run.

    Args:
        tmp_path: The test's private directory.
        site: The site profile item the stub returns for the profile key.
        version: The map version item the stub returns for the version key.
        body: The bytes the stub returns for the object.

    Returns:
        The variables that point the stubs at these answers.
    """
    outputs = {
        "region": {"value": "eu-west-3"},
        "fleet_table_name": {"value": "mfc-demo-fleet"},
        "site_maps_bucket_name": {"value": "mfc-demo-site-maps-test"},
    }
    files = {
        "TF_STUB_OUTPUTS": ("outputs.json", json.dumps(outputs)),
        "AWS_STUB_SITE_ITEM": ("site-item.json", json.dumps(site)),
        "AWS_STUB_MAP_ITEM": ("map-item.json", json.dumps(version)),
    }
    variables: dict[str, str] = {}
    for variable, (name, text) in files.items():
        path = tmp_path / name
        path.write_text(text, encoding="utf-8")
        variables[variable] = str(path)
    object_path = tmp_path / "object.geojson"
    object_path.write_bytes(body)
    variables["AWS_STUB_OBJECT"] = str(object_path)
    return variables


def test_fetch_writes_the_active_map_when_its_checksum_matches(
    environment: dict[str, str], tmp_path: Path
) -> None:
    """Given an active version whose bytes match the recorded checksum, when fetched,
    then the file holds exactly those bytes, private to the operator."""
    body = SAMPLE_MAP.read_bytes()
    stack = _deployed_stack(
        tmp_path,
        site={"Item": {"activeVersion": {"N": "2"}}},
        version=_map_item(2, body),
        body=body,
    )
    output = tmp_path / "active.geojson"

    result = _run("fetch-active-map.sh", "paris-01", str(output), env=environment, **stack)

    assert result.returncode == 0, result.stderr
    assert output.read_bytes() == body
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert list(tmp_path.glob(".active-map.*")) == []


def test_fetch_refuses_a_site_without_an_active_map(
    environment: dict[str, str], tmp_path: Path
) -> None:
    """Given a site with no active version, when fetched, then it exits 1 with the console hint and
    writes nothing."""
    stack = _deployed_stack(tmp_path, site={}, version={}, body=b"{}")
    output = tmp_path / "active.geojson"

    result = _run("fetch-active-map.sh", "paris-01", str(output), env=environment, **stack)

    assert result.returncode == 1
    assert "has no active map" in result.stderr
    assert not output.exists()


def test_fetch_refuses_a_map_that_does_not_match_its_checksum(
    environment: dict[str, str], tmp_path: Path
) -> None:
    """Given bytes that differ from the recorded checksum, when fetched, then nothing is written and
    no temporary file is left behind."""
    body = SAMPLE_MAP.read_bytes()
    stack = _deployed_stack(
        tmp_path,
        site={"Item": {"activeVersion": {"N": "2"}}},
        version=_map_item(2, body, sha256="0" * 64),
        body=body,
    )
    output = tmp_path / "active.geojson"

    result = _run("fetch-active-map.sh", "paris-01", str(output), env=environment, **stack)

    assert result.returncode == 1
    assert "recorded checksum" in result.stderr
    assert not output.exists()
    assert list(tmp_path.glob(".active-map.*")) == []


def test_fetch_refuses_a_malformed_site_id_before_any_call(
    environment: dict[str, str], tmp_path: Path
) -> None:
    """Given a malformed site id, when fetched, then it is a usage error and no AWS call is made."""
    result = _run("fetch-active-map.sh", "Bad Site", str(tmp_path / "out.geojson"), env=environment)

    assert result.returncode == 2
    assert not Path(environment["AWS_STUB_LOG"]).exists()


def test_sim_runs_on_the_active_map_it_fetched(
    environment: dict[str, str], home: Path, tmp_path: Path
) -> None:
    """Given the active map of the site, when the simulator starts without SIM_MAP,
    then the agent reads the fetched copy in the cache directory."""
    _kits(home, 1)
    body = SAMPLE_MAP.read_bytes()
    stack = _deployed_stack(
        tmp_path,
        site={"Item": {"activeVersion": {"N": "2"}}},
        version=_map_item(2, body),
        body=body,
    )
    cache = tmp_path / "cache"

    result = _run(
        "sim.sh",
        env=environment,
        SIM_N="1",
        SIM_MAP="",
        XDG_CACHE_HOME=str(cache),
        **stack,
    )

    assert result.returncode == 0, result.stderr
    line = Path(environment["UV_STUB_LOG"]).read_text(encoding="utf-8")
    assert str(cache / "fleet" / "active-map-paris-01.geojson") in line
    assert (cache / "fleet" / "active-map-paris-01.geojson").read_bytes() == body


def test_sim_stops_when_the_active_map_cannot_be_fetched(
    environment: dict[str, str], home: Path
) -> None:
    """Given no deployed stack, when the simulator starts without SIM_MAP,
    then it stops with an error and never starts the robots on another map."""
    _kits(home, 1)

    result = _run("sim.sh", env=environment, SIM_N="1", SIM_MAP="")

    assert result.returncode == 1
    assert "could not be fetched" in result.stderr
    assert not Path(environment["UV_STUB_LOG"]).exists()


def test_sim_with_the_sample_setting_fetches_nothing(
    environment: dict[str, str], home: Path
) -> None:
    """Given SIM_MAP=sample, when the simulator starts,
    then the sample map is used and no DynamoDB call is made."""
    _kits(home, 1)

    result = _run("sim.sh", env=environment, SIM_N="1", SIM_MAP="sample")

    assert result.returncode == 0, result.stderr
    line = Path(environment["UV_STUB_LOG"]).read_text(encoding="utf-8")
    assert "sample-warehouse.geojson" in line
    calls = Path(environment["AWS_STUB_LOG"]).read_text(encoding="utf-8")
    assert "dynamodb" not in calls


# sim-provision.sh ---------------------------------------------------------------------------------


@pytest.fixture
def provision_tree(tmp_path: Path) -> Path:
    """Copies the provision script into a private tree beside a stub `robots-admin.sh`.

    The script finds robots-admin relative to itself, so the stub is what it runs.

    Args:
        tmp_path: The test's private directory.

    Returns:
        The root of the private tree.
    """
    tree = tmp_path / "tree"
    _executable(tree / "scripts" / "robots-admin.sh", _ROBOTS_ADMIN_STUB)
    shutil.copy(SCRIPTS / "sim-provision.sh", tree / "scripts" / "sim-provision.sh")
    return tree


def test_provision_registers_each_missing_robot_and_skips_the_existing_kit(
    environment: dict[str, str], home: Path, provision_tree: Path
) -> None:
    """Given a kit already present for sim-02, when provisioning three,
    then sim-01 and sim-03 are registered only."""
    _kits(home, 1, first=2)

    result = _run_provision(provision_tree, "3", env=environment)

    assert result.returncode == 0, result.stderr
    assert "sim-02 already has a kit; skipped" in result.stdout
    calls = Path(environment["ROBOTS_ADMIN_LOG"]).read_text(encoding="utf-8").splitlines()
    assert len(calls) == 2
    assert all("--simulated true" in call and "--type SIM" in call for call in calls)
    assert "--robot-id sim-01" in calls[0]
    assert "--robot-id sim-03" in calls[1]
    assert "created sim-01 sim-03" in result.stdout


def test_provision_stops_at_the_first_failed_registration(
    environment: dict[str, str], home: Path, provision_tree: Path
) -> None:
    """Given a registration that fails, when provisioning,
    then the run stops there and later robots are not attempted."""
    result = _run_provision(provision_tree, "3", env=environment, STUB_FAIL_ID="sim-02")

    assert result.returncode == 1
    assert "registration of sim-02 failed" in result.stderr
    assert "created so far: sim-01" in result.stderr
    calls = Path(environment["ROBOTS_ADMIN_LOG"]).read_text(encoding="utf-8").splitlines()
    assert not any("sim-03" in call for call in calls)


@pytest.mark.parametrize(
    "arguments", [[], ["0"], ["21"], ["2", "--site-id", "Bad Site"], ["2", "--nope"]]
)
def test_provision_refuses_bad_arguments_before_registering(
    environment: dict[str, str], provision_tree: Path, arguments: list[str]
) -> None:
    """Given a bad count or option, when provisioning,
    then it is a usage error (2) and nothing is registered."""
    result = _run_provision(provision_tree, *arguments, env=environment)

    assert result.returncode == 2
    assert not Path(environment["ROBOTS_ADMIN_LOG"]).exists()


def _run_provision(
    tree: Path, *args: str, env: dict[str, str], **extra: str
) -> subprocess.CompletedProcess[str]:
    """Runs the copied provision script from its private tree.

    Args:
        tree: The private tree holding the script and the stub.
        *args: The arguments of the script.
        env: The environment of the run.
        **extra: Variables added to the environment.

    Returns:
        The completed process.
    """
    merged = dict(env)
    merged.update(extra)
    return subprocess.run(
        ["bash", str(tree / "scripts" / "sim-provision.sh"), *args],
        env=merged,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


# sim-stop.sh --------------------------------------------------------------------------------------


def _lock_file(environment: dict[str, str]) -> Path:
    """Returns the lock file the stop script reads, under the private state directory.

    Args:
        environment: The run's environment, which names the state directory.

    Returns:
        The lock file path, whose directory exists.
    """
    directory = Path(environment["XDG_STATE_HOME"]) / "fleet"
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory / "sim.lock"


def test_stop_needs_flock_and_says_so(environment: dict[str, str], tmp_path: Path) -> None:
    """Given no flock on the PATH, when stopping, then it exits 1 and names the missing tool."""
    bare = tmp_path / "bare-no-flock"
    bare.mkdir()
    for tool in ("bash", "sed", "sleep", "tr", "grep", "head", "cut", "seq"):
        found = shutil.which(tool)
        if found is not None:
            (bare / tool).symlink_to(found)
    env = dict(environment)
    env["PATH"] = str(bare)

    result = _run("sim-stop.sh", env=env)

    assert result.returncode == 1
    assert "flock is required" in result.stderr


def test_stop_reports_no_simulator_when_no_lock_exists(environment: dict[str, str]) -> None:
    """Given no lock file, when stopping, then it reports that nothing runs here and exits 0."""
    result = _run("sim-stop.sh", env=environment)

    assert result.returncode == 0
    assert "no simulator running here" in result.stdout


def test_stop_treats_a_free_lock_file_as_a_leftover(environment: dict[str, str]) -> None:
    """Given a lock file that nothing holds, when stopping,
    then it reports no simulator and exits 0."""
    _lock_file(environment).write_text("12345\n", encoding="ascii")

    result = _run("sim-stop.sh", env=environment)

    assert result.returncode == 0
    assert "no simulator running here" in result.stdout


def test_stop_refuses_a_lock_holder_that_is_not_the_simulator(environment: dict[str, str]) -> None:
    """Given a lock held by a process that is not the simulator, when stopping,
    then nothing is signalled."""
    sleeper = subprocess.Popen([shutil.which("sleep") or "sleep", "30"])
    lock = _lock_file(environment)
    try:
        with lock.open("w", encoding="ascii") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            handle.write(f"{sleeper.pid}\n")
            handle.flush()
            result = _run("sim-stop.sh", env=environment)
            fcntl.flock(handle, fcntl.LOCK_UN)

        assert result.returncode == 1
        assert "not the simulator" in result.stderr
        assert sleeper.poll() is None
    finally:
        sleeper.kill()
        sleeper.wait()


def test_stop_sends_sigterm_to_the_simulator_and_waits_for_it_to_exit(
    environment: dict[str, str],
) -> None:
    """Given a lock held by a process named fleet-agent, when stopping,
    then it is terminated and the run reports it stopped."""
    sleep = shutil.which("sleep") or "/bin/sleep"
    # argv[0] is the command line the kernel shows, so the stand-in looks like the simulator.
    simulator = subprocess.Popen(["fleet-agent", "30"], executable=sleep)
    lock = _lock_file(environment)
    try:
        with lock.open("w", encoding="ascii") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            handle.write(f"{simulator.pid}\n")
            handle.flush()
            result = _run("sim-stop.sh", env=environment)
            fcntl.flock(handle, fcntl.LOCK_UN)

        assert result.returncode == 0, result.stderr
        assert "has stopped" in result.stdout
        assert simulator.wait(timeout=10) == -signal.SIGTERM
    finally:
        simulator.kill()
        simulator.wait()


# Makefile demo-stop -------------------------------------------------------------------------------

_SIM_STOP_STUB = """#!/usr/bin/env bash
echo sim-stop >>"$CALLS_LOG"
exit "${STUB_SIM_STOP_RC:-0}"
"""

_CONSUMER_STUB = """#!/usr/bin/env bash
echo "consumer $*" >>"$CALLS_LOG"
exit "${STUB_CONSUMER_RC:-0}"
"""


@pytest.fixture
def demo_tree(tmp_path: Path) -> Path:
    """Copies the Makefile into a private tree beside stub simulator and consumer scripts.

    `make -C` runs the recipe in that tree, so the stubs are the scripts the recipe calls.

    Args:
        tmp_path: The test's private directory.

    Returns:
        The root of the private tree.
    """
    tree = tmp_path / "demo-tree"
    tree.mkdir()
    shutil.copy(REPOSITORY_ROOT / "Makefile", tree / "Makefile")
    _executable(tree / "scripts" / "sim-stop.sh", _SIM_STOP_STUB)
    _executable(tree / "scripts" / "demo-consumer.sh", _CONSUMER_STUB)
    return tree


def _run_demo_stop(
    tree: Path, environment: dict[str, str], **extra: str
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """Runs `make demo-stop` in the private tree and returns the result and the stub calls.

    Args:
        tree: The private tree holding the Makefile and the stubs.
        environment: The run's environment, with the aws stub on the PATH.
        **extra: Variables added to the environment, such as the stub exit codes.

    Returns:
        The completed process and the calls the stubs recorded, in order.
    """
    calls = Path(environment["AWS_STUB_LOG"]).parent / "calls.log"
    merged = dict(environment)
    merged["CALLS_LOG"] = str(calls)
    merged.update(extra)
    result = subprocess.run(
        ["make", "-C", str(tree), "demo-stop"],
        env=merged,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    recorded = calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []
    return result, recorded


def test_demo_stop_disables_the_consumer_even_when_the_simulator_fails(
    environment: dict[str, str], demo_tree: Path
) -> None:
    """Given a simulator stop that fails with 1, when demo-stop runs,
    then the consumer is still disabled and the target exits with 1."""
    result, calls = _run_demo_stop(demo_tree, environment, STUB_SIM_STOP_RC="1")

    assert calls == ["sim-stop", "consumer disable"]
    assert result.returncode != 0
    assert "Error 1" in result.stderr


def test_demo_stop_reports_a_failed_consumer_disable_after_a_clean_stop(
    environment: dict[str, str], demo_tree: Path
) -> None:
    """Given a clean simulator stop and a consumer disable that fails with 1,
    then the target exits with 1."""
    result, calls = _run_demo_stop(demo_tree, environment, STUB_CONSUMER_RC="1")

    assert calls == ["sim-stop", "consumer disable"]
    assert "Error 1" in result.stderr


def test_demo_stop_succeeds_when_both_steps_succeed(
    environment: dict[str, str], demo_tree: Path
) -> None:
    """Given a clean simulator stop and a clean consumer disable, when demo-stop runs,
    then the target exits 0."""
    result, calls = _run_demo_stop(demo_tree, environment)

    assert result.returncode == 0, result.stderr
    assert calls == ["sim-stop", "consumer disable"]


def test_keep_consumer_leaves_the_consumer_on_and_keeps_the_simulator_status(
    environment: dict[str, str], demo_tree: Path
) -> None:
    """Given KEEP_CONSUMER=1 and a failed simulator stop, when demo-stop runs,
    then the consumer is not touched and the target still exits with 1."""
    result, calls = _run_demo_stop(demo_tree, environment, KEEP_CONSUMER="1", STUB_SIM_STOP_RC="1")

    assert calls == ["sim-stop"]
    assert "Error 1" in result.stderr
