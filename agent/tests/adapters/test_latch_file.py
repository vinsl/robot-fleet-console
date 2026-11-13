"""Tests of the file-backed e-stop latch: atomic writes, promotion, modes and error mapping."""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest

from fleet_agent.adapters.latch_file import LATCH_FILE_NAME, LATCH_TMP_NAME, FileLatchStore
from fleet_agent.core.ports import LatchRecord, LatchUnreadableError, LatchWriteError

_RECORD = LatchRecord(
    command_id="0190f2a4-7c1d-7e3a-9b4f-2d6e8a1c5f01",
    boot_id="0190f2a4-7c1d-7e3a-9b4f-2d6e8a1c5f02",
    latched_at="2026-11-02T10:00:00.000Z",
)


@pytest.fixture
def kit_dir(tmp_path: Path) -> Iterator[Path]:
    """Provides a private kit directory, made writable again after the test.

    Args:
        tmp_path: The per-test directory.

    Yields:
        The kit directory.
    """
    directory = tmp_path / "kali-01"
    directory.mkdir(mode=0o700)
    directory.chmod(0o700)
    yield directory
    directory.chmod(0o700)


def _mode(path: Path) -> int:
    """Returns the permission bits of a file.

    Args:
        path: The file.

    Returns:
        The permission bits, without the file type.
    """
    return stat.S_IMODE(path.stat().st_mode)


def test_set_writes_an_owner_only_latch_and_leaves_no_temporary_file(kit_dir: Path) -> None:
    """A set latch is a 0600 file holding the record, with no temporary file beside it."""
    store = FileLatchStore(kit_dir)

    store.set(_RECORD)

    latch = kit_dir / LATCH_FILE_NAME
    assert _mode(latch) == 0o600
    assert not (kit_dir / LATCH_TMP_NAME).exists()
    assert json.loads(latch.read_text(encoding="utf-8")) == {
        "commandId": _RECORD.command_id,
        "bootId": _RECORD.boot_id,
        "latchedAt": _RECORD.latched_at,
    }
    assert store.is_set()


def test_is_set_is_false_when_nothing_was_latched(kit_dir: Path) -> None:
    """A fresh kit directory has no latch."""
    assert not FileLatchStore(kit_dir).is_set()


def test_clear_removes_the_latch_and_is_idempotent(kit_dir: Path) -> None:
    """Clearing removes the latch, and clearing again is not an error."""
    store = FileLatchStore(kit_dir)
    store.set(_RECORD)

    store.clear()
    store.clear()

    assert not (kit_dir / LATCH_FILE_NAME).exists()
    assert not store.is_set()


def test_a_leftover_temporary_file_is_promoted_at_boot(kit_dir: Path) -> None:
    """An interrupted write leaves a temporary file, which counts as a latch and becomes one."""
    tmp = kit_dir / LATCH_TMP_NAME
    tmp.write_text("{}", encoding="utf-8")
    tmp.chmod(0o600)

    assert FileLatchStore(kit_dir).is_set()

    assert (kit_dir / LATCH_FILE_NAME).exists()
    assert not tmp.exists()


def test_the_latch_content_is_not_parsed_to_decide(kit_dir: Path) -> None:
    """A damaged latch still counts as set: the decision never depends on the content."""
    latch = kit_dir / LATCH_FILE_NAME
    latch.write_bytes(b"\x00 not json at all")
    latch.chmod(0o600)

    assert FileLatchStore(kit_dir).is_set()


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o604])
def test_refuses_a_latch_readable_by_others(kit_dir: Path, mode: int) -> None:
    """A latch with any group or other bit is unreadable for the port, so the boot is refused."""
    latch = kit_dir / LATCH_FILE_NAME
    latch.write_text("{}", encoding="utf-8")
    latch.chmod(mode)

    with pytest.raises(LatchUnreadableError):
        FileLatchStore(kit_dir).is_set()


def test_refuses_a_latch_that_is_a_symlink(kit_dir: Path, tmp_path: Path) -> None:
    """A symlink standing for the latch is not followed, and the read is refused."""
    target = tmp_path / "elsewhere"
    target.write_text("{}", encoding="utf-8")
    target.chmod(0o600)
    (kit_dir / LATCH_FILE_NAME).symlink_to(target)

    with pytest.raises(LatchUnreadableError):
        FileLatchStore(kit_dir).is_set()


def test_refuses_an_insecure_temporary_file_at_boot(kit_dir: Path) -> None:
    """A leftover temporary file that is not owner-only is not promoted and not trusted."""
    tmp = kit_dir / LATCH_TMP_NAME
    tmp.write_text("{}", encoding="utf-8")
    tmp.chmod(0o644)

    with pytest.raises(LatchUnreadableError):
        FileLatchStore(kit_dir).is_set()


def test_set_refuses_a_temporary_file_that_is_a_symlink(kit_dir: Path, tmp_path: Path) -> None:
    """A symlink planted at the temporary name is not written through: the set fails."""
    target = tmp_path / "victim"
    target.write_text("keep", encoding="utf-8")
    (kit_dir / LATCH_TMP_NAME).symlink_to(target)

    with pytest.raises(LatchWriteError):
        FileLatchStore(kit_dir).set(_RECORD)

    assert target.read_text(encoding="utf-8") == "keep"


def test_set_in_a_read_only_directory_raises_the_port_error(kit_dir: Path) -> None:
    """A directory the process cannot write to makes the set raise LatchWriteError."""
    kit_dir.chmod(0o500)

    with pytest.raises(LatchWriteError):
        FileLatchStore(kit_dir).set(_RECORD)


def test_set_maps_a_flush_failure_to_the_port_error(
    kit_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed flush is an operating-system error, and it reaches the core as LatchWriteError."""

    def failing_fsync(_fd: int) -> None:
        """Simulates a disk that refuses to flush.

        Args:
            _fd: The descriptor, ignored.

        Raises:
            OSError: Always.
        """
        raise OSError("disk refused the flush")

    monkeypatch.setattr(os, "fsync", failing_fsync)

    with pytest.raises(LatchWriteError) as caught:
        FileLatchStore(kit_dir).set(_RECORD)

    assert isinstance(caught.value.__cause__, OSError)


def test_clear_maps_a_removal_failure_to_the_port_error(kit_dir: Path) -> None:
    """A latch that cannot be removed, here a directory in its place, raises LatchWriteError."""
    (kit_dir / LATCH_FILE_NAME).mkdir()

    with pytest.raises(LatchWriteError):
        FileLatchStore(kit_dir).clear()


def test_is_set_maps_a_directory_in_place_of_the_latch(kit_dir: Path) -> None:
    """A directory named as the latch is not a file, so the read raises LatchUnreadableError."""
    (kit_dir / LATCH_FILE_NAME).mkdir()

    with pytest.raises(LatchUnreadableError):
        FileLatchStore(kit_dir).is_set()


def test_is_set_maps_a_failed_promotion_to_the_port_error(kit_dir: Path) -> None:
    """A temporary file that cannot be renamed in a read-only directory is LatchUnreadableError."""
    tmp = kit_dir / LATCH_TMP_NAME
    tmp.write_text("{}", encoding="utf-8")
    tmp.chmod(0o600)
    kit_dir.chmod(0o500)

    with pytest.raises(LatchUnreadableError):
        FileLatchStore(kit_dir).is_set()
