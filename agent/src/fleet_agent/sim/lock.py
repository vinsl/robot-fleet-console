"""The single-instance lock of the simulator, on the state directory of the user.

Two simulators on one host would connect the same client identifiers, and the broker would drop
both in turn. A `flock` on a file in the user's state directory makes the second one refuse at
once, before it connects anything. The file holds the process identifier, which `sim-stop.sh`
reads. The kernel releases the lock when the process exits, however it exits.
"""

from __future__ import annotations

import fcntl
import os
from pathlib import Path
from types import TracebackType
from typing import Final

LOCK_FILE_NAME: Final = "sim.lock"
"""The name of the lock file inside the simulator's state directory."""

_DIRECTORY_MODE: Final = 0o700
_FILE_MODE: Final = 0o600


class SimLockedError(Exception):
    """Another simulator holds the lock on this host."""


def default_lock_path(environ: dict[str, str] | None = None) -> Path:
    """Returns the lock file of the current user, under the XDG state directory.

    Args:
        environ: The environment. Defaults to the process environment.

    Returns:
        `$XDG_STATE_HOME/fleet/sim.lock`, or `~/.local/state/fleet/sim.lock` when that is unset.
    """
    env = os.environ if environ is None else environ
    base = env.get("XDG_STATE_HOME") or ""
    state_home = Path(base) if base else Path.home() / ".local" / "state"
    return state_home / "fleet" / LOCK_FILE_NAME


class InstanceLock:
    """Holds the simulator's lock for the duration of a `with` block.

    It refuses a lock file that is a symbolic link, and a state directory that another user owns or
    that other users can read or write.
    """

    def __init__(self, path: Path) -> None:
        """Creates the lock, without taking it.

        Args:
            path: The lock file.
        """
        self._path = path
        self._fd: int | None = None

    def __enter__(self) -> InstanceLock:
        """Takes the lock without waiting, and records the process identifier in the file.

        Returns:
            The lock, held.

        Raises:
            SimLockedError: When another process holds the lock.
            PermissionError: When the state directory belongs to another user or is shared.
        """
        directory = self._path.parent
        directory.mkdir(parents=True, mode=_DIRECTORY_MODE, exist_ok=True)
        info = directory.stat()
        if info.st_uid != os.getuid():
            raise PermissionError("the simulator state directory belongs to another user")
        if info.st_mode & 0o077:
            directory.chmod(_DIRECTORY_MODE)
        fd = os.open(self._path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), _FILE_MODE)
        try:
            os.fchmod(fd, _FILE_MODE)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise SimLockedError from None
        except BaseException:
            os.close(fd)
            raise
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode("ascii"))
        self._fd = fd
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Releases the lock and closes the file. Never suppresses an exception.

        Args:
            exc_type: The exception class of the block, if any. Unused.
            exc: The exception of the block, if any. Unused.
            traceback: The traceback of the block, if any. Unused.
        """
        del exc_type, exc, traceback
        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            os.close(self._fd)
            self._fd = None
