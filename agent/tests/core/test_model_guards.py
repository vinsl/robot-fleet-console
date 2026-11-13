"""Guards computed from the model: each family is exclusive, and the work-done priority holds."""

from __future__ import annotations

import pytest

from fleet_agent.core.model import Destination, Point, RobotModel, guards_for
from fleet_agent.core.state_machine import Guard, transition

from .fakes import make_model

_CAUSE_FAMILY: frozenset[Guard] = frozenset({"CAUSE_PENDING", "CAUSE_CLEARED"})
_DEST_FAMILY: frozenset[Guard] = frozenset({"DEST_CHARGER", "DEST_STATION"})
_WORK_DONE_FAMILY: frozenset[Guard] = frozenset(
    {"CHARGE_REQUESTED", "MISSION_REMAINING", "MISSION_COMPLETE"}
)
_LATCH_FAMILY: frozenset[Guard] = frozenset({"LATCH_SET", "LATCH_NOT_SET"})
_ESTOP_FAMILY: frozenset[Guard] = frozenset({"ESTOP_FROM_IDLE", "ESTOP_FROM_OTHER"})
_STATION = Destination("STATION", Point(4.0, 4.0))
_CHARGER = Destination("CHARGER", Point(0.0, 0.0))


@pytest.mark.parametrize("cause_pending", [True, False], ids=["pending", "cleared"])
def test_the_cause_family_is_exactly_one_guard(cause_pending: bool) -> None:
    model = make_model()
    model.cause_pending = cause_pending

    held = guards_for(model) & _CAUSE_FAMILY

    assert held == {"CAUSE_PENDING" if cause_pending else "CAUSE_CLEARED"}


@pytest.mark.parametrize(
    ("destination", "expected"),
    [
        (_CHARGER, {"DEST_CHARGER"}),
        (_STATION, {"DEST_STATION"}),
        (None, set()),
    ],
    ids=["charger", "station", "no-destination"],
)
def test_the_destination_family_follows_the_destination_kind(
    destination: Destination | None, expected: set[Guard]
) -> None:
    model = make_model()
    model.destination = destination

    assert guards_for(model) & _DEST_FAMILY == expected


def test_no_destination_gives_no_destination_guard() -> None:
    model = make_model()

    assert not guards_for(model) & _DEST_FAMILY


@pytest.mark.parametrize(
    ("charge_requested", "stations", "expected"),
    [
        (True, [], {"CHARGE_REQUESTED"}),
        (True, [Point(1.0, 1.0)], {"CHARGE_REQUESTED"}),
        (False, [Point(1.0, 1.0)], {"MISSION_REMAINING"}),
        (False, [], {"MISSION_COMPLETE"}),
    ],
    ids=["charge-without-stations", "charge-beats-stations", "stations", "complete"],
)
def test_the_work_done_family_has_charge_then_stations_then_complete_priority(
    charge_requested: bool, stations: list[Point], expected: set[Guard]
) -> None:
    model = make_model(state="WORKING")
    model.charge_requested = charge_requested
    model.mission_stations = stations

    assert guards_for(model) & _WORK_DONE_FAMILY == expected


def test_latch_guards_are_never_computed_here() -> None:
    model = make_model()

    assert not guards_for(model) & _LATCH_FAMILY


def test_the_guards_pick_exactly_one_work_done_row_in_the_state_machine() -> None:
    model: RobotModel = make_model(state="WORKING")
    model.charge_requested = True
    model.mission_stations = [Point(1.0, 1.0)]

    result = transition("WORKING", "WORK_DONE", guards_for(model), None)

    assert result.to == "MOVING"
    assert result.effects == ("END_MISSION", "SET_DEST_CHARGER")


def test_arrival_at_a_station_and_at_the_charger_take_different_rows() -> None:
    model = make_model(state="MOVING")
    model.destination = _STATION

    at_station = transition("MOVING", "ARRIVED", guards_for(model), None)
    model.destination = _CHARGER
    at_charger = transition("MOVING", "ARRIVED", guards_for(model), None)

    assert (at_station.to, at_charger.to) == ("WORKING", "CHARGING")


@pytest.mark.parametrize(
    ("state", "from_idle", "expected"),
    [
        ("ESTOP", True, {"ESTOP_FROM_IDLE"}),
        ("ESTOP", False, {"ESTOP_FROM_OTHER"}),
        ("IDLE", True, {"ESTOP_FROM_OTHER"}),
    ],
    ids=["idle-origin", "other-or-unknown-origin", "stale-flag-outside-estop"],
)
def test_the_estop_family_is_exactly_one_guard(
    state: str, from_idle: bool, expected: set[Guard]
) -> None:
    model = make_model(state=state)
    model.estop_from_idle = from_idle

    held = guards_for(model) & _ESTOP_FAMILY

    assert held == expected
