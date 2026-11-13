"""Tests of the simulated robot identifiers and of the single-instance lock."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from fleet_agent.sim import lock as lock_module
from fleet_agent.sim.ids import MAX_SIM_ROBOTS, sim_robot_ids
from fleet_agent.sim.lock import InstanceLock, SimLockedError, default_lock_path


@pytest.mark.parametrize(
    ("prefix", "count", "expected"),
    [
        ("sim", 1, ["sim-01"]),
        ("sim", 3, ["sim-01", "sim-02", "sim-03"]),
        ("lab-robot", 2, ["lab-robot-01", "lab-robot-02"]),
        ("sim", MAX_SIM_ROBOTS, [f"sim-{n:02d}" for n in range(1, 21)]),
    ],
)
def test_identifiers_are_numbered_from_one_with_the_prefix(
    prefix: str, count: int, expected: list[str]
) -> None:
    """Given a prefix and a count, when listed, then the identifiers are numbered from one."""
    assert sim_robot_ids(prefix, count) == expected


@pytest.mark.parametrize("count", [0, 21, -1])
def test_a_count_outside_one_to_twenty_is_refused(count: int) -> None:
    """Given a count outside the demo's range, when listed, then it is refused."""
    with pytest.raises(ValueError, match="1 to 20"):
        sim_robot_ids("sim", count)


@pytest.mark.parametrize("prefix", ["", "ab", "Sim", "sim_x", "x" * 33, "sim/../x"])
def test_a_prefix_outside_the_identifier_grammar_is_refused(prefix: str) -> None:
    """Given a prefix that breaks the identifier grammar, when listed, then it is refused."""
    with pytest.raises(ValueError, match="prefix"):
        sim_robot_ids(prefix, 1)


def test_the_default_lock_path_follows_the_xdg_state_home() -> None:
    """Given an XDG state home, when the lock path is asked, then it lies under it."""
    path = default_lock_path({"XDG_STATE_HOME": "/srv/state"})

    assert path == Path("/srv/state/fleet/sim.lock")


def test_the_default_lock_path_falls_back_to_the_local_state_directory() -> None:
    """Given no XDG state home, when the lock path is asked,
    then it lies under the user's local state."""
    path = default_lock_path({})

    assert path == Path.home() / ".local" / "state" / "fleet" / "sim.lock"


def test_the_lock_records_the_process_identifier_and_is_released_on_exit(tmp_path: Path) -> None:
    """Given a free lock, when taken,
    then the file holds this process's identifier and a second take is refused."""
    path = tmp_path / "state" / "fleet" / "sim.lock"

    with InstanceLock(path):
        assert path.read_text(encoding="ascii").strip() == str(os.getpid())
        with pytest.raises(SimLockedError), InstanceLock(path):
            pass

    with InstanceLock(path):
        pass


def test_the_lock_directory_and_file_are_owner_only(tmp_path: Path) -> None:
    """Given a state directory with wider permissions, when the lock is taken,
    then both are owner-only."""
    directory = tmp_path / "fleet"
    directory.mkdir(mode=0o755)
    directory.chmod(0o755)

    with InstanceLock(directory / "sim.lock"):
        assert stat.S_IMODE((directory).stat().st_mode) == 0o700
        assert stat.S_IMODE((directory / "sim.lock").stat().st_mode) == 0o600


def test_a_state_directory_owned_by_another_user_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Given a state directory whose owner is another user, when the lock is taken,
    then it is refused."""
    other_user = os.getuid() + 1
    monkeypatch.setattr(lock_module.os, "getuid", lambda: other_user)

    with pytest.raises(PermissionError), InstanceLock(tmp_path / "sim.lock"):
        pass


def test_a_lock_file_that_is_a_symbolic_link_is_refused(tmp_path: Path) -> None:
    """Given a lock path that is a symbolic link, when the lock is taken,
    then the link is not followed."""
    target = tmp_path / "elsewhere"
    target.write_text("", encoding="ascii")
    path = tmp_path / "sim.lock"
    path.symlink_to(target)

    with pytest.raises(OSError, match="symbolic links"), InstanceLock(path):
        pass
    assert target.read_text(encoding="ascii") == ""
