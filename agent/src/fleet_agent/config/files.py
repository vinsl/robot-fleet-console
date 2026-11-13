"""Secure file primitives: owner-only directories and files that refuse symlinks and wide modes.

The kit carries a private key and the settings file carries configuration that another local
user must not be able to swap or read. The file is opened with `O_NOFOLLOW` and its checks run on
the open descriptor (`fstat`), not on the path, so a path cannot be replaced by a symlink between
the check and the read.
"""

from __future__ import annotations

import errno
import os
import stat
from pathlib import Path
from typing import Final, Literal

FileErrorCode = Literal[
    "MISSING",
    "NOT_REGULAR",
    "NOT_DIR",
    "SYMLINK",
    "OWNER",
    "MODE",
    "TOO_LARGE",
    "UNREADABLE",
]
"""Why a file or directory was refused. Only this code reaches the caller, never a path."""

_GROUP_AND_OTHER_BITS: Final = 0o077
"""Permission bits of the group and of others. A directory must carry none of them."""

_READ_OPEN_FLAGS: Final = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
"""Flags of a checked read. `O_NONBLOCK` stops a FIFO from blocking the open; `fstat` then
refuses it as not regular."""


class InsecureFileError(Exception):
    """A file or directory failed a check. Its string form is the code alone.

    Attributes:
        code: The reason the check failed.
    """

    def __init__(self, code: FileErrorCode) -> None:
        """Creates the error.

        Args:
            code: The reason the check failed.
        """
        super().__init__(code)
        self.code = code


def check_private_dir(path: Path) -> None:
    """Checks that a directory is a real directory, owned by this user, and private to it.

    The check uses `lstat`, so a symlink is refused rather than followed.

    Args:
        path: The directory to check.

    Raises:
        InsecureFileError: With `MISSING`, `SYMLINK`, `NOT_DIR`, `OWNER`, `MODE` or `UNREADABLE`.
    """
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise InsecureFileError("MISSING") from None
    except OSError:
        raise InsecureFileError("UNREADABLE") from None
    if stat.S_ISLNK(info.st_mode):
        raise InsecureFileError("SYMLINK")
    if not stat.S_ISDIR(info.st_mode):
        raise InsecureFileError("NOT_DIR")
    if info.st_uid != os.getuid():
        raise InsecureFileError("OWNER")
    if stat.S_IMODE(info.st_mode) & _GROUP_AND_OTHER_BITS:
        raise InsecureFileError("MODE")


def read_checked_file(path: Path, *, forbidden_bits: int, max_bytes: int) -> bytes:
    """Reads a regular file owned by this user, whose permission bits avoid `forbidden_bits`.

    The file is opened without following a symlink. Every check runs on the open descriptor, and
    at most `max_bytes + 1` bytes are read, so an oversize file is refused without being loaded.

    Args:
        path: The file to read.
        forbidden_bits: Permission bits the file must not carry, such as `0o177` for a file with
            no execute bit and no group or other access.
        max_bytes: The largest size accepted, in bytes.

    Returns:
        The content of the file.

    Raises:
        InsecureFileError: With `MISSING`, `SYMLINK`, `UNREADABLE`, `NOT_REGULAR`, `OWNER`, `MODE`
            or `TOO_LARGE`.
    """
    try:
        fd = os.open(path, _READ_OPEN_FLAGS)
    except FileNotFoundError:
        raise InsecureFileError("MISSING") from None
    except OSError as err:
        if err.errno == errno.ELOOP:
            raise InsecureFileError("SYMLINK") from None
        raise InsecureFileError("UNREADABLE") from None
    try:
        return _read_descriptor(fd, forbidden_bits=forbidden_bits, max_bytes=max_bytes)
    finally:
        os.close(fd)


def _read_descriptor(fd: int, *, forbidden_bits: int, max_bytes: int) -> bytes:
    """Checks an open descriptor, then reads its content up to the size limit.

    Args:
        fd: The open descriptor. The caller closes it.
        forbidden_bits: Permission bits the file must not carry.
        max_bytes: The largest size accepted, in bytes.

    Returns:
        The content of the file.

    Raises:
        InsecureFileError: With `UNREADABLE`, `NOT_REGULAR`, `OWNER`, `MODE` or `TOO_LARGE`.
    """
    try:
        info = os.fstat(fd)
    except OSError:
        raise InsecureFileError("UNREADABLE") from None
    if not stat.S_ISREG(info.st_mode):
        raise InsecureFileError("NOT_REGULAR")
    if info.st_uid != os.getuid():
        raise InsecureFileError("OWNER")
    if stat.S_IMODE(info.st_mode) & forbidden_bits:
        raise InsecureFileError("MODE")
    if info.st_size > max_bytes:
        raise InsecureFileError("TOO_LARGE")
    limit = max_bytes + 1
    data = bytearray()
    try:
        while len(data) < limit:
            chunk = os.read(fd, limit - len(data))
            if not chunk:
                break
            data.extend(chunk)
    except OSError:
        raise InsecureFileError("UNREADABLE") from None
    if len(data) > max_bytes:
        raise InsecureFileError("TOO_LARGE")
    return bytes(data)
