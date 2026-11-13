"""The e-stop latch on disk: a small file that makes an emergency stop survive a reboot.

The latch is written atomically: the content goes to a temporary file with mode 0600, is flushed,
then renamed over the latch, and the directory is flushed so the rename is durable. A temporary
file left by an interrupted write is promoted at the next boot, so an interrupted latch still
counts as set. Every operating-system error is turned into the port's error, so the core never
sees a raw `OSError`.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
from typing import Final

from fleet_agent.config.files import InsecureFileError, read_checked_file
from fleet_agent.core.ports import LatchRecord, LatchUnreadableError, LatchWriteError

LATCH_FILE_NAME: Final = "estop.latch"
"""Name of the latch inside the robot's kit directory."""

LATCH_TMP_NAME: Final = "estop.latch.tmp"
"""Name of the temporary file the latch is written through."""

MAX_LATCH_BYTES: Final = 1024
"""Largest latch accepted. A record of three short fields is far below this."""

_LATCH_FORBIDDEN_BITS: Final = 0o077
"""Permission bits a latch must not carry: every group and other bit. Mode 0600 passes."""

_LATCH_MODE: Final = 0o600
"""Mode of the latch file: readable and writable by its owner only."""


class FileLatchStore:
    """Stores the e-stop latch as one file in the robot's kit directory.

    The store checks the file's owner and mode on every read, refuses a symlink, and never parses
    the content to decide whether the latch is set, so a damaged file still counts as set.
    """

    def __init__(self, kit_dir: Path) -> None:
        """Creates a store that keeps its files in the given directory.

        Args:
            kit_dir: The robot's kit directory. It must already be private (see `load_kit`).
        """
        self._kit_dir = kit_dir
        self._latch = kit_dir / LATCH_FILE_NAME
        self._tmp = kit_dir / LATCH_TMP_NAME

    def is_set(self) -> bool:
        """Tells whether the latch is set, promoting an interrupted write first.

        A temporary file means a write was interrupted after it started, so it is promoted to the
        latch and the robot boots stopped.

        Returns:
            True when the latch or a promotable temporary file exists, else False.

        Raises:
            LatchUnreadableError: If a file exists but cannot be checked or promoted. The caller
                must not guess the state.
        """
        try:
            if _is_present(self._tmp):
                self._tmp.replace(self._latch)
                _fsync_directory(self._kit_dir)
                return True
            return _is_present(self._latch)
        except OSError as err:
            raise LatchUnreadableError("the e-stop latch cannot be read") from err

    def set(self, record: LatchRecord) -> None:
        """Durably writes the latch: temporary file, flush, rename, then flush the directory.

        Args:
            record: The content to store.

        Raises:
            LatchWriteError: If any step fails. A temporary file left behind is promoted at the
                next boot, so a failed write may still latch then.
        """
        body = json.dumps(
            {
                "commandId": record.command_id,
                "bootId": record.boot_id,
                "latchedAt": record.latched_at,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        try:
            _write_flushed(self._tmp, body)
            self._tmp.replace(self._latch)
            _fsync_directory(self._kit_dir)
        except OSError as err:
            raise LatchWriteError("the e-stop latch cannot be written") from err

    def clear(self) -> None:
        """Removes the latch and any temporary file, then flushes the directory.

        Removing a file that is already absent is not an error, so clearing twice is safe.

        Raises:
            LatchWriteError: If a file cannot be removed or the directory cannot be flushed.
        """
        try:
            for path in (self._latch, self._tmp):
                with contextlib.suppress(FileNotFoundError):
                    path.unlink()
            _fsync_directory(self._kit_dir)
        except OSError as err:
            raise LatchWriteError("the e-stop latch cannot be cleared") from err


def _is_present(path: Path) -> bool:
    """Tells whether a latch-shaped file exists, after checking that it is owner-only.

    Args:
        path: The latch or the temporary file.

    Returns:
        True when the file exists and passes the checks, False when it is absent.

    Raises:
        LatchUnreadableError: If the file exists and fails a check.
    """
    try:
        read_checked_file(path, forbidden_bits=_LATCH_FORBIDDEN_BITS, max_bytes=MAX_LATCH_BYTES)
    except InsecureFileError as err:
        if err.code == "MISSING":
            return False
        raise LatchUnreadableError("the e-stop latch cannot be read") from None
    return True


def _write_flushed(path: Path, body: bytes) -> None:
    """Writes a file with the latch mode and flushes its content to disk.

    The file is opened without following a symlink, and its mode is set on the open descriptor
    so that no other user can read it between the creation and the chmod.

    Args:
        path: The temporary file to write.
        body: The content to write.

    Raises:
        OSError: If the file cannot be opened, written or flushed.
    """
    fd = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC,
        _LATCH_MODE,
    )
    try:
        os.fchmod(fd, _LATCH_MODE)
        remaining = memoryview(body)
        while remaining:
            written = os.write(fd, remaining)
            remaining = remaining[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_directory(path: Path) -> None:
    """Flushes a directory, so that renames and removals inside it survive a power cut.

    Args:
        path: The directory to flush.

    Raises:
        OSError: If the directory cannot be opened or flushed.
    """
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
