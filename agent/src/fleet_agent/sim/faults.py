"""The simulator's fault injector: random faults at a Poisson rate, cleared again by the simulator.

Faults are drawn per tick from a Poisson process, so the mean rate is the one configured whatever
the tick rate is. Only the faults the injector itself caused are resumed, and only after a random
delay. A block that an operator caused from the console stays until the operator resumes it: the
injector cannot tell the two apart by state alone, so it resumes only a block it caused, within
the window it opened, and never an operator's block outside that window.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from typing import Final, Literal, Protocol

from fleet_agent.core.snapshot import AgentSnapshot
from fleet_agent.protocol.primitives import ReportedState

FaultKind = Literal["OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS"]
"""The faults the simulator injects. Each is one the core's `inject_fault` accepts."""

DEFAULT_WEIGHTS: Final[Mapping[FaultKind, float]] = {
    "OBSTACLE": 3.0,
    "SENSOR_FAULT": 2.0,
    "BATTERY_LOW": 1.0,
    "LINK_LOSS": 1.0,
}
"""Relative likelihood of each fault kind, among the kinds allowed in the robot's state."""

LINK_LOSS_MS: Final[tuple[int, int]] = (5000, 15000)
"""Range of a simulated link loss, in milliseconds."""

RESUME_DELAY_MS: Final[tuple[int, int]] = (15000, 45000)
"""Range of the delay between a block the injector caused and the resume, in milliseconds."""

_RETRY_RESUME_MS: Final = 1000
"""Delay before another resume attempt, when the cause of a block is still present."""

_MAX_TICK_GAP_MS: Final = 1000
"""Largest gap between two ticks counted as elapsed time, so a stall does not inject a burst."""

_MS_PER_HOUR: Final = 3_600_000

_KINDS: Final[tuple[FaultKind, ...]] = ("OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS")
"""Every fault kind, in the fixed order of the draws."""


class FaultCore(Protocol):
    """The part of the core the fault injector uses: its view and the two simulator-only faults."""

    def snapshot(self) -> AgentSnapshot:
        """Returns the robot's read-only view."""
        ...

    def inject_fault(self, kind: FaultKind, duration_ms: int | None = None) -> bool:
        """Injects a fault, when the state table allows it here."""
        ...

    def auto_resume(self) -> bool:
        """Resumes the robot from a block whose cause has cleared."""
        ...


class FaultInjector:
    """Injects random faults into one simulated robot, and resumes the blocks it caused.

    Attributes:
        rate_per_hour: The mean number of faults per hour. Zero disables the injector.
    """

    def __init__(
        self,
        rng: random.Random,
        rate_per_hour: float,
        weights: Mapping[FaultKind, float] = DEFAULT_WEIGHTS,
    ) -> None:
        """Creates the injector of one robot.

        Args:
            rng: The random source. Seeded by the caller.
            rate_per_hour: The mean number of faults per hour, finite and non-negative.
            weights: The relative likelihood of each kind; the weights must be non-negative and
                not all zero.

        Raises:
            ValueError: If the rate or the weights are out of range.
        """
        if not (rate_per_hour >= 0.0 and rate_per_hour < float("inf")):
            raise ValueError("the fault rate must be a finite non-negative number")
        if any(weight < 0.0 for weight in weights.values()) or sum(weights.values()) <= 0.0:
            raise ValueError("the fault weights must be non-negative and not all zero")
        self.rate_per_hour = rate_per_hour
        self._rng = rng
        self._weights = dict(weights)
        self._last_ms: int | None = None
        self._resume_at_ms: int | None = None

    def tick(self, core: FaultCore, now_ms: int) -> None:
        """Resumes a block this injector caused when its time has come, then draws a fault.

        Args:
            core: The robot's core, booted and not halted.
            now_ms: The monotonic time, in milliseconds.
        """
        elapsed = 0 if self._last_ms is None else min(now_ms - self._last_ms, _MAX_TICK_GAP_MS)
        self._last_ms = now_ms
        state = core.snapshot().state
        self._resume_if_due(core, state, now_ms)
        if self.rate_per_hour == 0.0 or elapsed <= 0:
            return
        probability = self.rate_per_hour * elapsed / _MS_PER_HOUR
        if self._rng.random() >= probability:
            return
        kinds = self._allowed_in(state)
        if not kinds:
            return
        kind = self._draw(kinds)
        duration = self._rng.randint(*LINK_LOSS_MS) if kind == "LINK_LOSS" else None
        if core.inject_fault(kind, duration) and core.snapshot().state == "BLOCKED":
            self._resume_at_ms = now_ms + self._rng.randint(*RESUME_DELAY_MS)

    def _resume_if_due(self, core: FaultCore, state: ReportedState, now_ms: int) -> None:
        """Resumes the block this injector caused once its delay has passed and the cause cleared.

        A block that is no longer in place cancels the pending resume.

        Args:
            core: The robot's core.
            state: The state read at this tick.
            now_ms: The monotonic time, in milliseconds.
        """
        if self._resume_at_ms is None:
            return
        if state != "BLOCKED":
            self._resume_at_ms = None
            return
        if now_ms < self._resume_at_ms:
            return
        if core.auto_resume():
            self._resume_at_ms = None
        else:
            self._resume_at_ms = now_ms + _RETRY_RESUME_MS

    def _allowed_in(self, state: ReportedState) -> list[FaultKind]:
        """Lists the fault kinds that make sense in a state, with positive weight.

        An obstacle and a sensor fault need a moving robot, and a battery-low fault would be
        meaningless on a charging one.

        Args:
            state: The robot's reported state.

        Returns:
            The allowed kinds, in a fixed order.
        """
        allowed: list[FaultKind] = []
        for kind in _KINDS:
            if self._weights.get(kind, 0.0) <= 0.0:
                continue
            if kind in ("OBSTACLE", "SENSOR_FAULT") and state != "MOVING":
                continue
            if kind == "BATTERY_LOW" and state == "CHARGING":
                continue
            allowed.append(kind)
        return allowed

    def _draw(self, kinds: list[FaultKind]) -> FaultKind:
        """Picks one kind, weighted by the configured weights.

        Args:
            kinds: The allowed kinds, non-empty, each with a positive weight.

        Returns:
            The drawn kind.
        """
        total = sum(self._weights[kind] for kind in kinds)
        target = self._rng.random() * total
        running = 0.0
        for kind in kinds:
            running += self._weights[kind]
            if target < running:
                return kind
        return kinds[-1]
