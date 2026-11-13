"""Robot and cloud state machine: the rules the design states, and the refusals of an incomplete
call."""

from __future__ import annotations

import pytest

from fleet_agent.core.state_machine import TRANSITIONS, transition, transition_cloud

NONE: frozenset[str] = frozenset()


def test_blocked_resume_with_a_pending_cause_is_refused_with_invalid_state() -> None:
    """The cause is still present, so RESUME is refused and the robot stays blocked."""
    result = transition("BLOCKED", "RESUME", ["CAUSE_PENDING"])
    assert (result.to, result.reply, result.reason, result.changed) == (
        "BLOCKED",
        "REJECT",
        "INVALID_STATE",
        False,
    )


def test_deadman_expiry_pauses_a_teleoperated_robot_and_stores_teleop_as_the_target() -> None:
    """The effect asks the model to remember TELEOP, so a later RESUME returns to teleoperation."""
    result = transition("TELEOP", "DEADMAN_EXPIRED", NONE)
    assert result.to == "PAUSED"
    assert "RESUME_TARGET_FROM" in result.effects


def test_resume_needs_the_stored_target_and_uses_it() -> None:
    """RESUME without a target is a caller error; with one, the robot goes to that target."""
    with pytest.raises(TypeError):
        transition("PAUSED", "RESUME", NONE)
    assert transition("PAUSED", "RESUME", NONE, "TELEOP").to == "TELEOP"


def test_a_boot_without_a_latch_guard_is_refused() -> None:
    """The boot cannot choose between ESTOP and IDLE without knowing the latch."""
    with pytest.raises(TypeError):
        transition("START", "BOOT", NONE)


def test_a_command_with_no_row_is_refused_and_an_internal_trigger_is_ignored() -> None:
    """A missing command pair is refused; a missing internal pair changes nothing and is not
    answered."""
    refused = transition("IDLE", "RESUME", NONE)
    ignored = transition("IDLE", "CHARGED", NONE)
    assert (refused.reply, refused.reason) == ("REJECT", "INVALID_STATE")
    assert (ignored.reply, ignored.changed) == ("NONE", False)


def test_a_disconnect_marks_the_robot_offline_and_a_report_brings_it_back() -> None:
    """The cloud view follows the disconnect, then the first report after it."""
    gone = transition_cloud("MOVING", "CLOUD_SILENCE_15S")
    back = transition_cloud(gone.to, "ROBOT_REPORTED", "PAUSED")
    assert (gone.to, gone.changed) == ("OFFLINE", True)
    assert (back.to, back.changed) == ("PAUSED", True)


def test_a_report_needs_the_reported_state() -> None:
    """ROBOT_REPORTED from OFFLINE cannot be resolved without the state the robot reported."""
    with pytest.raises(TypeError):
        transition_cloud("OFFLINE", "ROBOT_REPORTED")


def test_two_rival_rows_refuse_a_command_instead_of_guessing() -> None:
    """Two conditional rows match a command: it is refused with INVALID_STATE, with no change."""
    result = transition("MOVING", "RETURN_TO_BASE", ["DEST_STATION", "DEST_CHARGER"])
    assert (result.to, result.reply, result.reason, result.changed) == (
        "MOVING",
        "REJECT",
        "INVALID_STATE",
        False,
    )


def test_two_rival_rows_raise_for_an_internal_trigger() -> None:
    """An internal trigger has no safe answer when two rows match, so it raises."""
    with pytest.raises(TypeError):
        transition("WORKING", "WORK_DONE", ["CHARGE_REQUESTED", "MISSION_REMAINING"])


def test_an_offline_robot_cannot_act() -> None:
    """The cloud holds the robot OFFLINE, so no robot trigger may be applied to it."""
    with pytest.raises(TypeError):
        transition("OFFLINE", "HEARTBEAT", NONE)


def test_estop_is_never_a_resume_target() -> None:
    """A robot must never resume into an emergency stop; the caller gets a TypeError."""
    with pytest.raises(TypeError):
        transition("PAUSED", "RESUME", NONE, "ESTOP")


def test_a_boot_takes_no_trigger_but_boot() -> None:
    """START has rows only for BOOT; any other trigger from START has no row and raises."""
    with pytest.raises(TypeError):
        transition("START", "CHARGED", ["LATCH_SET"])


def test_every_boot_row_targets_a_reported_state() -> None:
    """A boot row never names SAME or RESUME_TARGET, because START has no state to keep."""
    targets = {row.target for row in TRANSITIONS if row.origin == "START"}
    assert targets <= {"ESTOP", "IDLE"}


def test_an_unknown_cloud_trigger_is_refused_at_run_time() -> None:
    """A trigger that arrives from outside the code is checked, not trusted by its type."""
    with pytest.raises(TypeError, match="unknown cloud trigger"):
        transition_cloud("IDLE", "NOT_A_TRIGGER")  # type: ignore[arg-type]
