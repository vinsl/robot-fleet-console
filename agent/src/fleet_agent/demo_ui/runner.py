"""Runs the external commands of the demo page: the aws CLI, terraform and the scripts.

Every command is an argument list, never a shell string, and runs with a minimal environment: the
page passes on the variables a command needs, not the whole environment of the operator's shell.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

MAX_STDERR_CHARS: Final = 2048
"""Longest stderr text a result carries. Longer output is cut: it can hold account details."""

_EXACT_ENV_NAMES: Final[frozenset[str]] = frozenset(
    {"PATH", "HOME", "LANG", "LC_ALL", "USER", "LOGNAME"}
)
_ENV_PREFIXES: Final[tuple[str, ...]] = ("AWS_", "XDG_", "UV_")


@dataclass(frozen=True)
class CommandResult:
    """Outcome of one command. A timed-out command has return code -1 and no output."""

    returncode: int
    stdout: str
    stderr: str
    timed_out: bool


class CommandRunner(Protocol):
    """Runs one command and returns its outcome: the subprocess runner or a test fake."""

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout_s: float,
        env: Mapping[str, str] | None = None,
    ) -> CommandResult:
        """Runs a command.

        Args:
            argv: The program and its arguments. Never a shell string.
            timeout_s: The longest time the command may run, in seconds.
            env: The environment of the command. Defaults to the minimal environment.

        Returns:
            The outcome of the command.
        """
        ...


class Spawner(Protocol):
    """Starts a long-running process that outlives the request that started it."""

    def spawn(self, argv: Sequence[str], env: Mapping[str, str], log_path: Path) -> int:
        """Starts a process and returns its identifier without waiting for it.

        Args:
            argv: The program and its arguments.
            env: The complete environment of the process.
            log_path: The file that receives the standard output and error of the process.

        Returns:
            The process identifier.
        """
        ...

    def alive(self, pid: int) -> bool:
        """Tells whether a process started by `spawn` is still running.

        Args:
            pid: The process identifier returned by `spawn`.

        Returns:
            True while the process runs; False once it exited, zombie included.
        """
        ...


def minimal_env(
    source: Mapping[str, str] | None = None,
    extra: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Builds the environment of a child command.

    Args:
        source: The environment to copy from. Defaults to the process environment.
        extra: Variables to add or override, such as the simulator's settings.

    Returns:
        The variables the command needs: the path, the home directory, the locale, the AWS and
        XDG settings, and the uv settings. Everything else is left out.
    """
    origin = os.environ if source is None else source
    env = {
        name: value
        for name, value in origin.items()
        if name in _EXACT_ENV_NAMES or name.startswith(_ENV_PREFIXES)
    }
    if extra is not None:
        env.update(extra)
    return env


def _truncate(text: str) -> str:
    """Cuts a stderr text to the longest length a result may carry."""
    return text[:MAX_STDERR_CHARS]


class SubprocessRunner:
    """Runs commands with `subprocess`, as argument lists, without a shell."""

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout_s: float,
        env: Mapping[str, str] | None = None,
    ) -> CommandResult:
        """Runs a command and waits for it, up to the timeout.

        Args:
            argv: The program and its arguments. A string is refused: it would be split into
            characters.
            timeout_s: The longest time the command may run, in seconds.
            env: The environment. Defaults to the minimal environment.

        Returns:
            The outcome. A missing program gives return code 127; a timeout gives `timed_out`.

        Raises:
            TypeError: When `argv` is a string or empty.
        """
        if isinstance(argv, str) or len(argv) == 0:
            raise TypeError("argv must be a non-empty sequence of arguments, never a shell string")
        command = list(argv)
        child_env = minimal_env() if env is None else dict(env)
        try:
            # The argument list is built only from constants and from values checked by the caller
            # (site identifiers, simulator counts), and shell=False keeps any value from being
            # parsed.
            completed = subprocess.run(  # noqa: S603
                command,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=timeout_s,
                env=child_env,
                shell=False,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return CommandResult(returncode=-1, stdout="", stderr="", timed_out=True)
        except FileNotFoundError:
            return CommandResult(
                returncode=127, stdout="", stderr="command not found", timed_out=False
            )
        except PermissionError:
            return CommandResult(
                returncode=126, stdout="", stderr="command not executable", timed_out=False
            )
        return CommandResult(
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=_truncate(completed.stderr),
            timed_out=False,
        )


class SubprocessSpawner:
    """Starts processes in their own session, with their output in a private log file.

    The process is not killed when the page stops: a simulator keeps its own two-hour limit and is
    stopped through the repository's stop script, as with `make demo-stop`.
    """

    def __init__(self) -> None:
        """Creates the spawner with no child process yet."""
        self._children: list[subprocess.Popen[bytes]] = []

    def spawn(self, argv: Sequence[str], env: Mapping[str, str], log_path: Path) -> int:
        """Starts a process in its own session, appending its output to a mode-600 log file.

        Args:
            argv: The program and its arguments. A string is refused.
            env: The complete environment of the process.
            log_path: The log file. Created with mode 600 when absent.

        Returns:
            The process identifier.

        Raises:
            TypeError: When `argv` is a string or empty.
            OSError: When the log file or the program cannot be opened.
        """
        if isinstance(argv, str) or len(argv) == 0:
            raise TypeError("argv must be a non-empty sequence of arguments, never a shell string")
        self._reap()
        # The directory is private too: the log holds the simulator's output, which names
        # robots and sites.
        log_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_CLOEXEC", 0)
        fd = os.open(log_path, flags, 0o600)
        try:
            os.fchmod(fd, 0o600)
            # Same reasoning as in SubprocessRunner.run: the list is built from checked values only.
            child = subprocess.Popen(  # noqa: S603
                list(argv),
                stdin=subprocess.DEVNULL,
                stdout=fd,
                stderr=subprocess.STDOUT,
                env=dict(env),
                shell=False,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            os.close(fd)
        self._children.append(child)
        return child.pid

    def alive(self, pid: int) -> bool:
        """Tells whether a process still runs, reading its state from `/proc`.

        Args:
            pid: The process identifier.

        Returns:
            False when the process is gone or a zombie that has exited.
        """
        try:
            stat_text = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
        except OSError:
            return False
        # The command name sits in parentheses and may hold spaces: the state follows the last one.
        state = stat_text.rsplit(")", 1)[-1].split()[0]
        return state not in ("Z", "X")

    def _reap(self) -> None:
        """Forgets the children that have exited, so that their status is collected."""
        self._children = [child for child in self._children if child.poll() is None]
