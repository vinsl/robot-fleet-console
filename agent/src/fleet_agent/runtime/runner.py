"""The agent's run loop: boots the core, ticks it, and shuts it down cleanly on a stop or a fault.

The core is never called from anywhere it is not guarded. Every entry point that reaches it goes
through a `FaultGate`: the tick, the transport's listener calls, and the completion of every
publish and subscribe the core asked for. An unexpected exception in any of them halts the core,
which stops the robot and refuses further work, and the run then shuts down gracefully with exit
code 70. A loop-level exception is handled the same way, and its message is never logged, because
a message can quote a topic or a payload.

Shutdown is ordered for the console. The core is told to stop first, and its `GOING_OFFLINE`
announcement is built last, so that it carries the highest sequence number. The gate stays open
after the goodbye, so an e-stop that arrives while the link is still up is latched and acknowledged
by the core, which drops everything else while stopping. The gate closes just before the transport
disconnects, so nothing feeds the core once the link is going down. The first signal asks for a
graceful stop, and a second one exits at once with code 130, after the core has begun its stop.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.metadata
import logging
import signal
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Protocol, TypeVar

from fleet_agent.adapters.latch_file import FileLatchStore
from fleet_agent.adapters.mqtt_crt import build_crt_transport
from fleet_agent.adapters.system_clock import SystemClock
from fleet_agent.config.kit_file import KitError, LoadedKit, load_kit, log_kit_refusal
from fleet_agent.config.settings import AgentSettings, geometry_of
from fleet_agent.core.agent import AgentCore
from fleet_agent.core.constants import TICK_INTERVAL_MS
from fleet_agent.core.identity import AgentIdentity
from fleet_agent.core.messages import OutboundMessage
from fleet_agent.core.ports import (
    Clock,
    LatchUnreadableError,
    Link,
    Navigator,
    PublishOutcome,
    QoS,
    SubscribeOutcome,
    Transport,
    TransportFactory,
)
from fleet_agent.core.snapshot import AgentSnapshot
from fleet_agent.logs import safe_traceback

EXIT_OK: Final = 0
"""A requested stop completed cleanly."""

EXIT_SOFTWARE: Final = 70
"""The core halted on an unexpected fault. The robot was stopped and the link closed."""

EXIT_CONFIG: Final = 78
"""The kit, the settings or the e-stop latch cannot be used, so the agent never started."""

EXIT_FORCED: Final = 130
"""A second stop signal arrived, so the agent exited without waiting for its shutdown."""

GOODBYE_WAIT_S: Final = 2.0
"""How long the shutdown waits for the broker to acknowledge the goodbye."""

TRANSPORT_STOP_S: Final = 3.0
"""How long the shutdown waits for the broker to confirm the clean disconnect."""

SERVICE_STOP_S: Final = 3.0
"""How long the shutdown waits for one side service to stop. A service that overruns is a fault."""

_LOG: Final = logging.getLogger("fleet_agent.runtime")
_GOING_OFFLINE_LABEL: Final = "GOING_OFFLINE"
_TIMEOUT_OUTCOME: Final = "TIMEOUT"

_T = TypeVar("_T")


class RuntimeService(Protocol):
    """A side service that runs beside the core, such as the local video page."""

    async def start(self) -> None:
        """Starts the service. The run waits for it before the first tick."""
        ...

    async def stop(self) -> None:
        """Stops the service. The run waits for it before the transport disconnects."""
        ...


@dataclass(frozen=True, slots=True)
class ServiceContext:
    """What a side service is built from: the loaded kit, and a read-only view of the core.

    The snapshot is read through the gate, so it returns None once the core no longer runs. A
    service never receives the core itself, so it has no path to a command.

    Attributes:
        kit: The loaded kit of the robot.
        snapshot: Reads the core's state, or returns None when the core no longer runs.
    """

    kit: LoadedKit
    snapshot: Callable[[], AgentSnapshot | None]


ServiceFactory = Callable[[ServiceContext], Sequence[RuntimeService]]
"""Builds the side services of a run once the core has booted. It returns none to run without."""


class UnreportedLoopError(Exception):
    """A loop error reported without an exception object. Only its type name is ever logged."""


class FaultGate:
    """Runs every entry point that reaches the core, and halts the core on an unexpected exception.

    The gate is created before the core, because the core is wired to a transport that already
    routes its completions through the gate. The core is bound afterwards, before any callback can
    arrive. Once closed, the gate feeds the core nothing, which is how a shutdown ends the core's
    part of the run.
    """

    def __init__(self) -> None:
        """Creates an unbound, open gate."""
        self._core: AgentCore | None = None
        self._closed = False

    def bind(self, core: AgentCore) -> None:
        """Binds the core that a fault halts.

        Args:
            core: The core the gate protects.
        """
        self._core = core

    def close(self) -> None:
        """Stops feeding the core. Calls after this do nothing and return the default."""
        self._closed = True

    def call(self, action: Callable[[], _T], default: _T) -> _T:
        """Runs one action on the core, halting the core and returning the default on a fault.

        Args:
            action: The core call to run.
            default: The value returned when the gate is closed or the action faults.

        Returns:
            The action's result, or the default.
        """
        if self._closed:
            return default
        try:
            return action()
        except Exception as err:
            self.fault(err)
            return default

    def run(self, action: Callable[[], None]) -> None:
        """Runs one action on the core, halting the core on a fault.

        Args:
            action: The core call to run.
        """
        self.call(action, None)

    def wrap(self, action: Callable[[_T], None]) -> Callable[[_T], None]:
        """Wraps a completion callback so that a fault in it halts the core.

        Args:
            action: The callback to wrap, typically the core's `on_done`.

        Returns:
            A callback with the same signature, guarded by this gate.
        """

        def guarded(value: _T) -> None:
            """Runs the wrapped callback under the gate.

            Args:
                value: The outcome handed to the callback.
            """
            self.run(lambda: action(value))

        return guarded

    def fault(self, err: BaseException) -> None:
        """Halts the core after an unexpected exception, and logs its type and frames.

        The core's halt writes `agent.halted`, with the reason. This gate writes `agent.fault`
        instead, with the same reason and the frames that locate the fault, so each fault is
        reported by one halt line and one fault line. The exception message is never logged,
        since it can quote a topic or a payload.

        Args:
            err: The exception that escaped.

        Raises:
            RuntimeError: If the gate was never bound to a core, which is a wiring error.
        """
        if self._core is None:
            raise RuntimeError("the fault gate is not bound to a core")
        reason = type(err).__name__
        self._core.halt(reason)
        _LOG.critical(
            "agent.fault",
            extra={"reason": reason, "traceback": safe_traceback(err)},
        )

    def on_loop_error(
        self,
        _loop: asyncio.AbstractEventLoop,
        context: Mapping[str, object],
    ) -> None:
        """Handles an exception the event loop could not deliver to a caller, by halting.

        The default loop handler would log the exception message and the arguments, which can
        quote a payload. This handler logs the type and the frames only.

        Args:
            _loop: The loop that reports the error. Unused.
            context: The loop's error context. Its `exception` entry is the error, when one exists.
        """
        exc = context.get("exception")
        self.fault(exc if isinstance(exc, BaseException) else UnreportedLoopError())


class GuardedTransport:
    """The link as the core sees it: its completions reach the core only through the gate.

    The core publishes, subscribes and suspends through this object, which is the `Link` port. The
    runner keeps the real transport for its lifecycle calls, so this object has no lifecycle.
    """

    def __init__(self, inner: Link, gate: FaultGate) -> None:
        """Wraps a link.

        Args:
            inner: The real transport, used through the link port only.
            gate: The gate that guards the completions.
        """
        self._inner = inner
        self._gate = gate

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Publishes, guarding the completion callback when there is one.

        Args:
            topic: The full topic.
            payload: The serialised message.
            qos: The quality of service to request.
            on_done: The completion callback, if any.
        """
        guarded = None if on_done is None else self._gate.wrap(on_done)
        self._inner.publish(topic, payload, qos, guarded)

    def subscribe(self, topic_filter: str, on_done: Callable[[SubscribeOutcome], None]) -> None:
        """Subscribes, guarding the completion callback.

        Args:
            topic_filter: The filter to subscribe to.
            on_done: The completion callback.
        """
        self._inner.subscribe(topic_filter, self._gate.wrap(on_done))

    def suspend(self, duration_ms: int) -> None:
        """Delegates to the real transport.

        Args:
            duration_ms: How long the link stays down.
        """
        self._inner.suspend(duration_ms)


class GuardedListener:
    """The listener the transport calls. Each event reaches the core through the gate."""

    def __init__(self, core: AgentCore, gate: FaultGate) -> None:
        """Binds the listener to the core it feeds.

        Args:
            core: The core that receives the events.
            gate: The gate that guards each call.
        """
        self._core = core
        self._gate = gate

    def on_connected(self) -> None:
        """Forwards a connection to the core, guarded."""
        self._gate.run(self._core.on_connected)

    def on_disconnected(self, error_name: str | None, reason_code: int | None) -> None:
        """Forwards a lost connection to the core, guarded.

        Args:
            error_name: The local error class name, if any.
            reason_code: The DISCONNECT reason code, if any.
        """
        self._gate.run(lambda: self._core.on_disconnected(error_name, reason_code))

    def on_connect_failed(self, error_name: str | None, reason_code: int | None) -> None:
        """Forwards a failed attempt to the core, guarded.

        Args:
            error_name: The local error class name, if any.
            reason_code: The CONNACK reason code, if any.
        """
        self._gate.run(lambda: self._core.on_connect_failed(error_name, reason_code))

    def on_message(self, topic: str, payload: bytes) -> None:
        """Forwards an inbound message to the core, guarded.

        Args:
            topic: The topic the message arrived on.
            payload: The raw payload, untrusted.
        """
        self._gate.run(lambda: self._core.on_message(topic, payload))


TickHook = Callable[[AgentCore, int], None]
"""A callback run after every tick of a core: the core and the index of the tick, from zero."""


@dataclass(slots=True)
class RunControls:
    """Hooks a caller of `run_agent` uses to drive one robot from outside its own loop.

    The simulator is the only user: it runs many robots in one process, owns the signals itself,
    and drives missions and faults through `on_tick`. A real robot runs with the defaults.

    Attributes:
        install_signals: Whether the run installs the SIGTERM and SIGINT handlers.
        on_tick: Called after every tick of the core, through the fault gate. It may call the
            simulator-only methods of the core; on a real robot those raise, which halts it.
        navigator: Routes the robot toward its destination. The simulator passes a grid navigator;
            `None` keeps the straight-line default.
        runtime: The runtime of the run, set by `run_agent` once it has built it, so the caller can
            call `request_stop`. It stays None until then, and when the run ends before it is built
            (a refused kit, an unreadable latch, a failed boot): the caller must not use it then.
    """

    install_signals: bool = True
    on_tick: TickHook | None = None
    navigator: Navigator | None = None
    runtime: AgentRuntime | None = None


class AgentRuntime:
    """Ticks the core until a stop or a halt, then shuts down and returns the exit code.

    The first `request_stop` begins a graceful shutdown. A second one forces an exit at once,
    without waiting for the goodbye or the disconnect, but only after the core has begun its stop.
    """

    def __init__(
        self,
        core: AgentCore,
        transport: Transport,
        *,
        gate: FaultGate,
        tick_interval_ms: int = TICK_INTERVAL_MS,
        services: Sequence[RuntimeService] = (),
        install_signals: bool = True,
        on_tick: TickHook | None = None,
    ) -> None:
        """Creates a runtime over a bound core.

        Args:
            core: The core, already booted, whose transport is guarded by `gate`.
            transport: The real transport, used for the lifecycle calls.
            gate: The gate the core and the listener are guarded by.
            tick_interval_ms: The time between two ticks, in milliseconds.
            services: Side services to start before the first tick and stop at shutdown.
            install_signals: Whether the run owns SIGTERM and SIGINT. A fleet that runs several
                robots in one process owns them itself, so it passes False.
            on_tick: Called after every tick of the core, through the gate, with the core and the
                index of the tick. It is skipped once the core has halted.

        Raises:
            ValueError: If the tick interval is below 1 ms.
        """
        if tick_interval_ms < 1:
            raise ValueError("the tick interval must be at least 1 ms")
        self._core = core
        self._transport = transport
        self._gate = gate
        self._tick_s = tick_interval_ms / 1000
        self._services = tuple(services)
        self._started: list[RuntimeService] = []
        self._stop_requested = asyncio.Event()
        self._forced = asyncio.Event()
        self._install_signals = install_signals
        self._on_tick = on_tick
        self._ticks = 0

    def request_stop(self) -> None:
        """Asks the run to stop. The first call is graceful; a second call forces the exit."""
        if self._stop_requested.is_set():
            self._forced.set()
        self._stop_requested.set()

    async def run(self) -> int:
        """Runs until a stop or a halt, installs the signal and loop handlers, and returns the code.

        The handlers are removed on the way out, so the process does not keep the runner's
        behaviour after the run ends.

        Returns:
            The exit code: 0 for a requested stop, 70 when the core halted, 130 when forced.
        """
        loop = asyncio.get_running_loop()
        previous = loop.get_exception_handler()
        loop.set_exception_handler(self._gate.on_loop_error)
        if self._install_signals:
            loop.add_signal_handler(signal.SIGTERM, self.request_stop)
            loop.add_signal_handler(signal.SIGINT, self.request_stop)
        try:
            return await self._serve()
        finally:
            if self._install_signals:
                loop.remove_signal_handler(signal.SIGTERM)
                loop.remove_signal_handler(signal.SIGINT)
            loop.set_exception_handler(previous)

    async def _serve(self) -> int:
        """Starts the services, ticks the core until it must stop, then shuts down.

        A service that fails to start halts the core, and the run then shuts down what did start,
        so the exit code is 70 and the robot is left stopped.

        Returns:
            The exit code of the run.
        """
        try:
            await self._start_services()
        except Exception as err:
            self._gate.fault(err)
            return await self._shut_down_or_force()
        while not self._should_exit():
            self._gate.run(self._tick)
            await _pause(self._stop_requested, self._tick_s)
        if self._forced.is_set():
            return self._force()
        return await self._shut_down_or_force()

    def _tick(self) -> None:
        """Ticks the core once, then runs the hook of the controls when the core is still running.

        The hook runs through the same gate as the tick, so a fault in it halts this robot only.

        Raises:
            Exception: Whatever the core tick or the hook raises; the gate turns it into a halt.
        """
        self._core.tick()
        index = self._ticks
        self._ticks += 1
        if self._on_tick is not None and not self._core.halted:
            self._on_tick(self._core, index)

    async def _start_services(self) -> None:
        """Starts the services in order, and records each one that started.

        The services run in this loop, so a service that blocks its start blocks the run. A side
        service must therefore return from `start` at once and do its I/O in its own tasks, as the
        local video page does, so that it cannot hold the tick.
        """
        for service in self._services:
            await service.start()
            self._started.append(service)

    def _should_exit(self) -> bool:
        """Tells whether the tick loop must end: a stop, a halt or a forced exit.

        Returns:
            True when the loop must not tick again.
        """
        return self._stop_requested.is_set() or self._core.halted or self._forced.is_set()

    def _force(self) -> int:
        """Begins the core's stop without waiting, then returns the forced exit code.

        The core's stop is synchronous and cheap, so it runs before the exit: the robot is still
        stopped and the e-stop latch is not touched, even though the goodbye is not sent.

        Returns:
            130, the code of a forced exit.
        """
        self._gate.call(self._core.begin_shutdown, None)
        return EXIT_FORCED

    async def _shut_down_or_force(self) -> int:
        """Runs the shutdown, unless a second signal arrives first, which exits at once.

        Returns:
            The exit code: 130 when forced, otherwise the code of the stopped run.
        """
        shutdown = asyncio.create_task(self._shut_down())
        forced = asyncio.create_task(self._forced.wait())
        try:
            await asyncio.wait({shutdown, forced}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            forced.cancel()
        if self._forced.is_set():
            shutdown.cancel()
            return self._force()
        await shutdown
        return self._exit_code()

    async def _shut_down(self) -> None:
        """Begins the core's stop, sends the goodbye last, then stops the services and the link.

        The goodbye is built after `begin_shutdown`, so its sequence number is the highest. The
        gate stays open until the services have stopped, so an e-stop is still latched and
        acknowledged; it closes just before the transport disconnects.
        """
        self._gate.call(self._core.begin_shutdown, None)
        goodbye = self._gate.call(self._core.build_goodbye, None)
        if goodbye is not None:
            await self._publish_goodbye(goodbye)
        await self._stop_services()
        self._gate.close()
        await _disconnect(self._transport)
        _LOG.info("agent.stopped", extra={"exitCode": self._exit_code()})

    async def _publish_goodbye(self, goodbye: OutboundMessage) -> None:
        """Publishes the goodbye and waits briefly for the broker to acknowledge it.

        A missing acknowledgement is logged and does not hold the shutdown longer than the wait.

        Args:
            goodbye: The `GOING_OFFLINE` announcement to publish.
        """
        settled: asyncio.Future[PublishOutcome] = asyncio.get_running_loop().create_future()
        self._transport.publish(
            goodbye.topic,
            goodbye.payload,
            goodbye.qos,
            lambda outcome: _settle(settled, outcome),
        )
        try:
            outcome = await asyncio.wait_for(settled, timeout=GOODBYE_WAIT_S)
        except TimeoutError:
            _LOG.warning(
                "publish.failed",
                extra={"label": _GOING_OFFLINE_LABEL, "outcome": _TIMEOUT_OUTCOME},
            )
            return
        if outcome.status != "OK":
            _LOG.warning(
                "publish.failed",
                extra={
                    "label": _GOING_OFFLINE_LABEL,
                    "outcome": outcome.status,
                    "reasonCode": outcome.reason_code,
                    "errorName": outcome.error_name,
                },
            )

    async def _stop_services(self) -> None:
        """Stops the started services in reverse start order, each within its own bound.

        A service that fails or overruns its bound halts the core, and the stop goes on with the
        next service, so one bad service cannot keep the others running.
        """
        for service in reversed(self._started):
            try:
                await asyncio.wait_for(service.stop(), timeout=SERVICE_STOP_S)
            except Exception as err:
                self._gate.fault(err)

    def _exit_code(self) -> int:
        """Returns the exit code of a run that is ending by a stop or a halt.

        Returns:
            70 when the core halted, otherwise 0.
        """
        return EXIT_SOFTWARE if self._core.halted else EXIT_OK


async def run_agent(
    settings: AgentSettings,
    *,
    transport_factory: TransportFactory = build_crt_transport,
    clock: Clock | None = None,
    services: Sequence[RuntimeService] = (),
    service_factory: ServiceFactory | None = None,
    controls: RunControls | None = None,
) -> int:
    """Loads the kit, boots the core, connects, and runs until a stop or a halt.

    A refused kit, a transport the kit cannot build, or an unreadable latch ends the run with
    exit code 78 before the robot moves or connects. Any other failure while the core boots, the
    services are built or the link starts halts the run with exit code 70, after stopping what
    was started.

    Args:
        settings: The validated settings of the run.
        transport_factory: Builds the transport. Tests pass a fake.
        clock: The time source. Defaults to the system clock.
        services: Side services to run beside the core.
        service_factory: Builds more side services once the core has booted, from the kit and a
            read-only view of the core. They run after `services`.
        controls: Hooks for a simulator: signal ownership, a per-tick callback and the runtime
            handle. None keeps the single-robot behaviour: the run owns the signals.

    Returns:
        The exit code of the run.

    Raises:
        ValueError: If the controls carry a per-tick hook or a navigator for a robot whose kit is
            not simulated. Both are simulator hooks, so the run refuses the mismatch before any
            transport is built: it is a wiring error, not a robot fault.
    """
    loop = asyncio.get_running_loop()
    try:
        kit = load_kit(settings.kit_root, settings.robot_id)
    except KitError as err:
        log_kit_refusal(err)
        return EXIT_CONFIG
    if (
        controls is not None
        and not kit.config.simulated
        and (controls.on_tick is not None or controls.navigator is not None)
    ):
        raise ValueError(
            "a per-tick hook and a navigator are simulator hooks: the kit is not simulated"
        )
    latch = FileLatchStore(kit.kit_dir)
    try:
        raw = transport_factory(kit, settings.mqtt_port, loop)
    except KitError as err:
        log_kit_refusal(err)
        return EXIT_CONFIG
    gate = FaultGate()
    core = AgentCore(
        identity=_identity_of(kit),
        geometry=geometry_of(settings),
        battery_start=settings.battery_start,
        clock=clock if clock is not None else SystemClock(),
        transport=GuardedTransport(raw, gate),
        latch=latch,
        navigator=controls.navigator if controls is not None else None,
    )
    gate.bind(core)
    try:
        core.boot()
    except LatchUnreadableError:
        _LOG.error("latch.unreadable")
        return EXIT_CONFIG
    except Exception as err:
        gate.fault(err)
        return EXIT_SOFTWARE
    if service_factory is not None:
        try:
            built = service_factory(
                ServiceContext(kit=kit, snapshot=lambda: gate.call(core.snapshot, None)),
            )
        except Exception as err:
            gate.fault(err)
            return EXIT_SOFTWARE
        services = (*services, *built)
    raw.set_listener(GuardedListener(core, gate))
    try:
        raw.start()
    except Exception as err:
        gate.fault(err)
        await _disconnect(raw)
        return EXIT_SOFTWARE
    runtime = AgentRuntime(
        core,
        raw,
        gate=gate,
        services=services,
        install_signals=controls.install_signals if controls is not None else True,
        on_tick=controls.on_tick if controls is not None else None,
    )
    if controls is not None:
        controls.runtime = runtime
    return await runtime.run()


def _identity_of(kit: LoadedKit) -> AgentIdentity:
    """Builds the core's identity from the kit, with the installed agent version.

    Args:
        kit: The loaded kit.

    Returns:
        The identity of the robot.
    """
    config = kit.config
    return AgentIdentity(
        robot_id=config.robot_id,
        site_id=config.site_id,
        thing_name=config.thing_name,
        simulated=config.simulated,
        agent_version=importlib.metadata.version("fleet-agent"),
    )


async def _pause(stop: asyncio.Event, seconds: float) -> None:
    """Sleeps for one tick, or returns at once when a stop is requested.

    Args:
        stop: The event that a stop request sets.
        seconds: The longest time to sleep, in seconds.
    """
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(stop.wait(), timeout=seconds)


async def _disconnect(transport: Transport) -> None:
    """Disconnects cleanly. A failure to disconnect is logged; the process exits either way.

    The disconnect is a normal one, so the broker reports a client-initiated disconnection and
    not a lost link.

    Args:
        transport: The transport to stop.
    """
    try:
        await transport.stop(TRANSPORT_STOP_S)
    except Exception as err:
        _LOG.warning("link.lost", extra={"errorName": type(err).__name__})


def _settle(future: asyncio.Future[PublishOutcome], outcome: PublishOutcome) -> None:
    """Resolves the goodbye's future once. A future that was cancelled by a timeout is left alone.

    Args:
        future: The future to resolve.
        outcome: The outcome the transport reported.
    """
    if not future.done():
        future.set_result(outcome)
