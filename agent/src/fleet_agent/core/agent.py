"""The robot agent core: runs the command pipeline, the timers and the telemetry of one robot.

The core is synchronous and owns no I/O. The transport calls its `TransportListener` methods on
the event-loop thread, the runner calls `tick` every 50 ms, and every publish goes through the
`Link` port, via the outbox. Nothing here awaits, so a stop command is never queued behind a
slow call.

The order of operations is the safety order. A command is checked for age and identity before it
may touch the lock; the lock is checked before the state machine; and the deadman and the lock
expiry run in `tick` even when the link is down. The outputs of a transition are published in a
fixed order, which the console relies on: the acknowledgement first, then the state change, then
the lock, the faults and the latch.

A core that meets a state it does not understand halts: it stops the robot and refuses further
work. It never guesses its way forward. An e-stop is the one command a stopping or failing core
still acts on, because a stop must never be refused.
"""

from __future__ import annotations

import logging
import math
import random
from collections.abc import Callable, Sequence
from typing import Final, Literal

from pydantic import TypeAdapter, ValidationError

from fleet_agent.core.announcer import Announcer
from fleet_agent.core.commands import fault_duration_ms, holder_of, issue_time_ms, refusal_for
from fleet_agent.core.constants import ACCEL_MPS2, DROP_LINK_ACK_GRACE_MS
from fleet_agent.core.corelog import CoreLog
from fleet_agent.core.deadman import Deadman
from fleet_agent.core.effects import EffectContext, EffectError, EffectOutcome, apply_effects
from fleet_agent.core.identity import AgentIdentity
from fleet_agent.core.ids import uuid7
from fleet_agent.core.lock import LockHolder, RobotLock
from fleet_agent.core.messages import MessageBuildError, MessageFactory, OutboundMessage
from fleet_agent.core.model import Point, RobotModel, SiteGeometry, guards_for
from fleet_agent.core.motion import battery_after, capped_dt_ms, next_speed, step_towards
from fleet_agent.core.navigation import StraightLineNavigator
from fleet_agent.core.outbox import Outbox
from fleet_agent.core.ports import (
    Clock,
    LatchRecord,
    LatchStore,
    LatchWriteError,
    Link,
    Navigator,
)
from fleet_agent.core.replay import ReplayGuard
from fleet_agent.core.scheduler import TelemetryScheduler
from fleet_agent.core.screening import (
    SIMULATE_TRIGGER,
    Dropped,
    Refused,
    Screened,
    ScreeningContext,
    screen_command,
    trigger_of,
)
from fleet_agent.core.snapshot import AgentSnapshot, banner_of
from fleet_agent.core.state_machine import Effect, Guard, TransitionResult, transition
from fleet_agent.core.subscription import Subscription
from fleet_agent.core.telemetry import TelemetryPublisher
from fleet_agent.core.throttle import LogThrottle
from fleet_agent.protocol.constants import BATTERY_LOW_PERCENT, LOCK_REQUIRED_COMMANDS
from fleet_agent.protocol.primitives import MissionId
from fleet_agent.protocol.topics import command_topic
from fleet_agent.protocol.triggers import InternalTrigger, Trigger
from fleet_agent.timefmt import format_iso_ms

_FULL_CHARGE_PERCENT: Final = 100.0
"""Charge at which a charging robot is full. The battery model clamps to the same bound."""

_MAX_FAULT_DURATION_MS: Final = 300_000
"""The longest a simulated fault may last, in milliseconds: the protocol's bound on `duration_s`."""

_MISSION_ID: Final[TypeAdapter[str]] = TypeAdapter(MissionId)
"""Checks a mission identifier against the protocol's pattern, which also bounds its length."""


def _is_valid_mission_id(mission_id: str) -> bool:
    """Tells whether a mission identifier passes the protocol's pattern and length bound.

    Args:
        mission_id: The candidate identifier, untrusted.

    Returns:
        True when the identifier is valid, so the telemetry that carries it can be built.
    """
    try:
        _MISSION_ID.validate_python(mission_id)
    except ValidationError:
        return False
    return True


def _is_finite_point(point: Point) -> bool:
    """Tells whether both coordinates of a station are finite numbers.

    Args:
        point: The station, untrusted.

    Returns:
        False for a NaN or an infinite coordinate, which the motion model cannot integrate.
    """
    return math.isfinite(point.x) and math.isfinite(point.y)


class AgentCore:
    """The orchestrator of one robot. It implements `TransportListener`.

    The core is created unbooted. `boot` reads the latch, publishes the first event and sets the
    starting state; every other method assumes a booted core, as the runner always boots it first.
    """

    def __init__(
        self,
        *,
        identity: AgentIdentity,
        geometry: SiteGeometry,
        battery_start: float,
        clock: Clock,
        transport: Link,
        latch: LatchStore,
        new_id: Callable[[], str] = uuid7,
        rand: Callable[[], float] = random.random,
        navigator: Navigator | None = None,
    ) -> None:
        """Creates an unbooted core with a free lock, a fresh replay memory and the start position.

        Args:
            identity: Who the robot is.
            geometry: The site layout: the charger, the start position and the cruise speed.
            battery_start: The charge at boot, in percent.
            clock: The source of monotonic and wall time.
            transport: The MQTT link. Its listener must be this core, set by the runner.
            latch: The durable e-stop latch.
            new_id: The source of UUIDv7 identifiers, injected so tests can pin them.
            rand: The source of the uniform draws of the subscribe backoff, injected for tests.
            navigator: The path planner of the motion. Defaults to a straight line, the only path
                a real robot takes unless it is given a site map.

        Raises:
            TypeError: If the identity is outside the topic grammar.
        """
        self._identity = identity
        self._geometry = geometry
        self._clock = clock
        self._transport = transport
        self._latch = latch
        self._rand = rand
        factory = MessageFactory(
            robot_id=identity.robot_id,
            site_id=identity.site_id,
            boot_id=new_id(),
            clock=clock,
            new_id=new_id,
        )
        self._screening = ScreeningContext(
            robot_id=identity.robot_id,
            site_id=identity.site_id,
            simulated=identity.simulated,
            command_topic=command_topic(identity.site_id, identity.robot_id),
        )
        self._replay = ReplayGuard()
        self._lock = RobotLock()
        self._deadman = Deadman()
        self._scheduler = TelemetryScheduler(simulated=identity.simulated)
        self._log = CoreLog(
            robot_id=identity.robot_id,
            site_id=identity.site_id,
            boot_id=factory.boot_id,
            throttle=LogThrottle(clock),
        )
        self._outbox = Outbox(
            transport=transport,
            factory=factory,
            scheduler=self._scheduler,
            log=self._log,
            clock=clock,
        )
        self._announcer = Announcer(outbox=self._outbox, log=self._log, scheduler=self._scheduler)
        self._model = RobotModel(
            state="IDLE",
            resume_target=None,
            x=geometry.start.x,
            y=geometry.start.y,
            heading=geometry.start_heading,
            speed=0.0,
            battery=battery_start,
        )
        self._telemetry = TelemetryPublisher(
            model=self._model,
            outbox=self._outbox,
            scheduler=self._scheduler,
            log=self._log,
            now_ms=clock.monotonic_ms(),
        )
        self._subscription = Subscription(
            transport=transport,
            topic=self._screening.command_topic,
            log=self._log,
            clock=clock,
            rand=rand,
        )
        self._navigator: Navigator = navigator if navigator is not None else StraightLineNavigator()
        self._stopping = False
        self._halted = False
        self._last_tick_ms = clock.monotonic_ms()
        self._pending_suspend_ms: int | None = None
        self._suspend_deadline_ms: int | None = None

    @property
    def halted(self) -> bool:
        """Whether the core stopped itself after an unexpected fault.

        Returns:
            True once `halt` ran. A halted core ignores the tick and every command but an e-stop,
            which it still acts on.
        """
        return self._halted

    @property
    def stopping(self) -> bool:
        """Whether a clean shutdown began.

        Returns:
            True once `begin_shutdown` ran. A stopping core drops every command but an e-stop.
        """
        return self._stopping

    @property
    def battery_percent(self) -> float:
        """The charge of the robot, in percent, read by the simulator's mission driver.

        The snapshot is the operator's view and carries no charge, so a read-only accessor serves
        the one caller that needs it. It changes nothing: the battery model is the only writer.

        Returns:
            The charge, in percent, within [0, 100].
        """
        return self._model.battery

    def boot(self) -> None:
        """Reads the latch, sets the starting state and announces the boot.

        A latched robot boots in ESTOP. The first event of every boot is `BOOT`, with sequence 0.

        Raises:
            LatchUnreadableError: If the latch cannot be read. The boot is refused, not guessed.
        """
        latched = self._latch.is_set()
        guard: Guard = "LATCH_SET" if latched else "LATCH_NOT_SET"
        result = transition("START", "BOOT", (guard,))
        self._model.state = result.to
        state = result.to
        self._outbox.send(
            "BOOT",
            lambda: self._outbox.factory.boot(
                agent_version=self._identity.agent_version,
                simulated=self._identity.simulated,
                state=state,
            ),
        )
        self._scheduler.request_immediate()
        self._log.log(
            logging.INFO,
            "agent.booted",
            thingName=self._identity.thing_name,
            version=self._identity.agent_version,
            simulated=self._identity.simulated,
            state=state,
        )
        if latched:
            self._log.log(logging.WARNING, "agent.boot_latched", state=state)

    def tick(self) -> None:
        """Runs one 50 ms step of the robot's timers, motion and telemetry.

        The order is the safety order: the lock expiry and the deadman come before any motion, so
        a robot whose operator has gone stops before it moves again. A step that can change the
        state is followed by a halt check, so a halted robot never moves.
        """
        if self._halted:
            return
        now = self._clock.monotonic_ms()
        dt = capped_dt_ms(now - self._last_tick_ms)
        self._last_tick_ms = now
        if self._lock.is_idle_expired(now):
            self._expire_lock(now)
            if self._halted:
                return
        self._check_deadman(now)
        if self._halted:
            return
        self._check_fault_timer(now)
        if self._halted:
            return
        if self._suspend_deadline_ms is not None and now >= self._suspend_deadline_ms:
            self._suspend()
        self._step_motion(now, dt)
        if self._halted:
            return
        self._step_battery(now, dt)
        if self._halted:
            return
        if self._outbox.connected:
            self._telemetry.publish_due(now)
        if self._outbox.connected and self._subscription.retry_due(now):
            self._subscription.subscribe()

    def on_connected(self) -> None:
        """Handles a connection: subscribes to the command topic and reports the link is back.

        The console is told at once, so it leaves OFFLINE without waiting for telemetry. A drop
        simulated by a fault is reported cleared here, once the link is back.
        """
        self._outbox.set_connected(True)
        self._log.log(logging.INFO, "link.connected")
        self._subscription.subscribe()
        self._scheduler.request_immediate()
        if self._model.link_loss_active:
            self._model.link_loss_active = False
            self._announcer.fault_cleared("LINK_LOSS")

    def on_disconnected(self, error_name: str | None, reason_code: int | None) -> None:
        """Handles the loss of an established connection. The timers keep running.

        Args:
            error_name: The local error class name, when the loss had one.
            reason_code: The MQTT reason code, when the broker sent one.
        """
        self._outbox.set_connected(False)
        self._log.log(
            logging.WARNING,
            "link.lost",
            errorName=error_name,
            reasonCode=reason_code,
        )

    def on_connect_failed(self, error_name: str | None, reason_code: int | None) -> None:
        """Handles a failed connection attempt. The transport retries by itself.

        The line is throttled: a revoked certificate retries endlessly and must not flood the log.

        Args:
            error_name: The local error class name, when the attempt had one.
            reason_code: The CONNACK reason code, when the broker sent one.
        """
        self._outbox.set_connected(False)
        self._log.log_throttled(
            "link.connect_failed",
            logging.WARNING,
            "link.connect_failed",
            errorName=error_name,
            reasonCode=reason_code,
        )

    def on_message(self, topic: str, payload: bytes) -> None:
        """Runs one inbound message through the screening, the lock and the state machine.

        A halted core acts on one thing only: an e-stop that passes screening, which stops the robot
        again, writes the latch and is acknowledged on a best-effort basis. Everything else is
        dropped. A stopping core drops everything except an e-stop that passes screening, which is
        still acted on: a stop must never be refused because a shutdown began. Every other stopping
        drop is logged, at most once per interval.

        Args:
            topic: The topic the message arrived on.
            payload: The raw payload, untrusted.
        """
        decision = screen_command(
            topic,
            payload,
            ctx=self._screening,
            replay=self._replay,
            now_wall_ms=self._clock.wall_ms(),
        )
        if self._halted:
            if isinstance(decision, Screened) and decision.command.type == "ESTOP":
                self._estop_after_halt(decision)
            return
        if self._stopping:
            if isinstance(decision, Screened) and decision.command.type == "ESTOP":
                self._run_command(decision)
            else:
                # A refused ESTOP is only logged while stopping, never answered: the robot stops
                # either way, and the link is closing, so a REJECT would tell the console nothing.
                self._log.log_throttled(
                    "command.dropped.stopping",
                    logging.INFO,
                    "command.dropped",
                    stage="STOPPING",
                    sizeBytes=len(payload),
                )
            return
        if isinstance(decision, Dropped):
            self._log.log_throttled(
                "command.dropped",
                logging.WARNING,
                "command.dropped",
                stage=decision.stage,
                sizeBytes=decision.size_bytes,
            )
        elif isinstance(decision, Refused):
            self._refuse(decision, logging.INFO)
        else:
            self._run_command(decision)

    def fire_internal(self, trigger: InternalTrigger) -> None:
        """Raises an internal trigger on the robot's own behalf. It is never acknowledged.

        This is the hook the mission logic of a later milestone uses, so its triggers go through
        the same table and the same effects as everything else.

        Args:
            trigger: The internal trigger. `BOOT` is refused: a boot is run by `boot`.

        Raises:
            ValueError: If the trigger is `BOOT`.
        """
        if trigger == "BOOT":
            raise ValueError("BOOT is run by boot(), not fired as an internal trigger")
        self._fire_internal(trigger, self._clock.monotonic_ms())

    def assign_mission(self, mission_id: str, stations: Sequence[Point]) -> bool:
        """Gives an idle simulated robot a mission: it drives to the first station.

        Simulator only. A real robot receives its missions from the cloud, so the call is refused
        before anything changes. It changes nothing either unless the robot is IDLE, with no mission
        in progress and no destination, and neither stopping nor halted.

        Args:
            mission_id: The identifier of the mission, carried by the telemetry. It must pass the
                protocol's pattern, which also bounds its length.
            stations: The stations to visit, in order. An empty sequence is refused, as is a
                station with a non-finite coordinate.

        Returns:
            True when the mission was assigned, False when the robot could not take it.

        Raises:
            ValueError: If the robot is not a simulator.
        """
        self._require_simulated("assign_mission")
        model = self._model
        if (
            self._stopping
            or self._halted
            or model.state != "IDLE"
            or model.mission_id is not None
            or model.destination is not None
            or not stations
            or not _is_valid_mission_id(mission_id)
            or not all(_is_finite_point(station) for station in stations)
        ):
            return False
        model.mission_id = mission_id
        model.mission_stations = list(stations)
        self._fire_internal("MISSION_ASSIGNED", self._clock.monotonic_ms())
        return not self._halted

    def finish_work(self) -> bool:
        """Ends the work of a simulated robot at a station, so it moves on or goes idle.

        Simulator only, as `assign_mission`. It changes nothing unless the robot is WORKING, and
        neither stopping nor halted.

        Returns:
            True when the work was finished, False when the robot was not working.

        Raises:
            ValueError: If the robot is not a simulator.
        """
        self._require_simulated("finish_work")
        if self._stopping or self._halted or self._model.state != "WORKING":
            return False
        self._fire_internal("WORK_DONE", self._clock.monotonic_ms())
        return not self._halted

    def inject_fault(
        self,
        kind: Literal["OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS"],
        duration_ms: int | None = None,
    ) -> bool:
        """Injects a simulated fault with the effects of the operator's `SIMULATE_FAULT` command.

        The command pipeline is skipped: there is no lock check and no acknowledgement. The state
        table still decides, so a fault the table does not allow in the current state changes
        nothing. Simulator only, so a real robot is never faulted on purpose.

        Args:
            kind: The fault to inject.
            duration_ms: How long a timed fault lasts, in milliseconds, above zero and at most the
                protocol's maximum. None uses the default. Any other value is refused.

        Returns:
            True when the fault was injected, False when the table has no row for it here, or
            when the duration is out of bounds.

        Raises:
            ValueError: If the robot is not a simulator.
        """
        self._require_simulated("inject_fault")
        if self._stopping or self._halted:
            return False
        if duration_ms is not None and not 0 < duration_ms <= _MAX_FAULT_DURATION_MS:
            return False
        trigger = SIMULATE_TRIGGER[kind]
        result = self._row_for(trigger)
        if result is None or result.reply == "REJECT":
            return False
        self._apply_internal(result, trigger, self._clock.monotonic_ms(), duration_ms)
        return not self._halted

    def auto_resume(self) -> bool:
        """Resumes a simulated robot that is BLOCKED and whose cause has cleared.

        Simulator only. Only a cleared cause resumes: a blocked robot whose cause is still present
        stays blocked, and so does any robot in another state.

        Returns:
            True when the robot resumed, False when it is not blocked or its cause is still there.

        Raises:
            ValueError: If the robot is not a simulator.
        """
        self._require_simulated("auto_resume")
        model = self._model
        if self._stopping or self._halted or model.state != "BLOCKED" or model.cause_pending:
            return False
        self._fire_internal("RESUME", self._clock.monotonic_ms())
        return not self._halted

    def begin_shutdown(self) -> None:
        """Starts a clean shutdown: the robot stops, and a stopping core drops most commands.

        The robot's speed and destination are cleared at once, and the tick keeps the robot still
        from then on. The state is left untouched on purpose: a shutdown is not a transition of the
        state machine, so it must not run the stop path of the table, nor the deadman or the
        e-stop latch. The goodbye is not built here; `build_goodbye` builds it when the runner is
        ready, so that its sequence number is the highest. Calling this again while stopping is
        harmless, and the stop is not logged twice.
        """
        self._model.speed = 0.0
        self._model.destination = None
        if not self._stopping:
            self._stopping = True
            self._log.log(logging.INFO, "agent.stopping")

    def build_goodbye(self) -> OutboundMessage | None:
        """Builds the `GOING_OFFLINE` announcement that ends a clean shutdown.

        The message takes its sequence number when it is built, so the runner calls this after the
        last message the core published, and the goodbye carries the highest number. It is
        published by the runner, not through the outbox, so the QoS 1 cap does not apply to it.

        Returns:
            The `GOING_OFFLINE` event, to publish as the last message, or None when it could not be
            built. The failure is logged as `message.build_failed`; the stop still happened.
        """
        try:
            return self._outbox.factory.going_offline()
        except MessageBuildError as err:
            self._log.log(
                logging.ERROR,
                "message.build_failed",
                label="GOING_OFFLINE",
                errorPaths=err.paths,
            )
            return None

    def halt(self, reason: str) -> None:
        """Stops the robot and refuses further work after an unexpected fault.

        The stop is applied without the transition table, because the table is what failed. The
        speed is zeroed and the destination cleared; the state is left as it was, and the runner
        then shuts the link down. Calling it again changes nothing.

        Args:
            reason: The name of the exception that caused the halt. It is logged, never the message.
        """
        if self._halted:
            return
        self._halted = True
        self._model.speed = 0.0
        self._model.destination = None
        self._log.log(logging.CRITICAL, "agent.halted", reason=reason)

    def snapshot(self) -> AgentSnapshot:
        """Returns the state the local video page and the tests read.

        Returns:
            A snapshot taken now.
        """
        state = self._model.state
        return AgentSnapshot(
            state=state,
            banner=banner_of(state),
            lock_held=self._lock.held,
            connected=self._outbox.connected,
            simulated=self._identity.simulated,
            boot_id=self._outbox.factory.boot_id,
            latch_persisted=self._announcer.latch_persisted,
            mission_id=self._model.mission_id,
        )

    def _run_command(self, screened: Screened) -> None:
        """Runs a screened command through the lock, the state machine and the effects.

        Every refusal and every acknowledgement is sent once. A silent heartbeat is never answered.
        A halt raised while the command runs sends no answer: the robot is then stopped and the
        runner shuts the link down. The steps run in the safety order: the lock, then the state
        machine, then the effects, then the answer and the announcements.

        Args:
            screened: The command that passed screening.
        """
        cmd = screened.command
        now = self._clock.monotonic_ms()
        holder = holder_of(cmd)
        if not self._enforce_lock(screened, holder, now):
            return
        trigger = trigger_of(cmd)
        result = self._decide(screened, trigger)
        if result is None:
            return
        self._commit(screened, trigger, result, holder, now)

    def _enforce_lock(self, screened: Screened, holder: LockHolder | None, now: int) -> bool:
        """Expires an idle lock, then checks that the command may act on the robot now.

        A lock-required command must come from the holder, and it feeds the deadman at the time the
        operator issued it. A take-control must name a holder who may take the lock. Expiry runs
        first, so a late operator cannot take a lock that has already lapsed by mistake.

        Args:
            screened: The command that passed screening.
            holder: The lock identity the command presents, if it carries a token.
            now: The current monotonic time, in milliseconds.

        Returns:
            True when the command may proceed. False when it was refused or the core halted.
        """
        cmd = screened.command
        if self._lock.is_idle_expired(now):
            self._expire_lock(now)
            if self._halted:
                return False
        if cmd.type in LOCK_REQUIRED_COMMANDS:
            if not self._lock.is_holder(cmd.lock_token, cmd.issued_by):
                self._refuse(refusal_for(screened, "LOCK", "NOT_LOCK_HOLDER"), logging.INFO)
                return False
            self._lock.touch(now)
            self._deadman.feed(issue_time_ms(screened, now))
        if cmd.type == "TAKE_CONTROL" and (holder is None or not self._lock.can_take(holder)):
            self._refuse(refusal_for(screened, "LOCK", "NOT_LOCK_HOLDER"), logging.INFO)
            return False
        return True

    def _decide(self, screened: Screened, trigger: Trigger) -> TransitionResult | None:
        """Asks the state machine what the trigger does in the current state.

        A broken table row on an e-stop stops the robot: an e-stop is never answered with a refusal.
        Any other broken row is refused as INVALID_STATE.

        Args:
            screened: The command that passed the lock check.
            trigger: The trigger the command raises.

        Returns:
            The transition to commit, or None when the command was refused or the core halted.

        Raises:
            TypeError: If a REJECT row carries no reason. The table never produces one, and the
                answer cannot be built without one, so the fault is raised to the runner.
        """
        cmd = screened.command
        try:
            result = transition(
                self._model.state,
                trigger,
                guards_for(self._model),
                self._model.resume_target,
            )
        except TypeError as err:
            if cmd.type == "ESTOP":
                self._stop_on_estop_fault(cmd.command_id, type(err).__name__)
            else:
                self._refuse(refusal_for(screened, "STATE", "INVALID_STATE"), logging.ERROR)
            return None
        if result.reply == "REJECT":
            reason = result.reason
            if reason is None:
                # A REJECT with no reason cannot be answered. The table never produces one, so it
                # is a fault in the table, and it is raised rather than answered with a guess.
                raise TypeError("a REJECT row carries no reason")
            self._refuse(refusal_for(screened, "STATE", reason), logging.INFO)
            return None
        return result

    def _commit(
        self,
        screened: Screened,
        trigger: Trigger,
        result: TransitionResult,
        holder: LockHolder | None,
        now: int,
    ) -> None:
        """Applies an accepted transition, then answers the command and announces what changed.

        An e-stop whose effects cannot be applied stops the robot; any other command is refused.

        Args:
            screened: The command that passed the lock check.
            trigger: The trigger the command raises.
            result: The accepted transition.
            holder: The lock identity the command presents, if it carries a token.
            now: The current monotonic time, in milliseconds.
        """
        cmd = screened.command
        effects = self._effects_for(cmd.type, result.effects)
        from_state = self._model.state
        try:
            outcome = self._apply(
                effects,
                trigger=trigger,
                now=now,
                command_id=cmd.command_id,
                holder=holder,
                fault_duration_ms=fault_duration_ms(cmd),
            )
        except EffectError:
            if cmd.type == "ESTOP":
                self._stop_on_estop_fault(cmd.command_id, "EffectError")
                return
            if "CLEAR_ESTOP_LATCH" in result.effects:
                self._log.log(logging.ERROR, "latch.clear_failed", commandId=cmd.command_id)
            self._refuse(refusal_for(screened, "STATE", "INVALID_STATE"), logging.ERROR)
            return
        self._model.state = result.to
        if cmd.type == "TAKE_CONTROL":
            self._deadman.feed(issue_time_ms(screened, now))
        if outcome.drop_link_ms is not None:
            self._schedule_suspend(outcome.drop_link_ms, now)
        if result.reply == "ACK":
            self._acknowledge(screened, outcome)
        self._announcer.transition(
            from_state=from_state,
            to_state=self._model.state,
            changed=result.changed,
            cause=trigger,
            command_id=cmd.command_id,
            outcome=outcome,
            holder_sub=holder.sub if holder is not None else None,
        )

    def _effects_for(self, command_type: str, effects: tuple[Effect, ...]) -> tuple[Effect, ...]:
        """Returns the effects to apply for an accepted command, retrying a failed e-stop latch.

        An e-stop in place writes nothing, because the table gives ESTOP-to-ESTOP no effect. When
        an earlier latch write failed, the robot is stopped in memory but not on disk, so the write
        is retried now, with this command as its cause.

        Args:
            command_type: The type of the command.
            effects: The effects the table returned for it.

        Returns:
            The effects to apply.
        """
        if (
            command_type == "ESTOP"
            and not self._announcer.latch_persisted
            and "LATCH_ESTOP" not in effects
        ):
            return ("LATCH_ESTOP",)
        return effects

    def _acknowledge(self, screened: Screened, outcome: EffectOutcome) -> None:
        """Acknowledges an accepted command, and drops the link once the ack is acknowledged.

        The link is dropped only once the ack is acknowledged, so the console learns of the fault
        before the link goes down. The deadline in `tick` covers a lost acknowledgement.

        Args:
            screened: The accepted command.
            outcome: What the effects changed, which says whether the link is to be dropped.
        """
        cmd = screened.command
        on_done = (lambda _outcome: self._suspend()) if outcome.drop_link_ms is not None else None
        self._outbox.send_ack(
            command_id=cmd.command_id,
            correlation_id=cmd.correlation_id,
            state=self._model.state,
            result="ACK",
            reason=None,
            on_done=on_done,
            priority=cmd.type == "ESTOP",
        )
        self._log.log(
            logging.INFO,
            "command.acked",
            commandId=cmd.command_id,
            correlationId=cmd.correlation_id,
            commandType=cmd.type,
            state=self._model.state,
        )

    def _stop_on_estop_fault(self, command_id: str, reason: str) -> None:
        """Stops and latches the robot when an e-stop cannot be processed by the table or effects.

        The e-stop is not answered: it must never be refused. The robot is stopped first, then the
        latch is written directly, because the effects are what failed. The core then halts.

        Args:
            command_id: The e-stop command, which is the latch's cause.
            reason: The name of the exception that caused the stop.
        """
        self._stop_in_place(command_id)
        self.halt(reason)

    def _estop_after_halt(self, screened: Screened) -> None:
        """Acts on an e-stop that arrives after a halt: stops, writes the latch, acknowledges.

        The table and the effects are not run, because a halt means they cannot be trusted. The
        core stays halted. The acknowledgement is best effort: the stop has already happened, so a
        transport error while acknowledging is logged and not raised, and the runner keeps going.

        Args:
            screened: The e-stop that passed screening.
        """
        cmd = screened.command
        self._stop_in_place(cmd.command_id)
        try:
            self._outbox.send_ack(
                command_id=cmd.command_id,
                correlation_id=cmd.correlation_id,
                state=self._model.state,
                result="ACK",
                reason=None,
                priority=True,
            )
        except Exception as err:
            self._log.log(
                logging.WARNING,
                "publish.failed",
                label="ACK",
                errorName=type(err).__name__,
            )

    def _stop_in_place(self, command_id: str) -> None:
        """Stops the robot in the ESTOP state and writes the latch, without going through the table.

        The state is set before the latch is written, so the robot reads as ESTOP whether or not the
        write succeeds. A failed write is reported by the announcer and does not stop the stop.

        Args:
            command_id: The e-stop command, which is the latch's cause.
        """
        model = self._model
        model.speed = 0.0
        model.destination = None
        model.state = "ESTOP"
        # This path bypasses the table, so the origin is unknown: the release must go to PAUSED.
        model.estop_from_idle = False
        record = LatchRecord(
            command_id=command_id,
            boot_id=self._outbox.factory.boot_id,
            latched_at=format_iso_ms(self._clock.wall_ms()),
        )
        try:
            self._latch.set(record)
        except LatchWriteError:
            self._announcer.latch("SET_FAILED", command_id)
        else:
            self._announcer.latch("SET", command_id)

    def _row_for(self, trigger: Trigger) -> TransitionResult | None:
        """Looks up what the table does with a trigger in the robot's current state.

        A table row that is ambiguous or missing means the model and the table disagree. That is a
        fault in the core, so the core halts rather than guessing a state.

        Args:
            trigger: The trigger to look up.

        Returns:
            The transition, or None when the table has no single row, in which case the core halted.
        """
        model = self._model
        try:
            return transition(model.state, trigger, guards_for(model), model.resume_target)
        except TypeError as err:
            self.halt(type(err).__name__)
            return None

    def _fire_internal(
        self, trigger: Trigger, now: int, fault_duration_ms: int | None = None
    ) -> None:
        """Applies a trigger the robot raises itself: its own event, never acknowledged.

        The simulator's hooks raise the simulated faults and the `RESUME` through here too, so they
        follow the same table and effects as a command; only the answer is skipped.

        An arrival clears the destination, which was reached: a stale one would otherwise guard the
        rows of a later state. An effect that cannot be applied halts the core, as a bad row does.

        Args:
            trigger: The trigger raised by the robot.
            now: The monotonic time of the event, in milliseconds.
            fault_duration_ms: The duration a simulated fault asked for, None for the default.
        """
        if self._halted:
            return
        result = self._row_for(trigger)
        if result is None:
            return
        self._apply_internal(result, trigger, now, fault_duration_ms)

    def _apply_internal(
        self,
        result: TransitionResult,
        trigger: Trigger,
        now: int,
        fault_duration_ms: int | None,
    ) -> None:
        """Applies an accepted transition the robot raised itself, then announces it.

        Args:
            result: The transition the table returned for the trigger in the current state.
            trigger: The trigger raised by the robot.
            now: The monotonic time of the event, in milliseconds.
            fault_duration_ms: The duration a simulated fault asked for, None for the default.
        """
        model = self._model
        from_state = model.state
        try:
            outcome = self._apply(
                result.effects,
                trigger=trigger,
                now=now,
                command_id=None,
                holder=None,
                fault_duration_ms=fault_duration_ms,
            )
        except EffectError:
            self.halt("EffectError")
            return
        model.state = result.to
        if trigger == "ARRIVED":
            model.destination = None
        if outcome.drop_link_ms is not None:
            # An internal trigger is never acknowledged, so there is no PUBACK to wait for: the
            # drop waits the full grace period, the same bound a command's drop has when its ACK is
            # lost. Dropping earlier would cut the link before the state change that caused it.
            self._schedule_suspend(outcome.drop_link_ms, now)
        self._announcer.transition(
            from_state=from_state,
            to_state=model.state,
            changed=result.changed,
            cause=trigger,
            command_id=None,
            outcome=outcome,
            holder_sub=None,
        )

    def _expire_lock(self, now: int) -> None:
        """Releases an idle lock, tells the console, and moves a teleoperated robot to PAUSED.

        Args:
            now: The current monotonic time, in milliseconds.
        """
        self._lock.expire()
        self._announcer.lock("EXPIRED", None)
        self._fire_internal("LOCK_EXPIRED", now)

    def _check_deadman(self, now: int) -> None:
        """Stops a robot that was driven and whose operator has gone silent.

        Args:
            now: The current monotonic time, in milliseconds.
        """
        if not self._deadman.expired(now, lock_held=self._lock.held, state=self._model.state):
            return
        last_feed = self._deadman.last_feed_ms
        self._log.log(
            logging.WARNING,
            "deadman.expired",
            sinceMs=None if last_feed is None else now - last_feed,
        )
        self._fire_internal("DEADMAN_EXPIRED", now)

    def _check_fault_timer(self, now: int) -> None:
        """Clears a simulated fault whose duration has elapsed.

        A blocked robot clears the cause through the table, so it stays blocked until RESUME. Any
        other state only loses the stale cause, without a state change.

        Args:
            now: The current monotonic time, in milliseconds.
        """
        model = self._model
        due = model.cause_clear_at_ms
        if not model.cause_pending or due is None or now < due:
            return
        if model.state == "BLOCKED":
            self._fire_internal("CAUSE_CLEARED", now)
            return
        effects: tuple[Effect, ...] = ("CLEAR_CAUSE",)
        outcome = self._apply(
            effects,
            trigger="CAUSE_CLEARED",
            now=now,
            command_id=None,
            holder=None,
            fault_duration_ms=None,
        )
        self._announcer.faults(outcome)

    def _step_motion(self, now: int, dt: int) -> None:
        """Moves a robot in MOVING towards its next waypoint; any other state is stationary.

        The navigator gives the waypoint. Without one the robot holds position at zero speed and
        stays MOVING. An intermediate waypoint is passed on without an arrival; only the final one
        is an arrival. The speed brakes for the destination, not for the waypoint, so a bend on the
        way does not slow the robot to creep. A stopping robot never moves: `begin_shutdown` zeroes
        its speed, and this keeps it at zero.

        Args:
            now: The current monotonic time, in milliseconds.
            dt: The capped time step, in milliseconds.
        """
        model = self._model
        destination = model.destination
        if self._stopping or model.state != "MOVING" or destination is None:
            model.speed = 0.0
            return
        waypoint = self._navigator.next_waypoint(model.x, model.y, destination)
        if waypoint is None:
            model.speed = 0.0
            return
        target = waypoint.point
        to_destination = math.hypot(destination.point.x - model.x, destination.point.y - model.y)
        speed = next_speed(model.speed, self._geometry.speed_mps, ACCEL_MPS2, to_destination, dt)
        x, y, heading, arrived = step_towards(model.x, model.y, target, speed, dt)
        model.x = x
        model.y = y
        model.heading = heading
        model.speed = speed
        if not arrived:
            return
        if not waypoint.final:
            self._navigator.reached(waypoint)
            return
        model.speed = 0.0
        self._fire_internal("ARRIVED", now)

    def _require_simulated(self, name: str) -> None:
        """Refuses a simulator-only call on a real robot, before anything changes.

        It raises rather than returning False, so a caller cannot ignore the refusal and carry on
        as if the robot had accepted it.

        Args:
            name: The name of the method. Fixed text, never a runtime value.

        Raises:
            ValueError: If the robot is not a simulator.
        """
        if not self._identity.simulated:
            raise ValueError(f"{name} is available on a simulated robot only")

    def _step_battery(self, now: int, dt: int) -> None:
        """Drains or charges the battery, and raises the low-battery fault once when it crosses.

        Args:
            now: The current monotonic time, in milliseconds.
            dt: The capped time step, in milliseconds.
        """
        model = self._model
        model.battery = battery_after(
            model.battery, state=model.state, moving=model.speed > 0, dt_ms=dt
        )
        if model.battery < BATTERY_LOW_PERCENT and not model.battery_low_active:
            model.battery_low_active = True
            self._announcer.fault_raised("BATTERY_LOW")
            self._fire_internal("BATTERY_LOW", now)
        if model.state == "CHARGING" and model.battery >= _FULL_CHARGE_PERCENT:
            self._fire_internal("CHARGED", now)
            if model.battery_low_active:
                model.battery_low_active = False
                self._announcer.fault_cleared("BATTERY_LOW")

    def _schedule_suspend(self, duration_ms: int, now: int) -> None:
        """Arranges to drop the link after the DROP_LINK ack, or after the grace period at most.

        Args:
            duration_ms: How long the link stays down, in milliseconds.
            now: The current monotonic time, in milliseconds.
        """
        self._pending_suspend_ms = duration_ms
        self._suspend_deadline_ms = now + DROP_LINK_ACK_GRACE_MS

    def _suspend(self) -> None:
        """Drops the link on purpose, once. A second call finds nothing pending and does nothing."""
        duration = self._pending_suspend_ms
        if duration is None:
            return
        self._pending_suspend_ms = None
        self._suspend_deadline_ms = None
        self._log.log(logging.INFO, "link.suspended", durationMs=duration)
        self._transport.suspend(duration)

    def _refuse(self, refused: Refused, level: int) -> None:
        """Answers a refused command with a REJECT, or stays silent for a heartbeat.

        Args:
            refused: The refusal, with the identifiers of the command.
            level: The log level of the refusal line.
        """
        if refused.silent:
            self._log.log_throttled(
                "heartbeat.refused",
                logging.WARNING,
                "heartbeat.refused",
                stage=refused.stage,
                reason=refused.reason,
                commandId=refused.command_id,
            )
            return
        self._outbox.send_ack(
            command_id=refused.command_id,
            correlation_id=refused.correlation_id,
            state=self._model.state,
            result="REJECT",
            reason=refused.reason,
        )
        self._log.log(
            level,
            "command.rejected",
            commandId=refused.command_id,
            correlationId=refused.correlation_id,
            commandType=refused.command_type,
            stage=refused.stage,
            reason=refused.reason,
            errorPaths=refused.error_paths or None,
            ageMs=refused.age_ms,
        )

    def _apply(
        self,
        effects: tuple[Effect, ...],
        *,
        trigger: Trigger,
        now: int,
        command_id: str | None,
        holder: LockHolder | None,
        fault_duration_ms: int | None,
    ) -> EffectOutcome:
        """Applies the effects of an accepted transition to the model, the lock and the latch.

        Args:
            effects: The effects the table returned.
            trigger: The trigger that was accepted.
            now: The monotonic time, in milliseconds.
            command_id: The command that raised the trigger, None for an internal trigger.
            holder: The lock identity of the command, if it acquires the lock.
            fault_duration_ms: The duration a simulated fault asked for, if any.

        Returns:
            What changed, for the caller to publish.

        Raises:
            EffectError: If an effect cannot be applied. Nothing was changed.
        """
        context = EffectContext(
            trigger=trigger,
            origin=self._model.state,
            now_ms=now,
            boot_id=self._outbox.factory.boot_id,
            command_id=command_id,
            holder=holder,
            fault_duration_ms=fault_duration_ms,
            wall_iso=format_iso_ms(self._clock.wall_ms()),
        )
        return apply_effects(effects, self._model, self._lock, self._latch, self._geometry, context)
