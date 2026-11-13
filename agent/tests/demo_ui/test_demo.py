"""Tests of the demo controller: ordering, idempotency, the single-operation rule and failures.

The controller runs with a scripted runner, a spawner that takes the simulator lock like a real
simulator, and a clock that moves only when the code sleeps. Real lock files are used, so the lock
probe is tested as well.
"""

from __future__ import annotations

import fcntl
import json
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import pytest

from fleet_agent.demo_ui.aws_reads import AwsReader
from fleet_agent.demo_ui.config import Settings, load_settings
from fleet_agent.demo_ui.demo import DemoController, DemoStatus, sim_lock_held
from fleet_agent.demo_ui.errors import DemoError
from fleet_agent.demo_ui.runner import CommandResult
from tests.demo_ui.fakes import (
    STACK,
    FakeClock,
    FakeRunner,
    FakeSpawner,
    FixedOutputs,
    LockHolder,
    fail,
    held_lock,
    ok,
)

NOW = 1_000_000.0
SITE = "paris-01"


@dataclass
class World:
    """Scripted answers of the commands. A missing key is a success, with the default output."""

    results: dict[str, CommandResult] = field(default_factory=dict)
    hooks: dict[str, Callable[[], None]] = field(default_factory=dict)
    gates: dict[str, threading.Event] = field(default_factory=dict)
    sts: CommandResult = field(default_factory=lambda: ok("{}"))
    registry_items: list[dict[str, object]] = field(default_factory=list)

    def answer(self, argv: list[str]) -> CommandResult:
        if argv[:3] == ["aws", "sts", "get-caller-identity"]:
            return self.sts
        if argv[0] == "terraform":
            return ok(_stack_json())
        if argv[0] == "aws":
            if "dynamodb" in argv and "STATE#" not in " ".join(argv):
                return ok(json.dumps({"Items": self.registry_items}))
            return ok(json.dumps({"Items": []}))
        name = Path(argv[1]).name
        key = f"consumer:{argv[2]}" if name == "demo-consumer.sh" else name
        gate = self.gates.get(key)
        if gate is not None:
            gate.wait(5)
        hook = self.hooks.get(key)
        if hook is not None:
            hook()
        default = ok("Enabled\n") if key == "consumer:status" else ok()
        return self.results.get(key, default)


def _stack_json() -> str:
    values = {
        "console_origin": STACK.console_origin,
        "user_pool_id": STACK.user_pool_id,
        "region": STACK.region,
        "fleet_table_name": STACK.fleet_table_name,
    }
    return json.dumps({name: {"value": value} for name, value in values.items()})


@dataclass
class Rig:
    settings: Settings
    world: World
    runner: FakeRunner
    spawner: FakeSpawner
    clock: FakeClock
    holder: LockHolder
    controller: DemoController

    def wait_idle(self) -> DemoStatus:
        deadline = time.monotonic() + 10
        status = self.controller.status(SITE)
        while status.phase in ("starting", "stopping"):
            if time.monotonic() > deadline:
                raise AssertionError("the worker did not finish")
            time.sleep(0.01)
            status = self.controller.status(SITE)
        return status

    def bash_calls(self) -> list[list[str]]:
        return [call for call in self.runner.calls if call[0] == "bash" and "status" not in call]


def _rig(tmp_path: Path, *, sim_count: int = 2, with_hook: bool = True) -> Rig:
    settings = load_settings({"HOME": str(tmp_path), "SIM_N": str(sim_count)}, [])
    world = World()
    runner = FakeRunner(answer=world.answer)
    clock = FakeClock(current=NOW)
    holder = LockHolder(settings.sim_lock_path)
    spawner = FakeSpawner(on_spawn=holder.acquire if with_hook else None)
    aws = AwsReader(runner, settings, FixedOutputs(STACK), clock_ms=lambda: int(NOW * 1000))
    controller = DemoController(
        runner=runner,
        spawner=spawner,
        aws=aws,
        outputs=FixedOutputs(STACK),
        settings=settings,
        clock=clock,
    )
    rig = Rig(settings, world, runner, spawner, clock, holder, controller)
    rig._world = world  # type: ignore[attr-defined]
    return rig


def _kits(settings: Settings, count: int) -> None:
    for index in range(1, count + 1):
        directory = settings.kit_root / f"sim-{index:02d}"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "register-response.json").write_text("{}", encoding="utf-8")


def test_start_runs_consumer_then_spawns_the_simulators_in_order(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    gate = threading.Event()
    rig._world.gates["consumer:enable"] = gate  # type: ignore[attr-defined]

    try:
        first = rig.controller.start(SITE)
        assert first.phase == "starting"
        assert first.step == "consumer"
        assert rig.spawner.calls == []
        gate.set()
        status = rig.wait_idle()
    finally:
        gate.set()
        rig.holder.release()

    assert status.phase == "running"
    assert status.simulators_running is True
    assert [call[1:] for call in rig.bash_calls()] == [
        [str(rig.settings.script("demo-consumer.sh")), "enable"],
    ]
    assert len(rig.spawner.calls) == 1
    argv, env, log_path = rig.spawner.calls[0]
    assert argv == ["bash", str(rig.settings.script("sim.sh"))]
    assert env["SIM_N"] == "2"
    assert env["SIM_SITE_ID"] == SITE
    assert env["SIM_MAX_RUNTIME_S"] == "7200"
    assert log_path == rig.settings.sim_log_path


def test_start_with_a_count_launches_that_many_simulators_and_reports_it(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 3)

    try:
        rig.controller.start(SITE, 3)
        status = rig.wait_idle()
    finally:
        rig.holder.release()

    assert status.sim_count == 3
    _, env, _ = rig.spawner.calls[0]
    assert env["SIM_N"] == "3"


@pytest.mark.parametrize("count", [0, 21, -4])
def test_start_refuses_a_count_out_of_range(tmp_path: Path, count: int) -> None:
    rig = _rig(tmp_path)

    with pytest.raises(ValueError, match="out of range"):
        rig.controller.start(SITE, count)

    assert rig.spawner.calls == []


def test_auto_stop_is_the_start_plus_the_runtime_limit(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)

    try:
        rig.controller.start(SITE)
        status = rig.wait_idle()
    finally:
        rig.holder.release()

    expected = datetime.fromtimestamp(NOW + 7200, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert status.auto_stop_at == expected


def test_provisioning_runs_only_when_a_kit_is_missing(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 1)

    try:
        rig.controller.start(SITE)
        status = rig.wait_idle()
    finally:
        rig.holder.release()

    scripts = [Path(call[1]).name for call in rig.bash_calls()]
    assert scripts == ["demo-consumer.sh", "sim-provision.sh"]
    assert len(rig.spawner.calls) == 1
    provision = next(call for call in rig.bash_calls() if call[1].endswith("sim-provision.sh"))
    assert provision[2:] == ["2", "--site-id", SITE]
    assert status.phase == "running"


def test_second_start_while_running_launches_nothing(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)

    try:
        rig.controller.start(SITE)
        rig.wait_idle()
        again = rig.controller.start(SITE)
    finally:
        rig.holder.release()

    assert again.phase == "running"
    assert len(rig.spawner.calls) == 1


def test_concurrent_start_is_refused_with_in_progress(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    gate = threading.Event()
    rig._world.gates["consumer:enable"] = gate  # type: ignore[attr-defined]

    try:
        rig.controller.start(SITE)
        with pytest.raises(DemoError) as caught:
            rig.controller.start(SITE)
        assert caught.value.code == "IN_PROGRESS"
        gate.set()
        assert rig.wait_idle().phase == "running"
    finally:
        gate.set()
        rig.holder.release()


def test_provisioning_failure_sets_the_error_and_spawns_nothing(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    rig._world.results["sim-provision.sh"] = fail("denied")  # type: ignore[attr-defined]

    rig.controller.start(SITE)
    status = rig.wait_idle()

    assert status.phase == "error"
    assert status.error is not None
    assert status.error.code == "PROVISION_FAILED"
    assert rig.spawner.calls == []
    assert "denied" not in status.error.message


def test_consumer_that_cannot_be_enabled_is_a_consumer_failure(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    rig._world.results["consumer:enable"] = fail()  # type: ignore[attr-defined]

    rig.controller.start(SITE)
    status = rig.wait_idle()

    assert status.error is not None
    assert status.error.code == "CONSUMER_FAILED"
    assert rig.spawner.calls == []


def test_spawn_failure_is_a_simulator_failure(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    rig.spawner.raises = OSError("no such program")

    rig.controller.start(SITE)
    status = rig.wait_idle()

    assert status.error is not None
    assert status.error.code == "SIM_FAILED"


def test_lock_not_taken_in_time_is_a_simulator_failure(tmp_path: Path) -> None:
    rig = _rig(tmp_path, with_hook=False)
    _kits(rig.settings, 2)

    rig.controller.start(SITE)
    status = rig.wait_idle()

    assert status.error is not None
    assert status.error.code == "SIM_FAILED"
    assert sum(rig.clock.sleeps) >= 20


def test_stop_stops_the_simulators_then_disables_the_consumer(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    rig._world.hooks["sim-stop.sh"] = rig.holder.release  # type: ignore[attr-defined]
    gate = threading.Event()
    rig._world.gates["sim-stop.sh"] = gate  # type: ignore[attr-defined]
    rig.controller.start(SITE)
    rig.wait_idle()

    stopping = rig.controller.stop(SITE)
    assert stopping.phase == "stopping"
    gate.set()
    status = rig.wait_idle()

    assert status.phase == "stopped"
    assert status.error is None
    scripts = [(Path(call[1]).name, call[2:]) for call in rig.bash_calls()]
    assert scripts[-2:] == [("sim-stop.sh", []), ("demo-consumer.sh", ["disable"])]


def test_consumer_is_disabled_even_when_the_simulators_do_not_stop(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    rig.controller.start(SITE)
    rig.wait_idle()
    rig._world.results["sim-stop.sh"] = fail("still running", returncode=1)  # type: ignore[attr-defined]

    rig.controller.stop(SITE)
    status = rig.wait_idle()

    assert status.error is not None
    assert status.error.code == "STOP_TIMEOUT"
    assert any(
        call[1:] == [str(rig.settings.script("demo-consumer.sh")), "disable"]
        for call in rig.bash_calls()
    )
    rig.holder.release()


def test_stop_when_nothing_runs_succeeds(tmp_path: Path) -> None:
    rig = _rig(tmp_path)

    rig.controller.stop(SITE)
    status = rig.wait_idle()

    assert status.phase == "stopped"
    assert status.error is None
    assert Path(rig.bash_calls()[-1][1]).name == "demo-consumer.sh"


def test_status_without_a_session_reports_no_session_and_reads_nothing_else(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    rig._world.sts = fail("ExpiredToken")  # type: ignore[attr-defined]

    status = rig.controller.status(SITE)

    assert status.error is not None
    assert status.error.code == "NO_SESSION"
    assert status.consumer == "unknown"
    assert all(call[0] != "aws" or "dynamodb" not in call for call in rig.runner.calls)


def test_status_lists_only_the_real_robots(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    rig._world.registry_items = [  # type: ignore[attr-defined]
        {
            "robotId": {"S": "sim-01"},
            "name": {"S": "Sim"},
            "simulated": {"BOOL": True},
            "status": {"S": "ACTIVE"},
        },
        {
            "robotId": {"S": "kali-01"},
            "name": {"S": "Kali"},
            "simulated": {"BOOL": False},
            "status": {"S": "ACTIVE"},
        },
    ]

    status = rig.controller.status(SITE)

    assert [row.robot_id for row in status.real_robots] == ["kali-01"]
    assert status.real_robots[0].connection == "unknown"
    assert status.console_url == STACK.console_origin


def test_status_derives_running_from_the_lock_not_from_memory(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    with held_lock(rig.settings.sim_lock_path):
        status = rig.controller.status(SITE)

    assert status.phase == "running"
    assert status.simulators_running is True
    assert status.auto_stop_at is None
    assert sim_lock_held(rig.settings.sim_lock_path) is False


@pytest.mark.parametrize("call", ["start", "stop", "status"])
def test_any_other_site_is_refused_before_a_command_is_built(tmp_path: Path, call: str) -> None:
    rig = _rig(tmp_path)

    with pytest.raises(DemoError) as caught:
        getattr(rig.controller, call)("../x")

    assert caught.value.code == "UNKNOWN_SITE"
    assert rig.runner.calls == []


def test_every_command_is_an_argument_list_on_a_repository_script(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    rig._world.hooks["sim-stop.sh"] = rig.holder.release  # type: ignore[attr-defined]
    rig.controller.start(SITE)
    rig.wait_idle()
    rig.controller.stop(SITE)
    rig.wait_idle()

    for call in rig.bash_calls():
        assert call[0] == "bash"
        assert call[1].startswith(str(rig.settings.repo_root / "scripts"))
        assert all(isinstance(part, str) for part in call)
    assert all(not any(" " in part for part in call[:2]) for call in rig.runner.calls)


def test_stop_during_a_start_cancels_it_without_a_conflict(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    gate = threading.Event()
    rig._world.gates["consumer:enable"] = gate  # type: ignore[attr-defined]

    try:
        rig.controller.start(SITE)
        stopping = rig.controller.stop(SITE)
        assert stopping.step == "cancelling"
        gate.set()
        status = rig.wait_idle()
    finally:
        gate.set()
        rig.holder.release()

    assert rig.spawner.calls == []
    scripts = [Path(call[1]).name for call in rig.bash_calls()]
    assert scripts == ["demo-consumer.sh", "sim-stop.sh", "demo-consumer.sh"]
    assert status.phase == "stopped"
    assert status.error is None


def test_stop_during_the_lock_wait_still_runs_the_stop_steps(tmp_path: Path) -> None:
    rig = _rig(tmp_path)
    _kits(rig.settings, 2)
    holder = rig.holder

    def simulator_takes_lock_and_a_stop_arrives() -> None:
        holder.acquire()
        rig.controller.stop(SITE)

    rig.spawner.on_spawn = simulator_takes_lock_and_a_stop_arrives
    rig._world.hooks["sim-stop.sh"] = holder.release  # type: ignore[attr-defined]

    rig.controller.start(SITE)
    status = rig.wait_idle()

    scripts = [Path(call[1]).name for call in rig.bash_calls()]
    assert scripts[-2:] == ["sim-stop.sh", "demo-consumer.sh"]
    assert status.phase == "stopped"
    assert status.simulators_running is False


def test_simulator_that_exits_without_its_lock_is_respawned_once(tmp_path: Path) -> None:
    rig = _rig(tmp_path, with_hook=False)
    _kits(rig.settings, 2)
    attempts: list[int] = []

    def second_attempt_takes_the_lock() -> None:
        attempts.append(1)
        if len(attempts) == 2:
            rig.holder.acquire()

    rig.spawner.on_spawn = second_attempt_takes_the_lock
    rig.spawner.alive_answers = [False]

    try:
        rig.controller.start(SITE)
        status = rig.wait_idle()
    finally:
        rig.holder.release()

    assert len(rig.spawner.calls) == 2
    assert status.phase == "running"
    assert status.error is None


def test_simulator_that_exits_twice_is_a_simulator_failure(tmp_path: Path) -> None:
    rig = _rig(tmp_path, with_hook=False)
    _kits(rig.settings, 2)
    rig.spawner.alive_answers = [False, False]

    rig.controller.start(SITE)
    status = rig.wait_idle()

    assert len(rig.spawner.calls) == 2
    assert status.error is not None
    assert status.error.code == "SIM_FAILED"


def test_lock_probe_does_not_take_the_lock(tmp_path: Path) -> None:
    lock = tmp_path / "sim.lock"
    lock.write_text("", encoding="utf-8")

    assert sim_lock_held(lock) is False
    fd = os.open(lock, os.O_RDWR)
    try:
        # The probe must have left the lock free: a second locker gets it at once.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def test_lock_probe_sees_a_holder_without_taking_the_lock(tmp_path: Path) -> None:
    lock = tmp_path / "sim.lock"
    with held_lock(lock):
        assert sim_lock_held(lock) is True
        assert sim_lock_held(lock) is True
    assert sim_lock_held(lock) is False
