"""Controller of the demo: starts and stops the simulated fleet through the repository's scripts.

Start and stop run in a worker thread, so that the page can poll while the steps run (a provisioning
can take minutes). At most one of them runs at a time. The status comes from the simulator's lock
file, not from memory, so that a restart of the page shows the truth. The steps and their order are
those of `make demo-start`, `make demo-stop` and `scripts/sim.sh`, and every command is an argument
list of the repository's scripts.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, Literal, Protocol

from fleet_agent.demo_ui.aws_reads import AwsReader, RobotRow, UserRow
from fleet_agent.demo_ui.config import MAX_SIM_COUNT, Settings
from fleet_agent.demo_ui.errors import DemoError, ErrorCode, ProblemInfo
from fleet_agent.demo_ui.outputs import OutputsSource, StackOutputs
from fleet_agent.demo_ui.runner import CommandRunner, Spawner, minimal_env

logger = logging.getLogger(__name__)

PROVISION_TIMEOUT_S: Final = 300.0
CONSUMER_STEP_TIMEOUT_S: Final = 90.0
SIM_STOP_TIMEOUT_S: Final = 45.0
"""Longer than the 30 s grace of `scripts/sim-stop.sh`, which waits by itself."""

LOCK_WAIT_S: Final = 20.0
"""How long a started simulator may take to take its lock before the start is reported as failed."""

LOCK_POLL_S: Final = 0.5

Phase = Literal["stopped", "starting", "running", "stopping", "error"]
Operation = Literal["start", "stop"]


class Clock(Protocol):
    """The time source of the controller. Tests inject a clock that moves only when told."""

    def now(self) -> float:
        """Returns the current time.

        Returns:
            Seconds since the Unix epoch.
        """
        ...

    def sleep(self, seconds: float) -> None:
        """Waits.

        Args:
            seconds: The time to wait.
        """
        ...


class SystemClock:
    """The real clock."""

    def now(self) -> float:
        """Returns the current time.

        Returns:
            Seconds since the Unix epoch.
        """
        return time.time()

    def sleep(self, seconds: float) -> None:
        """Waits in the calling thread.

        Args:
            seconds: The time to wait.
        """
        time.sleep(seconds)


@dataclass(frozen=True)
class DemoStatus:
    """The state of the demo as the page shows it.

    Attributes:
        phase: What the page is doing: idle, starting, running, stopping, or failed at the last
        action.
        consumer: The ingest consumer state (`Enabled`, `Disabled`, or `unknown`).
        simulators_running: True while a simulator holds its lock on this machine.
        sim_count: The number of simulated robots the page starts.
        auto_stop_at: When the simulators stop by themselves, as UTC. None when unknown (after a
        restart).
        real_robots: The registry entries of the real robots, with their connection.
        step: The step of a running start or stop, for display.
        error: The last failure, or the failure of the current read.
        console_url: The console origin, once the stack outputs are known.
    """

    phase: Phase
    consumer: str
    simulators_running: bool
    sim_count: int
    auto_stop_at: str | None
    real_robots: tuple[RobotRow, ...]
    step: str | None
    error: ProblemInfo | None
    console_url: str | None


def sim_lock_held(lock_path: Path) -> bool:
    """Tells whether a simulator holds its lock, without taking the lock.

    The simulator locks with `flock`. Taking the lock to test it would make a simulator that starts
    at the same moment refuse to run, so the probe reads the kernel's list of `flock` holders in
    `/proc/locks` and matches the lock file by its device and inode.

    Args:
        lock_path: The lock file of the simulators.

    Returns:
        True when a process holds a `flock` on the file. A missing file, or a kernel without
        `/proc/locks`, reads as no simulator; the simulator itself refuses a second run.
    """
    try:
        status = lock_path.stat()
        locks = Path("/proc/locks").read_text(encoding="ascii")
    except OSError:
        return False
    identity = f"{os.major(status.st_dev):02x}:{os.minor(status.st_dev):02x}:{status.st_ino}"
    for line in locks.splitlines():
        fields = line.split()
        if len(fields) >= 6 and fields[1] == "FLOCK" and fields[5] == identity:
            return True
    return False


def _iso_utc(seconds: float) -> str:
    """Formats an instant for the page.

    Args:
        seconds: Seconds since the Unix epoch.

    Returns:
        The UTC instant as `YYYY-MM-DDTHH:MM:SSZ`.
    """
    return datetime.fromtimestamp(seconds, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sim_name(index: int) -> str:
    """Names the simulated robot with a number, as `scripts/sim.sh` does.

    Args:
        index: The robot number, from 1.

    Returns:
        The robot identifier, for example `sim-01`.
    """
    return f"sim-{index:02d}"


class _StartCancelledError(Exception):
    """Raised inside the start worker when a stop asked it to end before it launched more steps."""


class DemoController:
    """Starts, stops and reports the demo. Every method is safe from the server threads."""

    def __init__(
        self,
        *,
        runner: CommandRunner,
        spawner: Spawner,
        aws: AwsReader,
        outputs: OutputsSource,
        settings: Settings,
        clock: Clock,
    ) -> None:
        """Creates the controller with no operation running.

        Args:
            runner: Runs the repository scripts.
            spawner: Starts the simulators in the background.
            aws: The read-only AWS queries.
            outputs: The stack outputs (console origin).
            settings: The validated settings.
            clock: The time source.
        """
        self._runner = runner
        self._spawner = spawner
        self._aws = aws
        self._outputs = outputs
        self._settings = settings
        self._clock = clock
        self._guard = threading.Lock()
        self._operation: Operation | None = None
        self._step: str | None = None
        self._error: ProblemInfo | None = None
        self._started_at: float | None = None
        # Set by a stop during a start; checked between the steps, never in the middle of one.
        self._cancel = threading.Event()
        self._sim_pid: int | None = None
        # The size of the fleet the page launches: the configured default until a start names one.
        self._sim_count = settings.sim_count

    def status(self, site_id: str) -> DemoStatus:
        """Reads the demo state: lock, consumer, real robots and the current operation.

        Args:
            site_id: The site. Anything but the configured site is refused.

        Returns:
            The status. A failed read is reported in `error`, not raised.

        Raises:
            DemoError: With `UNKNOWN_SITE` when the site is not the configured one.
        """
        self._check_site(site_id)
        with self._guard:
            operation = self._operation
            step = self._step
            error = self._error
            started_at = self._started_at
        held = sim_lock_held(self._settings.sim_lock_path)
        session_ok = self._aws.session_identity().valid
        consumer = self._aws.consumer_state() if session_ok else "unknown"
        shown = error
        real_robots: tuple[RobotRow, ...] = ()
        if not session_ok:
            shown = shown or DemoError("NO_SESSION").problem()
        else:
            try:
                real_robots = tuple(
                    row for row in self._aws.list_robots(site_id) if row.kind == "real"
                )
            except DemoError as failure:
                shown = shown or failure.problem()
        phase: Phase
        if operation == "start":
            phase = "starting"
        elif operation == "stop":
            phase = "stopping"
        elif error is not None:
            phase = "error"
        else:
            phase = "running" if held else "stopped"
        auto_stop_at = None
        if held and started_at is not None:
            auto_stop_at = _iso_utc(started_at + self._settings.max_runtime_s)
        return DemoStatus(
            phase=phase,
            consumer=consumer,
            simulators_running=held,
            sim_count=self._sim_count,
            auto_stop_at=auto_stop_at,
            real_robots=real_robots,
            step=step if operation is not None else None,
            error=shown,
            console_url=self._console_url(),
        )

    def start(self, site_id: str, count: int | None = None) -> DemoStatus:
        """Starts the simulators in a worker thread, unless they already run.

        Args:
            site_id: The site. Anything but the configured site is refused.
            count: The number of simulated robots to launch, from 1 to the maximum, or None to keep
                the current size (the configured default at first). Ignored when the simulators
                already run: a running fleet keeps its size.

        Returns:
            The status: `starting` when a worker was launched, `running` when nothing had to be
            launched.

        Raises:
            DemoError: With `UNKNOWN_SITE`, or `IN_PROGRESS` when a start or a stop is already
            running.
            ValueError: When `count` is outside 1 to the maximum. The HTTP layer validates it first.
        """
        self._check_site(site_id)
        if count is not None and not 1 <= count <= MAX_SIM_COUNT:
            raise ValueError("the number of simulated robots is out of range")
        with self._guard:
            if self._operation is not None:
                raise DemoError("IN_PROGRESS")
            launch = not sim_lock_held(self._settings.sim_lock_path)
            if launch:
                if count is not None:
                    self._sim_count = count
                self._operation = "start"
                self._step = "session"
                self._error = None
                self._cancel.clear()
        if launch:
            threading.Thread(target=self._run_start, name="demo-ui-start", daemon=True).start()
        return self.status(site_id)

    def stop(self, site_id: str) -> DemoStatus:
        """Stops the simulators and disables the ingest consumer, in a worker thread.

        Stopping when nothing runs succeeds: the scripts report that and the consumer is still
        disabled.

        Args:
            site_id: The site. Anything but the configured site is refused.

        Returns:
            The status, with phase `stopping`.

        Raises:
            DemoError: With `UNKNOWN_SITE`, or `IN_PROGRESS` when a start or a stop is already
            running.
        """
        self._check_site(site_id)
        with self._guard:
            if self._operation == "start":
                # A stop preempts a start: the start stops at its next step boundary and the stop
                # steps run in the same worker, so the simulators are never left running.
                self._cancel.set()
                self._step = "cancelling"
                cancelled = True
            elif self._operation == "stop":
                raise DemoError("IN_PROGRESS")
            else:
                cancelled = False
        if cancelled:
            return self.status(site_id)
        with self._guard:
            self._operation = "stop"
            self._step = "simulators"
            self._error = None
        threading.Thread(target=self._run_stop, name="demo-ui-stop", daemon=True).start()
        return self.status(site_id)

    def stack_outputs(self) -> StackOutputs:
        """Returns the stack outputs for the links.

        Returns:
            The validated outputs.

        Raises:
            DemoError: When the outputs cannot be read.
        """
        return self._outputs.get()

    def users(self, site_id: str) -> list[UserRow]:
        """Lists the pool's accounts. Users are global to the pool; the site is only checked.

        Args:
            site_id: The site. Anything but the configured site is refused.

        Returns:
            The users of the pool.

        Raises:
            DemoError: When Cognito cannot be read.
        """
        self._check_site(site_id)
        return self._aws.list_users()

    def robots(self, site_id: str) -> list[RobotRow]:
        """Lists the robots of the site, simulated and real.

        Args:
            site_id: The site. Anything but the configured site is refused.

        Returns:
            The robots of the site.

        Raises:
            DemoError: When the registry cannot be read.
        """
        self._check_site(site_id)
        return self._aws.list_robots(site_id)

    def _check_site(self, site_id: str) -> None:
        """Refuses any site but the configured one, before a command is built from it.

        Args:
            site_id: The site named by the request.

        Raises:
            DemoError: With `UNKNOWN_SITE`.
        """
        if site_id != self._settings.site_id:
            raise DemoError("UNKNOWN_SITE")

    def _console_url(self) -> str | None:
        """Returns the console origin when the outputs can be read, otherwise None.

        Returns:
            The origin, or None.
        """
        try:
            return self._outputs.get().console_origin
        except DemoError:
            return None

    def _set_step(self, step: str) -> None:
        """Records the step of the running operation for the page.

        Args:
            step: The step name.
        """
        with self._guard:
            self._step = step

    def _run_start(self) -> None:
        """Worker of a start: runs its steps, then the stop steps if a stop arrived."""
        problem: ProblemInfo | None = None
        try:
            self._start_steps()
        except _StartCancelledError:
            pass
        except DemoError as failure:
            problem = failure.problem()
        except Exception as failure:
            # The class name only: the message of an unexpected error may hold a path or a value.
            logger.error("demo start stopped on an unexpected %s", type(failure).__name__)
            problem = DemoError("INTERNAL").problem()
        with self._guard:
            if not self._cancel.is_set():
                self._operation = None
                self._step = None
                self._error = problem
                if not sim_lock_held(self._settings.sim_lock_path):
                    self._started_at = None
                return
            # Check and hand-over happen under the guard, so a stop arriving now is not lost.
            self._operation = "stop"
            self._step = "simulators"
        self._finish(self._stop_problem())

    def _run_stop(self) -> None:
        """Worker of a stop: runs the steps and records the outcome. Never raises."""
        self._finish(self._stop_problem())

    def _stop_problem(self) -> ProblemInfo | None:
        """Runs the stop steps; returns their failure, or the internal error without raising.

        Returns:
            The failure, or None when the stop succeeded.
        """
        try:
            return self._stop_steps()
        except Exception as failure:
            logger.error("demo stop stopped on an unexpected %s", type(failure).__name__)
            return DemoError("INTERNAL").problem()

    def _finish(self, problem: ProblemInfo | None) -> None:
        """Ends the operation and records its failure, if any.

        Args:
            problem: The failure of the operation, or None on success.
        """
        with self._guard:
            self._operation = None
            self._step = None
            self._error = problem
            if not sim_lock_held(self._settings.sim_lock_path):
                self._started_at = None

    def _start_steps(self) -> None:
        """Runs the start steps in order: session, consumer, provisioning, spawn, lock wait.

        Raises:
            DemoError: With the code of the step that failed.
        """
        site_id = self._settings.site_id
        self._set_step("session")
        self._check_cancel()
        if not self._aws.session_identity().valid:
            raise DemoError("NO_SESSION")
        self._check_cancel()
        self._set_step("consumer")
        self._run_step(
            "consumer",
            ["bash", str(self._settings.script("demo-consumer.sh")), "enable"],
            CONSUMER_STEP_TIMEOUT_S,
            "CONSUMER_FAILED",
        )
        self._check_cancel()
        if self._missing_kits():
            self._check_cancel()
            self._set_step("provision")
            self._run_step(
                "provision",
                [
                    "bash",
                    str(self._settings.script("sim-provision.sh")),
                    str(self._sim_count),
                    "--site-id",
                    site_id,
                ],
                PROVISION_TIMEOUT_S,
                "PROVISION_FAILED",
            )
        self._check_cancel()
        self._set_step("spawn")
        self._sim_pid = self._spawn_simulator()
        with self._guard:
            self._started_at = self._clock.now()
        self._set_step("wait")
        self._wait_for_lock()

    def _check_cancel(self) -> None:
        """Ends the start when a stop asked for it, before the next step.

        Raises:
            _StartCancelledError: When a stop has been requested.
        """
        if self._cancel.is_set():
            raise _StartCancelledError()

    def _spawn_simulator(self) -> int:
        """Starts `scripts/sim.sh` in the background with the simulator settings.

        Returns:
            The process identifier.

        Raises:
            DemoError: With `SIM_FAILED` when the process cannot be started.
        """
        # The variables are the ones scripts/sim.sh reads; other SIM_* settings stay out.
        sim_env = minimal_env(
            extra={
                "SIM_N": str(self._sim_count),
                "SIM_SITE_ID": self._settings.site_id,
                "SIM_MAX_RUNTIME_S": str(self._settings.max_runtime_s),
            }
        )
        try:
            return self._spawner.spawn(
                ["bash", str(self._settings.script("sim.sh"))],
                sim_env,
                self._settings.sim_log_path,
            )
        except OSError as failure:
            logger.error("the simulator could not be spawned: %s", type(failure).__name__)
            raise DemoError("SIM_FAILED") from failure

    def _stop_steps(self) -> ProblemInfo | None:
        """Runs the stop steps: the simulators first, then the consumer, even when the first failed.

        Returns:
            The first failure, or None on success.
        """
        problem: ProblemInfo | None = None
        stop = self._runner.run(
            ["bash", str(self._settings.script("sim-stop.sh"))],
            timeout_s=SIM_STOP_TIMEOUT_S,
        )
        if stop.returncode != 0 or stop.timed_out:
            logger.warning("sim-stop failed with return code %s", stop.returncode)
            problem = DemoError("STOP_TIMEOUT").problem()
        self._set_step("consumer")
        disable = self._runner.run(
            ["bash", str(self._settings.script("demo-consumer.sh")), "disable"],
            timeout_s=CONSUMER_STEP_TIMEOUT_S,
        )
        if disable.returncode != 0 or disable.timed_out:
            logger.warning("demo-consumer disable failed with return code %s", disable.returncode)
            problem = problem or DemoError("CONSUMER_FAILED").problem()
        return problem

    def _run_step(self, name: str, argv: list[str], timeout_s: float, code: ErrorCode) -> None:
        """Runs one script of a start and fails with its code when it does not succeed.

        Args:
            name: The step name, for the log.
            argv: The command.
            timeout_s: Its time limit.
            code: The error code of a failure.

        Raises:
            DemoError: With `code` when the script fails or times out.
        """
        result = self._runner.run(argv, timeout_s=timeout_s)
        if result.returncode != 0 or result.timed_out:
            logger.warning("demo step %s failed with return code %s", name, result.returncode)
            raise DemoError(code)

    def _missing_kits(self) -> list[str]:
        """Lists the simulated robots whose kit is missing, so provisioning runs only then.

        Returns:
            The identifiers of the robots without a registration response.
        """
        return [
            _sim_name(index)
            for index in range(1, self._sim_count + 1)
            if not (self._settings.kit_root / _sim_name(index) / "register-response.json").exists()
        ]

    def _wait_for_lock(self) -> None:
        """Waits until the simulator holds its lock, up to `LOCK_WAIT_S`.

        A simulator that exits without the lock (it refused to start, or crashed) is respawned once;
        a second exit is a failure.

        Raises:
            DemoError: With `SIM_FAILED` when the lock is not taken in time or after the respawn.
        """
        deadline = self._clock.now() + LOCK_WAIT_S
        respawned = False
        while not sim_lock_held(self._settings.sim_lock_path):
            if self._clock.now() >= deadline:
                raise DemoError("SIM_FAILED")
            if self._sim_pid is not None and not self._spawner.alive(self._sim_pid):
                if respawned:
                    raise DemoError("SIM_FAILED")
                respawned = True
                logger.warning("the simulator exited without its lock; starting it once more")
                self._sim_pid = self._spawn_simulator()
            self._clock.sleep(LOCK_POLL_S)
