"""The workstation reservations of a simulated fleet: a workstation is free or held by one robot.

A robot reserves the two workstations of a mission before it takes the mission, and gives them back
once the mission has ended, when the robot is halted or when it is stopped. Without this, every
robot picks its stations at random and the fleet piles up on the same few workstations.

The fleet runs all its robots on one asyncio loop, so the registry takes no lock. It must not be
shared with another thread.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence


class StationRegistry:
    """Tracks which robot holds each workstation of one fleet run.

    A reservation is all-or-nothing: a robot gets both stations of a mission or none. A robot holds
    at most one reservation at a time, so a robot must release before it reserves again.
    """

    def __init__(self, station_ids: Iterable[str]) -> None:
        """Creates a registry in which every workstation is free.

        Args:
            station_ids: The identifiers of the workstations of the map. Unique and non-empty.

        Raises:
            ValueError: If there is no workstation, or two workstations share an identifier.
        """
        ids = tuple(station_ids)
        if not ids:
            raise ValueError("a station registry needs at least one workstation")
        if len(set(ids)) != len(ids):
            raise ValueError("workstation identifiers must be unique")
        self._order = ids
        self._known = frozenset(ids)
        self._holders: dict[str, str] = {}
        self._held: dict[str, frozenset[str]] = {}

    def try_reserve(self, robot_id: str, station_ids: Sequence[str]) -> bool:
        """Reserves a set of workstations for one robot, if every one of them is free.

        Args:
            robot_id: The robot that takes the stations.
            station_ids: The distinct workstations of the mission, all known to the registry.

        Returns:
            True when every workstation was reserved for the robot; False, with nothing changed,
            when one of them is held by another robot.

        Raises:
            ValueError: If the robot already holds a reservation, the list is empty or repeats a
                workstation, or a workstation is unknown. These are programming errors, not
                contention, so they are not reported as a False.
        """
        if robot_id in self._held:
            raise ValueError("the robot already holds a reservation")
        wanted = frozenset(station_ids)
        if not wanted or len(wanted) != len(station_ids):
            raise ValueError("a reservation needs distinct workstations")
        if not wanted <= self._known:
            raise ValueError("a reservation names an unknown workstation")
        if any(station in self._holders for station in wanted):
            return False
        for station in wanted:
            self._holders[station] = robot_id
        self._held[robot_id] = wanted
        return True

    def release(self, robot_id: str) -> None:
        """Gives back every workstation the robot holds. A robot holding nothing is a no-op.

        Args:
            robot_id: The robot whose reservation ends.
        """
        for station in self._held.pop(robot_id, frozenset()):
            del self._holders[station]

    def holder_of(self, station_id: str) -> str | None:
        """Tells which robot holds a workstation.

        Args:
            station_id: The workstation to look up, known to the registry.

        Returns:
            The identifier of the robot holding it, or None when it is free.

        Raises:
            ValueError: If the workstation is unknown to the registry.
        """
        if station_id not in self._known:
            raise ValueError("unknown workstation")
        return self._holders.get(station_id)

    def free_ids(self) -> tuple[str, ...]:
        """Lists the free workstations, in the order they were registered.

        Returns:
            The identifiers of the workstations no robot holds.
        """
        return tuple(station for station in self._order if station not in self._holders)
