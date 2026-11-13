"""Fakes of the demo control page: a scripted runner, a spawner, a clock and a lock holder.

No fake touches AWS or the network. The runner answers from a function the test writes,
so each test states the
exact answer of every command it expects.
"""

from __future__ import annotations

import fcntl
import os
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fleet_agent.demo_ui.outputs import StackOutputs
from fleet_agent.demo_ui.runner import CommandResult

Answer = Callable[[list[str]], CommandResult]


def ok(stdout: str = "") -> CommandResult:
    """Builds a successful answer.

    Args:
        stdout: The standard output.

    Returns:
        A result with return code 0.
    """
    return CommandResult(returncode=0, stdout=stdout, stderr="", timed_out=False)


def fail(stderr: str = "", returncode: int = 1) -> CommandResult:
    """Builds a failed answer.

    Args:
        stderr: The standard error.
        returncode: The return code, not zero.

    Returns:
        A failed result.
    """
    return CommandResult(returncode=returncode, stdout="", stderr=stderr, timed_out=False)


@dataclass
class FakeRunner:
    """Answers every command from a function, and records the arguments and the time limits."""

    answer: Answer = field(default=lambda argv: ok())
    calls: list[list[str]] = field(default_factory=list)
    timeouts: list[float] = field(default_factory=list)
    envs: list[Mapping[str, str] | None] = field(default_factory=list)

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout_s: float,
        env: Mapping[str, str] | None = None,
    ) -> CommandResult:
        """Records the call and returns the scripted answer.

        Args:
            argv: The command.
            timeout_s: Its time limit.
            env: The environment of the command, recorded for the tests that check it.

        Returns:
            The answer of the test.
        """
        command = list(argv)
        self.calls.append(command)
        self.timeouts.append(timeout_s)
        self.envs.append(env)
        return self.answer(command)


@dataclass
class FakeSpawner:
    """Records the spawned processes. `on_spawn` runs inside the spawn, to act like a simulator."""

    on_spawn: Callable[[], None] | None = None
    raises: OSError | None = None
    # Answers of `alive`, in order; once they run out, the process is alive.
    alive_answers: list[bool] = field(default_factory=list)
    calls: list[tuple[list[str], Mapping[str, str], Path]] = field(default_factory=list)

    def alive(self, pid: int) -> bool:
        """Answers whether a spawned process still runs.

        Args:
            pid: The process identifier, unused by the fake.

        Returns:
            The next scripted answer, or True.
        """
        return self.alive_answers.pop(0) if self.alive_answers else True

    def spawn(self, argv: Sequence[str], env: Mapping[str, str], log_path: Path) -> int:
        """Records the spawn and runs the test's hook.

        Args:
            argv: The command.
            env: The environment of the process.
            log_path: The log file.

        Returns:
            A fixed process identifier.

        Raises:
            OSError: When the test asks for a failing spawn.
        """
        self.calls.append((list(argv), dict(env), log_path))
        if self.raises is not None:
            raise self.raises
        if self.on_spawn is not None:
            self.on_spawn()
        return 4242


@dataclass
class FakeClock:
    """A clock that moves only when the code sleeps. Sleeping costs no real time."""

    current: float = 1_000_000.0
    sleeps: list[float] = field(default_factory=list)

    def now(self) -> float:
        """Returns the fake time.

        Returns:
            Seconds since the epoch, as set by the test and by the sleeps.
        """
        return self.current

    def sleep(self, seconds: float) -> None:
        """Advances the fake time.

        Args:
            seconds: The time to advance.
        """
        self.sleeps.append(seconds)
        self.current += seconds


@dataclass(frozen=True)
class FixedOutputs:
    """Stack outputs that never fail, for tests that do not exercise Terraform."""

    value: StackOutputs

    def get(self) -> StackOutputs:
        """Returns the outputs.

        Returns:
            The fixed outputs.
        """
        return self.value


STACK = StackOutputs(
    console_origin="https://d111aaa.cloudfront.net",
    user_pool_id="eu-west-3_AbC123",
    region="eu-west-3",
    fleet_table_name="mfc-demo-fleet",
)
"""The stack outputs of the test demo. The values follow the grammars of `outputs.py`."""


"""The `terraform output -json` document of the test demo, as one line."""
TERRAFORM_OUTPUT_JSON = (
    '{"console_origin": {"value": "https://d111aaa.cloudfront.net", "type": "string"},'
    ' "user_pool_id": {"value": "eu-west-3_AbC123", "type": "string"},'
    ' "region": {"value": "eu-west-3", "type": "string"},'
    ' "fleet_table_name": {"value": "mfc-demo-fleet", "type": "string"},'
    ' "iot_rule_names": {"value": ["a"], "type": "list"}}'
)


@contextmanager
def held_lock(path: Path) -> Iterator[None]:
    """Holds the simulator lock as a running simulator does, for the duration of the block.

    Args:
        path: The lock file.

    Yields:
        Nothing; the lock is held while the block runs.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


class LockHolder:
    """Takes the simulator lock and keeps it until released. Used as the spawner's hook."""

    def __init__(self, path: Path) -> None:
        """Creates the holder.

        Args:
            path: The lock file.
        """
        self._path = path
        self._fd: int | None = None

    def acquire(self) -> None:
        """Takes the lock. A second acquire without a release is a test error."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self._fd = fd

    def release(self) -> None:
        """Releases the lock if it is held."""
        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            os.close(self._fd)
            self._fd = None
