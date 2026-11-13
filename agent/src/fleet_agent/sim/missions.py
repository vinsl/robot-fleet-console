"""The simulator's mission driver: gives an idle robot a pickup and a drop, and ends its work.

The driver is a tick hook. It asks the core only what the core would answer to the operator
anyway (its state and its charge), and it uses only the simulator-only calls of the core, which
refuse on a real robot. A robot below the mission threshold gets no mission, so it does not start
a trip it cannot finish. The two stations of a mission are reserved in a registry shared by the
fleet, so two robots never work on the same workstation.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from typing import Final, Protocol

from fleet_agent.core.model import Point
from fleet_agent.core.snapshot import AgentSnapshot
from fleet_agent.protocol.constants import BATTERY_LOW_PERCENT
from fleet_agent.sim.site_map import Station
from fleet_agent.sim.stations import StationRegistry

MISSION_MIN_BATTERY_PERCENT: Final = BATTERY_LOW_PERCENT + 5
"""Charge below which an idle robot takes no mission, in percent: a margin over the low level."""

DEFAULT_DWELL_MS: Final[tuple[int, int]] = (2000, 5000)
"""Range of the time a robot spends working at a station, in milliseconds."""


class MissionCore(Protocol):
    """The part of the core the mission driver uses: its view, its charge and its two commands."""

    @property
    def battery_percent(self) -> float:
        """The charge of the robot, in percent."""
        ...

    def snapshot(self) -> AgentSnapshot:
        """Returns the robot's read-only view."""
        ...

    def assign_mission(self, mission_id: str, stations: Sequence[Point]) -> bool:
        """Gives the robot a mission, when it can take one."""
        ...

    def finish_work(self) -> bool:
        """Ends the work of the robot at its station, when it is working."""
        ...


class MissionDriver:
    """Assigns missions to one simulated robot and finishes its work after a random dwell.

    Attributes:
        robot_id: The robot the missions are for. It is part of each mission identifier.
    """

    def __init__(
        self,
        robot_id: str,
        rng: random.Random,
        stations: Sequence[Station],
        dwell_ms: tuple[int, int] = DEFAULT_DWELL_MS,
        registry: StationRegistry | None = None,
    ) -> None:
        """Creates the driver of one robot.

        Args:
            robot_id: The robot's identifier, which the mission identifiers carry.
            rng: The random source of the pickup, the drop and the dwell. Seeded by the caller.
            stations: The workstations of the map; at least two.
            dwell_ms: The shortest and the longest dwell at a station, in milliseconds.
            registry: The reservations of the whole fleet, which must know every station. None
                gives the robot a private registry, so a lone robot needs no setup.

        Raises:
            ValueError: If there are fewer than two stations or the dwell range is empty.
        """
        if len(stations) < 2:
            raise ValueError("a mission needs at least two stations")
        if not 0 <= dwell_ms[0] <= dwell_ms[1]:
            raise ValueError("the dwell range must be non-empty and non-negative")
        self.robot_id = robot_id
        self._rng = rng
        self._stations = tuple(stations)
        self._dwell_ms = dwell_ms
        self._registry = (
            registry
            if registry is not None
            else StationRegistry(station.name for station in stations)
        )
        self._holds_stations = False
        self._missions_assigned = 0
        self._working_since_ms: int | None = None
        self._dwell_for_ms = 0

    def tick(self, core: MissionCore, now_ms: int) -> None:
        """Assigns a mission to an idle robot, or finishes the work of a robot at a station.

        The stations are released as soon as the core reports no mission in progress. That holds
        for every way a mission ends: its last station is done, the operator aborts it, or an
        e-stop stops it. A robot that is blocked or paused keeps its mission, so it keeps its
        stations, because it resumes the same mission.

        Args:
            core: The robot's core, booted and not halted.
            now_ms: The monotonic time, in milliseconds.
        """
        snapshot = core.snapshot()
        if self._holds_stations and snapshot.mission_id is None:
            self._release()
        state = snapshot.state
        if state == "WORKING":
            self._finish_when_dwelt(core, now_ms)
            return
        self._working_since_ms = None
        # No mission starts while an operator holds control: an e-stop released back to IDLE
        # must not set the robot moving again behind the operator's back.
        if (
            state != "IDLE"
            or snapshot.lock_held
            or core.battery_percent < MISSION_MIN_BATTERY_PERCENT
        ):
            return
        free = set(self._registry.free_ids())
        available = [station for station in self._stations if station.name in free]
        if len(available) < 2:
            return
        pickup, drop = self._rng.sample(available, 2)
        if not self._registry.try_reserve(self.robot_id, [pickup.name, drop.name]):
            return
        self._holds_stations = True
        mission_id = f"m-{self.robot_id}-{self._missions_assigned + 1:04d}"
        if core.assign_mission(mission_id, [pickup.point, drop.point]):
            self._missions_assigned += 1
        else:
            self._release()

    def _release(self) -> None:
        """Gives back the stations of the robot and forgets that it holds them."""
        self._registry.release(self.robot_id)
        self._holds_stations = False

    def _finish_when_dwelt(self, core: MissionCore, now_ms: int) -> None:
        """Starts the dwell on the first tick of a work session, and ends it once it has passed.

        Args:
            core: The robot's core, in WORKING.
            now_ms: The monotonic time, in milliseconds.
        """
        if self._working_since_ms is None:
            self._working_since_ms = now_ms
            low, high = self._dwell_ms
            self._dwell_for_ms = self._rng.randint(low, high)
        if now_ms - self._working_since_ms >= self._dwell_for_ms:
            self._working_since_ms = None
            core.finish_work()
