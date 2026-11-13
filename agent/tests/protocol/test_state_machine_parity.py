"""State machine parity: the Python table equals the generated JSON row for row, and the Python
`transition` agrees with a reference computed from the JSON alone over the whole input space.

The reference shares no code with the mirror. It reads the rows and the trigger lists from the
generated `state-machine.json`, so a trigger that exists on one side only is visible here.
"""

from __future__ import annotations

from itertools import combinations
from typing import Any

import pytest

from fleet_agent.core.state_machine import (
    CLOUD_TRANSITIONS,
    TRANSITIONS,
    TransitionRow,
    transition,
    transition_cloud,
)

from .conftest import read_generated

ALL_REPORTED = ["IDLE", "WORKING", "MOVING", "CHARGING", "BLOCKED", "PAUSED", "TELEOP", "ESTOP"]
ALL_GUARDS = [
    "CAUSE_CLEARED",
    "CAUSE_PENDING",
    "DEST_CHARGER",
    "DEST_STATION",
    "CHARGE_REQUESTED",
    "MISSION_REMAINING",
    "MISSION_COMPLETE",
    "LATCH_SET",
    "LATCH_NOT_SET",
    "ESTOP_FROM_IDLE",
    "ESTOP_FROM_OTHER",
]


def _document() -> dict[str, Any]:
    """Reads the generated state machine document.

    Returns:
        The decoded `state-machine.json`.
    """
    document = read_generated("state-machine.json")
    assert isinstance(document, dict)
    return document


def _json_rows() -> list[dict[str, Any]]:
    """Reads the generated robot rows.

    Returns:
        The rows of `state-machine.json`, as objects.
    """
    rows = _document()["rows"]
    assert isinstance(rows, list)
    return rows


def _row_dict(row: TransitionRow) -> dict[str, object]:
    """Renders a Python row in the JSON shape: `from` and `to` keys, `reason` only when present.

    Args:
        row: The row to render.

    Returns:
        The row as the generated JSON object.
    """
    data: dict[str, object] = {
        "from": row.origin,
        "trigger": row.trigger,
        "guard": row.guard,
        "to": row.target,
        "effects": list(row.effects),
        "reply": row.reply,
    }
    if row.reason is not None:
        data["reason"] = row.reason
    return data


def _sort_key(row: dict[str, object]) -> tuple[str, str, str]:
    """Orders rows the way the generator does: origin, trigger, guard.

    Args:
        row: A row in the JSON shape.

    Returns:
        The sort key.
    """
    return (str(row["from"]), str(row["trigger"]), str(row["guard"]))


def test_the_python_table_equals_the_generated_rows() -> None:
    """Same rows, same fields, same order after the generator's sort."""
    mirror = sorted((_row_dict(row) for row in TRANSITIONS), key=_sort_key)
    assert mirror == sorted(_json_rows(), key=_sort_key)


def test_the_python_cloud_table_equals_the_generated_rows() -> None:
    """The cloud rows match, including the REPORTED target."""
    generated = _document()["cloudRows"]
    mirror = [{"from": r.origin, "trigger": r.trigger, "to": r.target} for r in CLOUD_TRANSITIONS]

    def key(row: dict[str, Any]) -> tuple[str, str]:
        return (str(row["from"]), str(row["trigger"]))

    assert sorted(mirror, key=key) == sorted(generated, key=key)


def test_every_generated_row_appears_once() -> None:
    """A duplicated origin, trigger and guard would make the lookup order matter."""
    keys = [(str(r["from"]), str(r["trigger"]), str(r["guard"])) for r in _json_rows()]
    assert len(set(keys)) == len(keys)


def test_the_generated_trigger_lists_name_every_trigger_of_the_table() -> None:
    """The reference takes its trigger vocabulary from the JSON, which must cover every row."""
    triggers = _document()["triggers"]
    assert isinstance(triggers, dict)
    known = set(triggers["command"]) | set(triggers["internal"])
    assert {str(r["trigger"]) for r in _json_rows()} <= known


def _reference(
    rows: list[dict[str, Any]],
    command_triggers: set[str],
    origin: str,
    trigger: str,
    guards: set[str],
    resume_target: str | None,
) -> tuple[str, str, str | None, list[str], bool] | type[TypeError]:
    """Computes the transition from the JSON alone, with the fail-closed rules of the design.

    Args:
        rows: The generated robot rows.
        command_triggers: The command triggers, from the generated JSON.
        origin: The origin of the transition.
        trigger: The trigger.
        guards: The guards that hold.
        resume_target: The stored resume target, if any.

    Returns:
        (to, reply, reason, effects, changed), or TypeError when the caller must be refused.
    """
    matches = [
        row
        for row in rows
        if row["from"] == origin
        and row["trigger"] == trigger
        and (row["guard"] == "ALWAYS" or row["guard"] in guards)
    ]
    is_command = trigger in command_triggers
    if len(matches) > 1:
        if is_command:
            return (origin, "REJECT", "INVALID_STATE", [], False)
        return TypeError
    if not matches:
        if origin == "START":
            return TypeError
        if is_command:
            return (origin, "REJECT", "INVALID_STATE", [], False)
        return (origin, "NONE", None, [], False)
    row = matches[0]
    target = row["to"]
    if target == "SAME":
        if origin == "START":
            return TypeError
        destination = origin
    elif target == "RESUME_TARGET":
        if resume_target is None:
            return TypeError
        destination = resume_target
    else:
        destination = target
    return (
        destination,
        row["reply"],
        row.get("reason"),
        list(row["effects"]),
        destination != origin,
    )


def test_python_transition_matches_the_reference_over_the_whole_input_space() -> None:
    """Every origin, trigger, and guard set of up to two guards, with and without a resume target.

    Two guards that match the same conditional row are included: the reference expects a refusal
    for a
    command and a TypeError for an internal trigger, which is the fail-closed rule.
    """
    rows = _json_rows()
    triggers_doc = _document()["triggers"]
    command_triggers = set(triggers_doc["command"])
    all_triggers = sorted(command_triggers | set(triggers_doc["internal"]))
    origins = [*ALL_REPORTED, "START"]
    guard_sets: list[tuple[str, ...]] = [()]
    guard_sets += [(guard,) for guard in ALL_GUARDS]
    guard_sets += list(combinations(ALL_GUARDS, 2))
    compared = 0
    for origin in origins:
        for trigger in all_triggers:
            for guards in guard_sets:
                for resume_target in (None, "TELEOP"):
                    expected = _reference(
                        rows, command_triggers, origin, trigger, set(guards), resume_target
                    )
                    try:
                        result = transition(origin, trigger, guards, resume_target)  # type: ignore[arg-type]
                    except TypeError:
                        assert expected is TypeError, (origin, trigger, guards, resume_target)
                        compared += 1
                        continue
                    assert expected is not TypeError, (origin, trigger, guards, resume_target)
                    assert isinstance(expected, tuple)
                    to, reply, reason, effects, changed = expected
                    assert (result.to, result.reply, result.reason) == (to, reply, reason)
                    assert list(result.effects) == effects
                    assert result.changed == changed
                    compared += 1
    assert compared > 5000


_CLOUD_CASES: list[tuple[str, str, str | None, str, bool]] = [
    ("MOVING", "CLOUD_DISCONNECTED", None, "OFFLINE", True),
    ("IDLE", "CLOUD_SILENCE_15S", None, "OFFLINE", True),
    ("OFFLINE", "CLOUD_DISCONNECTED", None, "OFFLINE", False),
    ("OFFLINE", "ROBOT_REPORTED", "MOVING", "MOVING", True),
    ("OFFLINE", "ROBOT_REPORTED", "OFFLINE", "OFFLINE", False),
    ("IDLE", "ROBOT_REPORTED", "IDLE", "IDLE", False),
]
"""Cloud cases as (state, trigger, reported, expected state, expected changed)."""


@pytest.mark.parametrize(
    ("state", "trigger", "reported", "expected_state", "expected_changed"),
    _CLOUD_CASES,
    ids=[f"{state}-{trigger}-{reported}" for state, trigger, reported, _, _ in _CLOUD_CASES],
)
def test_the_cloud_view_gives_the_expected_state_and_change(
    state: str,
    trigger: str,
    reported: str | None,
    expected_state: str,
    expected_changed: bool,
) -> None:
    """Each cloud trigger, from a few origins, gives the state and the change the table states."""
    result = transition_cloud(state, trigger, reported)  # type: ignore[arg-type]
    assert (result.to, result.changed) == (expected_state, expected_changed)
