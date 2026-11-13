"""Tests of the secure file primitives: modes, owners, symlinks, file types and sizes."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from fleet_agent.config.files import InsecureFileError, check_private_dir, read_checked_file

_KIT_FORBIDDEN_BITS = 0o177
_MAX_BYTES = 64


def _file(path: Path, mode: int, content: bytes = b"payload") -> Path:
    """Writes a file and sets its mode, bypassing the umask.

    Args:
        path: Where to write the file.
        mode: The permission bits to set.
        content: The bytes to write.

    Returns:
        The path of the file.
    """
    path.write_bytes(content)
    path.chmod(mode)
    return path


def _read(path: Path) -> bytes:
    """Reads a file with the kit's forbidden bits and the test size limit.

    Args:
        path: The file to read.

    Returns:
        The content of the file.
    """
    return read_checked_file(path, forbidden_bits=_KIT_FORBIDDEN_BITS, max_bytes=_MAX_BYTES)


@pytest.mark.parametrize("mode", [0o600, 0o400])
def test_accepts_owner_only_modes(tmp_path: Path, mode: int) -> None:
    """A file readable and writable, or only readable, by its owner is read in full."""
    path = _file(tmp_path / "kit.json", mode, b"abc")

    assert _read(path) == b"abc"


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o660, 0o700])
def test_refuses_wider_modes(tmp_path: Path, mode: int) -> None:
    """Any group or other bit, or an execute bit, makes the file a refusal with code MODE."""
    path = _file(tmp_path / "kit.json", mode)

    with pytest.raises(InsecureFileError) as caught:
        _read(path)

    assert caught.value.code == "MODE"


def test_refuses_a_symlink(tmp_path: Path) -> None:
    """A symlink is refused with SYMLINK, even when its target is private."""
    target = _file(tmp_path / "target.json", 0o600)
    link = tmp_path / "kit.json"
    link.symlink_to(target)

    with pytest.raises(InsecureFileError) as caught:
        _read(link)

    assert caught.value.code == "SYMLINK"


def test_refuses_a_missing_file(tmp_path: Path) -> None:
    """An absent file is refused with MISSING."""
    with pytest.raises(InsecureFileError) as caught:
        _read(tmp_path / "absent.json")

    assert caught.value.code == "MISSING"


def test_refuses_a_fifo_without_blocking(tmp_path: Path) -> None:
    """A FIFO is refused with NOT_REGULAR and the open does not wait for a writer."""
    fifo = tmp_path / "kit.json"
    os.mkfifo(fifo, 0o600)

    with pytest.raises(InsecureFileError) as caught:
        _read(fifo)

    assert caught.value.code == "NOT_REGULAR"


def test_refuses_a_directory_given_as_a_file(tmp_path: Path) -> None:
    """A directory is refused with NOT_REGULAR when it is read as a file."""
    with pytest.raises(InsecureFileError) as caught:
        _read(tmp_path)

    assert caught.value.code == "NOT_REGULAR"


def test_refuses_a_file_owned_by_another_user(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A file whose owner is not the running user is refused with OWNER."""
    path = _file(tmp_path / "kit.json", 0o600)
    other_uid = os.getuid() + 1
    monkeypatch.setattr(os, "getuid", lambda: other_uid)

    with pytest.raises(InsecureFileError) as caught:
        _read(path)

    assert caught.value.code == "OWNER"


def test_refuses_an_oversize_file(tmp_path: Path) -> None:
    """A file one byte over the limit is refused with TOO_LARGE, and a file at the limit passes."""
    at_limit = _file(tmp_path / "at.json", 0o600, b"x" * _MAX_BYTES)
    over_limit = _file(tmp_path / "over.json", 0o600, b"x" * (_MAX_BYTES + 1))

    assert len(_read(at_limit)) == _MAX_BYTES
    with pytest.raises(InsecureFileError) as caught:
        _read(over_limit)

    assert caught.value.code == "TOO_LARGE"


def test_a_file_that_keeps_growing_is_still_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A read that never reaches end of file stops at the limit and is refused as TOO_LARGE."""
    path = _file(tmp_path / "kit.json", 0o600, b"x")
    monkeypatch.setattr(os, "read", lambda _fd, size: b"x" * size)

    with pytest.raises(InsecureFileError) as caught:
        _read(path)

    assert caught.value.code == "TOO_LARGE"


def test_accepts_a_private_directory(tmp_path: Path) -> None:
    """A directory with no group or other bit, owned by the user, passes the check."""
    private = tmp_path / "robot"
    private.mkdir(mode=0o700)
    private.chmod(0o700)

    check_private_dir(private)


def test_refuses_a_directory_open_to_its_group(tmp_path: Path) -> None:
    """A directory with a group bit is refused with MODE."""
    shared = tmp_path / "shared"
    shared.mkdir()
    shared.chmod(0o750)

    with pytest.raises(InsecureFileError) as caught:
        check_private_dir(shared)

    assert caught.value.code == "MODE"


def test_refuses_a_symlinked_directory(tmp_path: Path) -> None:
    """A symlink standing for a directory is refused with SYMLINK, not followed."""
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    with pytest.raises(InsecureFileError) as caught:
        check_private_dir(link)

    assert caught.value.code == "SYMLINK"


def test_refuses_a_directory_owned_by_another_user(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A directory owned by another user is refused with OWNER."""
    private = tmp_path / "robot"
    private.mkdir(mode=0o700)
    other_uid = os.getuid() + 1
    monkeypatch.setattr(os, "getuid", lambda: other_uid)

    with pytest.raises(InsecureFileError) as caught:
        check_private_dir(private)

    assert caught.value.code == "OWNER"


def test_refuses_a_file_where_a_directory_belongs(tmp_path: Path) -> None:
    """A regular file in the place of a directory is refused with NOT_DIR."""
    path = _file(tmp_path / "robot", 0o600)

    with pytest.raises(InsecureFileError) as caught:
        check_private_dir(path)

    assert caught.value.code == "NOT_DIR"


def test_refuses_a_missing_directory(tmp_path: Path) -> None:
    """An absent directory is refused with MISSING."""
    with pytest.raises(InsecureFileError) as caught:
        check_private_dir(tmp_path / "absent")

    assert caught.value.code == "MISSING"


def test_a_file_that_cannot_be_opened_is_unreadable(tmp_path: Path) -> None:
    """A file the process may not open is refused with UNREADABLE, not with a raw error."""
    path = _file(tmp_path / "kit.json", 0o000)

    with pytest.raises(InsecureFileError) as caught:
        _read(path)

    assert caught.value.code == "UNREADABLE"


def test_a_failed_stat_of_a_directory_is_unreadable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A directory whose status cannot be read is refused with UNREADABLE."""

    def denied(_self: Path) -> os.stat_result:
        """Simulates a status read that the operating system refuses.

        Args:
            _self: The path, ignored.

        Raises:
            PermissionError: Always.
        """
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "lstat", denied)

    with pytest.raises(InsecureFileError) as caught:
        check_private_dir(tmp_path)

    assert caught.value.code == "UNREADABLE"


def test_a_failed_status_read_of_the_descriptor_is_unreadable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A file whose status cannot be read through its descriptor is refused as UNREADABLE."""
    path = _file(tmp_path / "kit.json", 0o600)

    def denied(_fd: int) -> os.stat_result:
        """Simulates a descriptor status read that fails.

        Args:
            _fd: The descriptor, ignored.

        Raises:
            OSError: Always.
        """
        raise OSError("status refused")

    monkeypatch.setattr(os, "fstat", denied)

    with pytest.raises(InsecureFileError) as caught:
        _read(path)

    assert caught.value.code == "UNREADABLE"


def test_a_failed_read_of_the_content_is_unreadable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A read that fails part way is refused as UNREADABLE, and the descriptor is still closed."""
    path = _file(tmp_path / "kit.json", 0o600)

    def denied(_fd: int, _size: int) -> bytes:
        """Simulates a read that the device refuses.

        Args:
            _fd: The descriptor, ignored.
            _size: The requested size, ignored.

        Raises:
            OSError: Always.
        """
        raise OSError("read refused")

    monkeypatch.setattr(os, "read", denied)

    with pytest.raises(InsecureFileError) as caught:
        _read(path)

    assert caught.value.code == "UNREADABLE"
