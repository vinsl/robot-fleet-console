"""Tests of the workstation registry: all-or-nothing reservations, release, and the bad inputs.

The registry is small and pure, so these tests use it directly, without a robot or a core.
"""

from __future__ import annotations

import pytest

from fleet_agent.sim.stations import StationRegistry


def test_a_registry_starts_with_every_workstation_free_in_registration_order() -> None:
    """Given three workstations, when the registry is built, then all are free, in order."""
    registry = StationRegistry(["pick", "drop", "pack"])

    assert registry.free_ids() == ("pick", "drop", "pack")
    assert registry.holder_of("drop") is None


def test_a_reservation_takes_every_station_it_names_for_one_robot() -> None:
    """Given free workstations, when a robot reserves two, then it holds both and only those."""
    registry = StationRegistry(["pick", "drop", "pack"])

    assert registry.try_reserve("sim-01", ["pick", "pack"]) is True

    assert registry.holder_of("pick") == "sim-01"
    assert registry.holder_of("pack") == "sim-01"
    assert registry.free_ids() == ("drop",)


def test_a_reservation_is_all_or_nothing_when_one_station_is_held() -> None:
    """Given one station held by another robot, when a robot asks for two including it,
    then it is refused and gets neither station."""
    registry = StationRegistry(["pick", "drop", "pack"])
    assert registry.try_reserve("sim-01", ["drop"]) is True

    assert registry.try_reserve("sim-02", ["pick", "drop"]) is False

    assert registry.holder_of("pick") is None
    assert registry.holder_of("drop") == "sim-01"


def test_a_robot_that_holds_a_reservation_cannot_reserve_again() -> None:
    """Given a robot with a reservation, when it reserves again, then the call is a programming
    error and nothing changes."""
    registry = StationRegistry(["pick", "drop", "pack"])
    registry.try_reserve("sim-01", ["pick", "drop"])

    with pytest.raises(ValueError, match="already holds"):
        registry.try_reserve("sim-01", ["pack"])
    assert registry.free_ids() == ("pack",)


@pytest.mark.parametrize(
    ("wanted", "message"),
    [
        ([], "distinct"),
        (["pick", "pick"], "distinct"),
        (["nowhere"], "unknown"),
        (["pick", "nowhere"], "unknown"),
    ],
    ids=["empty", "repeated", "unknown", "partly-unknown"],
)
def test_a_malformed_reservation_is_refused_without_changing_anything(
    wanted: list[str], message: str
) -> None:
    """Given an empty, repeated or unknown request, when reserved, then it raises and no station
    is taken."""
    registry = StationRegistry(["pick", "drop"])

    with pytest.raises(ValueError, match=message):
        registry.try_reserve("sim-01", wanted)
    assert registry.free_ids() == ("pick", "drop")


def test_release_gives_back_every_station_of_the_robot_only() -> None:
    """Given two robots with reservations, when one is released, then its stations are free
    and the other robot keeps its own."""
    registry = StationRegistry(["pick", "drop", "pack", "load"])
    registry.try_reserve("sim-01", ["pick", "drop"])
    registry.try_reserve("sim-02", ["pack", "load"])

    registry.release("sim-01")

    assert registry.free_ids() == ("pick", "drop")
    assert registry.holder_of("pack") == "sim-02"


def test_releasing_a_robot_with_nothing_held_changes_nothing() -> None:
    """Given a robot that holds nothing, when it is released, then nothing changes, and a second
    release is harmless too."""
    registry = StationRegistry(["pick", "drop"])
    registry.try_reserve("sim-01", ["pick", "drop"])

    registry.release("sim-09")
    registry.release("sim-01")
    registry.release("sim-01")

    assert registry.free_ids() == ("pick", "drop")


def test_a_released_station_can_be_reserved_by_another_robot() -> None:
    """Given a station released by its holder, when another robot reserves it, then it gets it."""
    registry = StationRegistry(["pick", "drop"])
    registry.try_reserve("sim-01", ["pick", "drop"])
    registry.release("sim-01")

    assert registry.try_reserve("sim-02", ["drop", "pick"]) is True
    assert registry.holder_of("drop") == "sim-02"


def test_an_unknown_workstation_cannot_be_looked_up() -> None:
    """Given a registry, when a workstation it does not know is looked up, then it raises."""
    registry = StationRegistry(["pick"])

    with pytest.raises(ValueError, match="unknown"):
        registry.holder_of("nowhere")


@pytest.mark.parametrize(
    ("ids", "message"),
    [([], "at least one"), (["pick", "pick"], "unique")],
    ids=["empty", "duplicate"],
)
def test_a_registry_needs_one_workstation_and_unique_identifiers(
    ids: list[str], message: str
) -> None:
    """Given no workstation or a repeated identifier, when the registry is built, it refuses."""
    with pytest.raises(ValueError, match=message):
        StationRegistry(ids)
