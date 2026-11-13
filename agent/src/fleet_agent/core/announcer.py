"""The announcer: what a committed transition tells the console, and in which order.

The order is the one the console relies on: the state change first, then the lock, the faults and
the latch. A change of state also asks for telemetry at once, so the console sees it without waiting
for the period. Every announcement is also a log line, so the log and the wire agree.
"""

from __future__ import annotations

import logging
from typing import Literal, cast

from fleet_agent.core.corelog import CoreLog
from fleet_agent.core.effects import EffectOutcome, LatchOutcome
from fleet_agent.core.lock import LockChangeKind
from fleet_agent.core.outbox import Outbox
from fleet_agent.core.scheduler import TelemetryScheduler
from fleet_agent.protocol.primitives import FaultCode, ReportedState
from fleet_agent.protocol.triggers import StateChangeCause, Trigger


class Announcer:
    """Publishes and logs the events of the robot, and tracks whether the latch is persisted."""

    def __init__(self, *, outbox: Outbox, log: CoreLog, scheduler: TelemetryScheduler) -> None:
        """Creates an announcer with a persisted latch, which is the state before any write fails.

        Args:
            outbox: The door the events are published through.
            log: The core's log writer.
            scheduler: The telemetry scheduler, asked for telemetry after a state change.
        """
        self._outbox = outbox
        self._log = log
        self._scheduler = scheduler
        self._latch_persisted = True

    @property
    def latch_persisted(self) -> bool:
        """Whether the latch on disk matches the e-stop in memory.

        Returns:
            False only while the last latch write failed and no later latch write succeeded.
        """
        return self._latch_persisted

    def transition(
        self,
        *,
        from_state: ReportedState,
        to_state: ReportedState,
        changed: bool,
        cause: Trigger,
        command_id: str | None,
        outcome: EffectOutcome,
        holder_sub: str | None,
    ) -> None:
        """Publishes what a committed transition changed, in the order the console expects.

        Args:
            from_state: The state before the transition.
            to_state: The state after the transition.
            changed: Whether the state changed.
            cause: The trigger that caused it.
            command_id: The command that caused it, None for an internal trigger.
            outcome: What the effects changed.
            holder_sub: The subject of the lock holder, when the transition acquires the lock.
        """
        if changed:
            self._state_changed(from_state, to_state, cause, command_id)
        self.lock(outcome.lock_change, holder_sub)
        self.faults(outcome)
        self.latch(outcome.latch, command_id)
        if changed:
            self._scheduler.request_immediate()

    def lock(self, kind: LockChangeKind | None, holder_sub: str | None) -> None:
        """Publishes a lock change, if the change is visible to the console.

        A refresh by the holder is silent, as the protocol requires. A grant names the holder, the
        only event that does.

        Args:
            kind: What happened to the lock, or None when nothing did.
            holder_sub: The subject of the new holder, for a grant.

        Raises:
            TypeError: If a grant comes without its holder, which the table never produces.
        """
        match kind:
            case None | "REFRESHED":
                return
            case "RELEASED" | "EXPIRED":
                self._lock_free(kind)
            case _:
                # The only kinds left are the two grants, which name their holder.
                if holder_sub is None:
                    raise TypeError("a lock grant needs its holder")
                self._lock_held(holder_sub, kind)
        self._log.log(logging.INFO, "lock.changed", lockCause=kind)

    def faults(self, outcome: EffectOutcome) -> None:
        """Publishes the faults raised and cleared by a transition, raised first.

        Args:
            outcome: What the effects changed.
        """
        if outcome.fault_raised is not None:
            self.fault_raised(outcome.fault_raised)
        if outcome.fault_cleared is not None:
            self.fault_cleared(outcome.fault_cleared)

    def fault_raised(self, fault: FaultCode) -> None:
        """Publishes a fault appearing, and logs it.

        Args:
            fault: The fault that appeared.
        """
        factory = self._outbox.factory
        self._outbox.send("FAULT_RAISED", lambda: factory.fault_raised(fault))
        self._log.log(logging.WARNING, "fault.raised", fault=fault)

    def fault_cleared(self, fault: FaultCode) -> None:
        """Publishes a fault going away, and logs it.

        Args:
            fault: The fault that cleared.
        """
        factory = self._outbox.factory
        self._outbox.send("FAULT_CLEARED", lambda: factory.fault_cleared(fault))
        self._log.log(logging.INFO, "fault.cleared", fault=fault)

    def latch(self, outcome: LatchOutcome | None, command_id: str | None) -> None:
        """Logs what happened to the e-stop latch, and records whether it is persisted.

        A failed write is logged at ERROR and leaves the flag false until a later write succeeds.

        Args:
            outcome: The latch outcome, or None when the latch was not touched.
            command_id: The command that touched the latch, if one did.
        """
        if outcome is None:
            return
        if outcome == "SET_FAILED":
            self._latch_persisted = False
            self._log.log(logging.ERROR, "latch.set_failed", commandId=command_id)
        elif outcome == "SET":
            self._latch_persisted = True
            self._log.log(logging.INFO, "latch.set", commandId=command_id)
        else:
            self._latch_persisted = True
            self._log.log(logging.INFO, "latch.cleared", commandId=command_id)

    def _state_changed(
        self,
        from_state: ReportedState,
        to_state: ReportedState,
        cause: Trigger,
        command_id: str | None,
    ) -> None:
        """Publishes a state change event, and logs it.

        An e-stop's state change is priority: the console must learn of a stop even when the QoS 1
        queue is full.

        Args:
            from_state: The state before the change.
            to_state: The state after the change.
            cause: The trigger that caused it. `BOOT` never reaches here: a boot announces itself.
            command_id: The command that caused it, if one did.
        """
        # Every trigger except BOOT is a state change cause. BOOT is refused by `fire_internal`,
        # and `boot` never announces a state change, so the narrowing cannot be wrong.
        state_cause = cast("StateChangeCause", cause)
        factory = self._outbox.factory
        self._outbox.send(
            "STATE_CHANGED",
            lambda: factory.state_changed(
                from_state=from_state,
                to_state=to_state,
                cause=state_cause,
                command_id=command_id,
            ),
            priority=cause == "ESTOP",
        )
        self._log.log(
            logging.INFO,
            "state.changed",
            fromState=from_state,
            toState=to_state,
            cause=cause,
            commandId=command_id,
        )

    def _lock_held(self, holder_sub: str, cause: Literal["ACQUIRED", "TAKEOVER"]) -> None:
        """Publishes a lock grant, which names the holder.

        Args:
            holder_sub: The subject of the holder, as the console knows it.
            cause: Whether the lock was free or taken over.
        """
        factory = self._outbox.factory
        self._outbox.send("LOCK_CHANGED", lambda: factory.lock_held(holder=holder_sub, cause=cause))

    def _lock_free(self, cause: Literal["RELEASED", "EXPIRED"]) -> None:
        """Publishes a lock release or expiry. It names no holder.

        Args:
            cause: Whether the holder released the lock or it expired.
        """
        factory = self._outbox.factory
        self._outbox.send("LOCK_CHANGED", lambda: factory.lock_free(cause=cause))
