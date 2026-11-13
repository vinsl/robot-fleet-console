"""Tests of the run loop: shutdown order, the halt guard, exit codes and the stop signals."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

from fleet_agent.adapters.latch_file import LATCH_FILE_NAME
from fleet_agent.config.kit_file import KitError, LoadedKit
from fleet_agent.config.settings import AgentSettings, load_settings
from fleet_agent.core.agent import AgentCore
from fleet_agent.core.identity import AgentIdentity
from fleet_agent.core.navigation import StraightLineNavigator
from fleet_agent.core.ports import PublishOutcome, PublishStatus, QoS, SubscribeOutcome
from fleet_agent.protocol.topics import command_topic
from fleet_agent.runtime import runner
from fleet_agent.runtime.runner import (
    EXIT_CONFIG,
    EXIT_FORCED,
    EXIT_OK,
    EXIT_SOFTWARE,
    AgentRuntime,
    FaultGate,
    GuardedListener,
    GuardedTransport,
    RunControls,
    RuntimeService,
    run_agent,
)
from fleet_agent.video.service import LocalVideoService
from tests.core.fakes import (
    COMMAND_TOPIC,
    ROBOT_ID,
    SITE,
    SITE_ID,
    FakeClock,
    FakeTransport,
    MemoryLatchStore,
    encode,
    labels,
    make_command,
)
from tests.kit_fixtures import write_kit

SECRET = "SECRET-PAYLOAD-7f3a"  # noqa: S105 - a fixed marker in a log leak check, not a credential
"""A value no log line may ever carry. A test that finds it in a record has found a leak."""


class RunnerTransport(FakeTransport):
    """A fake transport that acknowledges publishes by itself, and records the stop.

    Attributes:
        ack: The status every publish is acknowledged with, or None to leave them pending.
        started: How many times the transport was started.
        stops: The timeout of every stop call.
        events: The order of the stop calls and of any service events sharing this list.
        stop_error: When set, the stop raises it, after recording the call.
        start_error: When set, the start raises it, after recording the call.
        stop_gate: When set, the stop waits for it, which keeps a shutdown in progress.
        during_stop: When set, runs at the start of the stop, to play a late inbound message.
        after_publish: When set, runs after every publish is recorded, with its topic.
    """

    def __init__(self, *, ack: PublishStatus | None = "OK") -> None:
        """Creates the transport.

        Args:
            ack: The status every publish is acknowledged with, or None for no acknowledgement.
        """
        super().__init__()
        self.ack = ack
        self.started = 0
        self.stops: list[float] = []
        self.events: list[str] = []
        self.stop_error: Exception | None = None
        self.start_error: Exception | None = None
        self.stop_gate: asyncio.Event | None = None
        self.during_stop: Callable[[], None] | None = None
        self.after_publish: Callable[[str], None] | None = None

    def start(self) -> None:
        """Counts the start, which the run performs once the core booted.

        Raises:
            Exception: The configured start error, when one is set, after counting the start.
        """
        self.started += 1
        if self.start_error is not None:
            raise self.start_error

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Records the publish and acknowledges it on the next loop iteration, if asked to.

        Args:
            topic: The topic published on.
            payload: The serialised message.
            qos: The quality of service.
            on_done: The completion callback, if any.
        """
        super().publish(topic, payload, qos, on_done)
        if on_done is not None and self.ack is not None:
            index = len(self.published) - 1
            asyncio.get_running_loop().call_soon(
                self.complete_publish,
                index,
                PublishOutcome(self.ack),
            )
        if self.after_publish is not None:
            self.after_publish(topic)

    async def stop(self, timeout_s: float) -> None:
        """Records the stop and applies the configured failure or hold.

        Args:
            timeout_s: The timeout the runner gave.

        Raises:
            Exception: The configured stop error, when one is set.
        """
        self.stops.append(timeout_s)
        self.events.append("transport.stop")
        if self.during_stop is not None:
            self.during_stop()
        if self.stop_gate is not None:
            await self.stop_gate.wait()
        if self.stop_error is not None:
            raise self.stop_error


class _Service:
    """A side service that records its start and stop in the transport's event order.

    Attributes:
        events: The shared event list.
        fail_start: Whether the start raises, after it is recorded.
        fail_stop: Whether the stop raises.
        hang_stop: Whether the stop never returns.
    """

    def __init__(
        self,
        events: list[str],
        *,
        fail_start: bool = False,
        fail_stop: bool = False,
        hang_stop: bool = False,
    ) -> None:
        """Creates the service.

        Args:
            events: The shared event list.
            fail_start: Whether the start raises a `ConnectionError`.
            fail_stop: Whether the stop raises a `ConnectionError`.
            hang_stop: Whether the stop waits forever.
        """
        self.events = events
        self.fail_start = fail_start
        self.fail_stop = fail_stop
        self.hang_stop = hang_stop

    async def start(self) -> None:
        """Records the start, then raises when the service is set to fail.

        Raises:
            ConnectionError: When the service was built to fail on start.
        """
        self.events.append("service.start")
        if self.fail_start:
            raise ConnectionError

    async def stop(self) -> None:
        """Records the stop, then raises or hangs when the service is set to.

        Raises:
            ConnectionError: When the service was built to fail on stop.
        """
        self.events.append("service.stop")
        if self.hang_stop:
            await asyncio.Event().wait()
        if self.fail_stop:
            raise ConnectionError


@dataclass
class _Stack:
    """A booted core wired the way `run_agent` wires it, with its runtime.

    Attributes:
        core: The core.
        transport: The fake transport the real one stands for.
        gate: The gate that guards the core.
        latch: The e-stop latch the core writes.
        runtime: The run loop.
    """

    core: AgentCore
    transport: RunnerTransport
    gate: FaultGate
    latch: MemoryLatchStore
    runtime: AgentRuntime


@pytest.fixture(autouse=True)
def _capture_info(caplog: pytest.LogCaptureFixture) -> None:
    """Captures the runtime's INFO lines, which the default level would drop.

    Args:
        caplog: The log capture fixture.
    """
    caplog.set_level(logging.INFO)


def _core_on(
    transport: RunnerTransport,
    gate: FaultGate,
    latch: MemoryLatchStore | None = None,
) -> AgentCore:
    """Builds an unbooted core whose transport is guarded by the gate, and binds the gate.

    Args:
        transport: The transport the core sits on.
        gate: The gate that guards the core.
        latch: The e-stop latch the core writes. A new clear one is made when none is given.

    Returns:
        The core.
    """
    core = AgentCore(
        identity=AgentIdentity(
            robot_id=ROBOT_ID,
            site_id=SITE_ID,
            thing_name=f"mfc-demo-{ROBOT_ID}",
            simulated=False,
            agent_version="0.1.0",
        ),
        geometry=SITE,
        battery_start=80.0,
        clock=FakeClock(),
        transport=GuardedTransport(transport, gate),
        latch=MemoryLatchStore() if latch is None else latch,
    )
    gate.bind(core)
    return core


async def _stack(
    *,
    ack: PublishStatus | None = "OK",
    services: tuple[_Service, ...] = (),
    transport: RunnerTransport | None = None,
) -> _Stack:
    """Boots a core and wires its runtime, as the run does. It runs on the loop.

    Args:
        ack: The status every publish is acknowledged with, or None for no acknowledgement.
        services: Side services to run beside the core.
        transport: The fake transport to use. A new one is made when none is given.

    Returns:
        The wired stack, booted and listening.
    """
    if transport is None:
        transport = RunnerTransport(ack=ack)
    gate = FaultGate()
    latch = MemoryLatchStore()
    core = _core_on(transport, gate, latch)
    core.boot()
    transport.set_listener(GuardedListener(core, gate))
    runtime = AgentRuntime(core, transport, gate=gate, tick_interval_ms=1, services=services)
    return _Stack(core=core, transport=transport, gate=gate, latch=latch, runtime=runtime)


def _body(payload: bytes) -> dict[str, object]:
    """Decodes a published event, for the assertions about its kind.

    Args:
        payload: The serialised event.

    Returns:
        The event as a JSON object.
    """
    body = json.loads(payload)
    assert isinstance(body, dict)
    return body


def _kinds(transport: RunnerTransport) -> list[object]:
    """Lists the event kinds the robot published, in order.

    Args:
        transport: The fake transport that recorded the publishes.

    Returns:
        The `kind` of every published event, in publish order.
    """
    return [_body(payload)["kind"] for _, payload, _ in transport.published]


def _settings(kit_root: Path) -> AgentSettings:
    """Loads the settings of the fixture robot under the kit root.

    Args:
        kit_root: The kit root.

    Returns:
        The validated settings.
    """
    return load_settings(robot_id=ROBOT_ID, kit_root=kit_root, environ={})


def _assert_leaks_nothing(caplog: pytest.LogCaptureFixture, secret: str) -> None:
    """Asserts that no captured record carries the secret, in its message or in any field.

    Args:
        caplog: The log capture fixture.
        secret: The value that must not appear.
    """
    for record in caplog.records:
        assert secret not in record.getMessage()
        assert secret not in str(vars(record))


def _critical_halts(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Lists the fault lines that carry the frames of the fault.

    A fault writes two critical lines: the core's `agent.halted`, with the reason, and the gate's
    `agent.fault`, with the reason and the frames. Only the gate's carries a traceback, so only it
    is listed here.

    Args:
        caplog: The log capture fixture.

    Returns:
        The critical records of the event `agent.fault` that carry a traceback.
    """
    return [
        record
        for record in caplog.records
        if record.levelno == logging.CRITICAL
        and record.getMessage() == "agent.fault"
        and _field(record, "traceback") is not None
    ]


def _halt_lines(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Lists the core's halt lines, which are written only by `AgentCore.halt`.

    Args:
        caplog: The log capture fixture.

    Returns:
        The records of the event `agent.halted`.
    """
    return [record for record in caplog.records if record.getMessage() == "agent.halted"]


def _field(record: logging.LogRecord, name: str) -> object:
    """Reads one field a log call passed as an extra, or None when it was not passed.

    Args:
        record: The captured record.
        name: The extra field's name, as the log line carries it.

    Returns:
        The field's value.
    """
    return vars(record).get(name)


def _raise_secret(*_args: object) -> None:
    """Raises an error whose message carries a secret, as a real fault might.

    Args:
        *_args: Ignored; the replaced call's arguments.

    Raises:
        ValueError: Always, with the secret in the message.
    """
    raise ValueError(SECRET)


# Shutdown order and exit codes


def test_a_requested_stop_says_goodbye_last_and_exits_zero(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The goodbye is the last publish, the transport disconnects cleanly, and the run exits 0."""

    async def scenario() -> None:
        stack = await _stack()
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_OK
        assert _kinds(stack.transport)[-1] == "GOING_OFFLINE"
        assert stack.transport.stops == [runner.TRANSPORT_STOP_S]
        assert "agent.stopped" in [record.getMessage() for record in caplog.records]

    asyncio.run(scenario())


def test_the_goodbye_is_built_after_the_stop_and_nothing_feeds_the_core_after_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A message that arrives while the link closes never reaches the core after the goodbye."""

    async def scenario() -> None:
        stack = await _stack()
        seen: list[bytes] = []
        monkeypatch.setattr(stack.core, "on_message", lambda topic, payload: seen.append(payload))
        stack.transport.during_stop = lambda: stack.transport.deliver(COMMAND_TOPIC, b"{}")
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_OK
        assert seen == []
        assert stack.core.stopping

    asyncio.run(scenario())


def test_an_unacknowledged_goodbye_is_given_up_after_the_wait(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A goodbye the broker never acknowledges ends the wait, logs it, and still exits 0."""
    monkeypatch.setattr(runner, "GOODBYE_WAIT_S", 0.01)

    async def scenario() -> None:
        stack = await _stack(ack=None)
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_OK
        assert stack.transport.stops == [runner.TRANSPORT_STOP_S]
        assert any(
            record.getMessage() == "publish.failed" and _field(record, "outcome") == "TIMEOUT"
            for record in caplog.records
        )

    asyncio.run(scenario())


def test_a_refused_goodbye_is_logged_with_its_status(caplog: pytest.LogCaptureFixture) -> None:
    """A goodbye the broker refuses is logged with the refusal, and the stop still completes."""

    async def scenario() -> None:
        stack = await _stack(ack="NOT_AUTHORIZED")
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_OK
        assert any(
            record.getMessage() == "publish.failed"
            and _field(record, "label") == "GOING_OFFLINE"
            and _field(record, "outcome") == "NOT_AUTHORIZED"
            for record in caplog.records
        )

    asyncio.run(scenario())


def test_a_failing_disconnect_is_logged_and_the_run_still_exits_zero(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A stop that fails is logged by its error class only, and the process still exits 0."""

    async def scenario() -> None:
        stack = await _stack()
        stack.transport.stop_error = ConnectionError(SECRET)
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_OK
        assert any(
            record.getMessage() == "link.lost" and _field(record, "errorName") == "ConnectionError"
            for record in caplog.records
        )
        _assert_leaks_nothing(caplog, SECRET)

    asyncio.run(scenario())


def test_an_estop_after_the_goodbye_is_latched_and_acknowledged() -> None:
    """An e-stop that arrives once the goodbye is out still stops the robot, latches and is acked.

    The goodbye is the last thing the robot says on its own; the core's acknowledgement of a stop
    that reached it in time is still owed, and the latch must be set before the link closes.
    """
    command = make_command("ESTOP")
    sent: list[bool] = []

    async def scenario() -> _Stack:
        stack = await _stack()

        def estop_once_the_goodbye_is_out(_topic: str) -> None:
            if not sent and labels(stack.transport)[-1] == "GOING_OFFLINE":
                sent.append(True)
                stack.transport.deliver(COMMAND_TOPIC, encode(command))

        stack.transport.after_publish = estop_once_the_goodbye_is_out
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_OK
        return stack

    stack = asyncio.run(scenario())

    assert sent == [True]
    assert stack.latch.record is not None
    assert stack.latch.record.command_id == command["commandId"]
    published = labels(stack.transport)
    goodbye = published.index("GOING_OFFLINE")
    assert "ACK" in published[goodbye + 1 :]


def test_services_start_before_the_first_tick_and_stop_before_the_disconnect() -> None:
    """Services run beside the core: they start first and stop before the transport disconnects."""

    async def scenario() -> list[str]:
        transport = RunnerTransport()
        stack = await _stack(services=(_Service(transport.events),), transport=transport)
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_OK
        return transport.events

    events = asyncio.run(scenario())

    assert events == ["service.start", "service.stop", "transport.stop"]


def test_a_failing_service_stop_halts_the_run_and_still_disconnects() -> None:
    """A service that fails to stop halts the core: exit 70, and the disconnect still happens."""

    async def scenario() -> list[str]:
        transport = RunnerTransport()
        stack = await _stack(
            services=(_Service(transport.events, fail_stop=True),),
            transport=transport,
        )
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_SOFTWARE
        return transport.events

    events = asyncio.run(scenario())

    assert events == ["service.start", "service.stop", "transport.stop"]


def test_the_goodbye_of_a_halted_core_is_still_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    """A halted core still announces that it is going offline, then exits 70."""

    async def scenario() -> None:
        stack = await _stack()
        monkeypatch.setattr(stack.core, "tick", _raise_secret)

        code = await asyncio.wait_for(stack.runtime.run(), timeout=5)

        assert code == EXIT_SOFTWARE
        assert stack.core.halted
        assert _kinds(stack.transport)[-1] == "GOING_OFFLINE"

    asyncio.run(scenario())


# Halt guard


def test_an_exception_in_the_tick_halts_with_the_type_and_frames_only(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A fault in the tick halts the core, logs the type and frames, and never the message."""

    async def scenario() -> None:
        stack = await _stack()
        monkeypatch.setattr(stack.core, "tick", _raise_secret)

        code = await asyncio.wait_for(stack.runtime.run(), timeout=5)

        assert code == EXIT_SOFTWARE
        faults = _critical_halts(caplog)
        assert len(faults) == 1
        assert _field(faults[0], "reason") == "ValueError"
        frames = _field(faults[0], "traceback")
        assert isinstance(frames, list)
        assert frames
        _assert_leaks_nothing(caplog, SECRET)

    asyncio.run(scenario())


def test_a_fault_is_reported_by_one_halt_line_and_one_fault_line(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A fault writes the core's `agent.halted` once and the gate's `agent.fault` once."""

    async def scenario() -> None:
        stack = await _stack()
        monkeypatch.setattr(stack.core, "tick", _raise_secret)

        await asyncio.wait_for(stack.runtime.run(), timeout=5)

    asyncio.run(scenario())
    assert [_field(record, "reason") for record in _halt_lines(caplog)] == ["ValueError"]
    assert len(_critical_halts(caplog)) == 1

    asyncio.run(scenario())


def test_an_exception_in_a_listener_callback_halts_the_core(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A fault while handling an inbound message halts the core, which then exits 70."""

    async def scenario() -> None:
        stack = await _stack()
        monkeypatch.setattr(stack.core, "on_message", _raise_secret)
        asyncio.get_running_loop().call_later(
            0.01,
            stack.transport.deliver,
            command_topic(SITE_ID, ROBOT_ID),
            b"{}",
        )

        code = await asyncio.wait_for(stack.runtime.run(), timeout=5)

        assert code == EXIT_SOFTWARE
        assert stack.core.halted
        _assert_leaks_nothing(caplog, SECRET)

    asyncio.run(scenario())


def test_a_fault_in_a_publish_or_subscribe_completion_halts_without_escaping() -> None:
    """A completion callback that fails halts the core; the failure never reaches the transport."""
    transport = RunnerTransport(ack=None)
    gate = FaultGate()
    core = _core_on(transport, gate)
    guarded = GuardedTransport(transport, gate)

    def fail_publish(outcome: PublishOutcome) -> None:
        raise ValueError(SECRET)

    def fail_subscribe(outcome: SubscribeOutcome) -> None:
        raise ValueError(SECRET)

    guarded.publish("topic", b"payload", 1, fail_publish)
    transport.complete_publish(0, PublishOutcome("OK"))
    assert core.halted

    other = RunnerTransport(ack=None)
    other_gate = FaultGate()
    other_core = _core_on(other, other_gate)
    GuardedTransport(other, other_gate).subscribe("topic", fail_subscribe)
    other.complete_subscribe(SubscribeOutcome("GRANTED"))
    assert other_core.halted


def test_a_loop_error_halts_and_logs_only_its_type_and_frames(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A loop error halts the core, and its message and context are never logged."""

    async def scenario() -> None:
        transport = RunnerTransport()
        gate = FaultGate()
        core = _core_on(transport, gate)
        try:
            raise ValueError(SECRET)
        except ValueError as err:
            gate.on_loop_error(
                asyncio.get_running_loop(),
                {"exception": err, "message": SECRET},
            )
        assert core.halted

    asyncio.run(scenario())
    faults = _critical_halts(caplog)
    assert len(faults) == 1
    assert _field(faults[0], "reason") == "ValueError"
    _assert_leaks_nothing(caplog, SECRET)


def test_a_loop_error_without_an_exception_halts_under_its_own_name(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A loop error with no exception object still halts, and is named by its own type."""

    async def scenario() -> None:
        transport = RunnerTransport()
        gate = FaultGate()
        core = _core_on(transport, gate)
        gate.on_loop_error(asyncio.get_running_loop(), {"message": "no exception"})
        assert core.halted

    asyncio.run(scenario())
    faults = _critical_halts(caplog)
    assert [_field(record, "reason") for record in faults] == ["UnreportedLoopError"]


def test_a_closed_gate_feeds_the_core_nothing() -> None:
    """Once the gate is closed, a call returns the default and a wrapped callback does nothing."""
    transport = RunnerTransport()
    gate = FaultGate()
    _core_on(transport, gate)
    seen: list[str] = []
    gate.close()

    assert gate.call(lambda: 1, 0) == 0
    gate.wrap(seen.append)("late")

    assert seen == []


def test_the_guarded_listener_forwards_each_connection_event_to_the_core(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every connection event reaches the core through the listener, with its reasons."""
    transport = RunnerTransport()
    gate = FaultGate()
    core = _core_on(transport, gate)
    calls: list[tuple[str, object, object]] = []
    monkeypatch.setattr(core, "on_connected", lambda: calls.append(("connected", None, None)))
    monkeypatch.setattr(
        core,
        "on_disconnected",
        lambda error, reason: calls.append(("disconnected", error, reason)),
    )
    monkeypatch.setattr(
        core,
        "on_connect_failed",
        lambda error, reason: calls.append(("connect_failed", error, reason)),
    )
    listener = GuardedListener(core, gate)

    listener.on_connected()
    listener.on_disconnected("ConnectionError", 135)
    listener.on_connect_failed(None, 5)

    assert calls == [
        ("connected", None, None),
        ("disconnected", "ConnectionError", 135),
        ("connect_failed", None, 5),
    ]


def test_the_guarded_link_passes_a_suspend_to_the_real_transport() -> None:
    """The core's link passes a suspend through to the real transport, unguarded by a callback."""
    transport = RunnerTransport()
    guarded = GuardedTransport(transport, FaultGate())

    guarded.suspend(250)

    assert transport.suspended == [250]


def test_a_fault_before_the_gate_is_bound_is_a_wiring_error() -> None:
    """A fault with no core to halt is a programming error, and it is not hidden."""
    with pytest.raises(RuntimeError, match="not bound"):
        FaultGate().fault(ValueError())


# Stop signals


def test_a_second_stop_request_forces_the_exit_at_once() -> None:
    """Two stop requests in a row exit 130 with no goodbye, after the core has begun its stop."""

    async def scenario() -> _Stack:
        stack = await _stack()

        def stop_twice() -> None:
            stack.runtime.request_stop()
            stack.runtime.request_stop()

        asyncio.get_running_loop().call_later(0.01, stop_twice)

        code = await asyncio.wait_for(stack.runtime.run(), timeout=5)

        assert code == EXIT_FORCED
        assert "GOING_OFFLINE" not in _kinds(stack.transport)
        assert stack.transport.stops == []
        return stack

    stack = asyncio.run(scenario())

    assert stack.core.stopping
    assert not stack.core.halted


def test_a_second_stop_request_during_the_shutdown_cancels_it() -> None:
    """A second stop request during the shutdown abandons the wait for the disconnect: 130."""

    async def scenario() -> None:
        stack = await _stack()
        stack.transport.stop_gate = asyncio.Event()
        loop = asyncio.get_running_loop()
        loop.call_later(0.01, stack.runtime.request_stop)
        loop.call_later(0.05, stack.runtime.request_stop)

        code = await asyncio.wait_for(stack.runtime.run(), timeout=5)

        assert code == EXIT_FORCED
        assert _kinds(stack.transport)[-1] == "GOING_OFFLINE"

    asyncio.run(scenario())


def test_a_tick_interval_below_one_millisecond_is_refused() -> None:
    """The tick interval must be a positive number of milliseconds."""

    async def scenario() -> None:
        transport = RunnerTransport()
        gate = FaultGate()
        core = _core_on(transport, gate)
        with pytest.raises(ValueError, match="at least 1 ms"):
            AgentRuntime(core, transport, gate=gate, tick_interval_ms=0)

    asyncio.run(scenario())


def test_run_agent_exits_zero_on_sigterm(tmp_path: Path) -> None:
    """A real SIGTERM to the process ends the run cleanly, with the goodbye last."""
    write_kit(tmp_path)
    transport = RunnerTransport()

    async def scenario() -> int:
        asyncio.get_running_loop().call_later(0.05, os.kill, os.getpid(), signal.SIGTERM)
        return await run_agent(
            _settings(tmp_path),
            transport_factory=lambda kit, port, loop: transport,
        )

    code = asyncio.run(scenario())

    assert code == EXIT_OK
    assert _kinds(transport)[-1] == "GOING_OFFLINE"


def test_a_service_that_fails_to_start_stops_only_what_started_and_exits_70() -> None:
    """A failing service start halts the core: the started services and the link are stopped."""

    async def scenario() -> int:
        transport = RunnerTransport()
        stack = await _stack(
            services=(
                _Service(transport.events),
                _Service(transport.events, fail_start=True),
                _Service(transport.events),
            ),
            transport=transport,
        )

        code = await asyncio.wait_for(stack.runtime.run(), timeout=5)

        assert stack.core.halted
        assert transport.events == [
            "service.start",
            "service.start",
            "service.stop",
            "transport.stop",
        ]
        return code

    assert asyncio.run(scenario()) == EXIT_SOFTWARE


def test_a_service_that_overruns_its_stop_is_a_fault_and_the_others_still_stop(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A service stop past its bound halts the core, and the stop goes on to the next service."""
    monkeypatch.setattr(runner, "SERVICE_STOP_S", 0.01)

    async def scenario() -> int:
        transport = RunnerTransport()
        stack = await _stack(
            services=(
                _Service(transport.events),
                _Service(transport.events, hang_stop=True),
            ),
            transport=transport,
        )
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await asyncio.wait_for(stack.runtime.run(), timeout=5)

        assert transport.events == [
            "service.start",
            "service.start",
            "service.stop",
            "service.stop",
            "transport.stop",
        ]
        return code

    assert asyncio.run(scenario()) == EXIT_SOFTWARE
    assert [_field(record, "reason") for record in _critical_halts(caplog)] == ["TimeoutError"]


def test_an_unexpected_boot_failure_exits_70_before_the_link_starts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A boot that fails for a reason other than the latch is a fault: nothing connects, exit 70."""
    write_kit(tmp_path)
    monkeypatch.setattr(runner.AgentCore, "boot", _raise_secret)
    transport = RunnerTransport()

    code = asyncio.run(
        run_agent(_settings(tmp_path), transport_factory=lambda kit, port, loop: transport),
    )

    assert code == EXIT_SOFTWARE
    assert transport.started == 0
    assert transport.stops == []
    assert [_field(record, "reason") for record in _critical_halts(caplog)] == ["ValueError"]
    _assert_leaks_nothing(caplog, SECRET)


def test_a_link_that_fails_to_start_is_disconnected_and_exits_70(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A transport that fails to start is stopped as far as it got, and the run exits 70."""
    write_kit(tmp_path)
    transport = RunnerTransport()
    transport.start_error = RuntimeError(SECRET)

    code = asyncio.run(
        run_agent(_settings(tmp_path), transport_factory=lambda kit, port, loop: transport),
    )

    assert code == EXIT_SOFTWARE
    assert transport.stops == [runner.TRANSPORT_STOP_S]
    assert [_field(record, "reason") for record in _critical_halts(caplog)] == ["RuntimeError"]
    _assert_leaks_nothing(caplog, SECRET)


# Start-up refusals: exit 78 before the transport is built or the robot connects


def test_an_insecure_kit_exits_78_without_creating_a_transport(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A kit directory open to others is refused before any transport is built."""
    write_kit(tmp_path, kit_dir_mode=0o755)
    created: list[LoadedKit] = []

    def factory(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> RunnerTransport:
        created.append(kit)
        return RunnerTransport()

    code = asyncio.run(run_agent(_settings(tmp_path), transport_factory=factory))

    assert code == EXIT_CONFIG
    assert created == []
    refusals = [record for record in caplog.records if record.getMessage() == "kit.refused"]
    assert [_field(record, "reason") for record in refusals] == ["KIT_DIR_INSECURE"]


def test_a_transport_the_kit_cannot_build_exits_78(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A transport that refuses the kit's key exits 78 with the kit's refusal code."""
    write_kit(tmp_path)

    def factory(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> RunnerTransport:
        raise KitError("KIT_KEY_INVALID")

    code = asyncio.run(run_agent(_settings(tmp_path), transport_factory=factory))

    assert code == EXIT_CONFIG
    assert any(
        record.getMessage() == "kit.refused" and _field(record, "reason") == "KIT_KEY_INVALID"
        for record in caplog.records
    )


def test_an_unreadable_latch_exits_78_before_the_robot_connects(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A latch that cannot be read is refused: the robot never boots, connects or moves."""
    kit_dir = write_kit(tmp_path)
    latch = kit_dir / LATCH_FILE_NAME
    latch.write_text("{}", encoding="utf-8")
    latch.chmod(0o644)
    transport = RunnerTransport()

    code = asyncio.run(
        run_agent(_settings(tmp_path), transport_factory=lambda kit, port, loop: transport),
    )

    assert code == EXIT_CONFIG
    assert transport.started == 0
    assert "latch.unreadable" in [record.getMessage() for record in caplog.records]


def test_a_halted_core_that_is_asked_to_stop_exits_70() -> None:
    """The exit code follows the core: a core that halted before the stop exits 70."""

    async def scenario() -> None:
        stack = await _stack()
        stack.core.halt("ValueError")
        asyncio.get_running_loop().call_later(0.02, stack.runtime.request_stop)

        code = await stack.runtime.run()

        assert code == EXIT_SOFTWARE

    asyncio.run(scenario())


# Side services built by the factory once the core has booted


def test_a_video_service_whose_assets_fail_to_load_never_halts_the_core(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The real page with a broken asset set is disabled at start and the robot runs and exits 0."""
    write_kit(tmp_path)
    transport = RunnerTransport()
    snapshots: list[object] = []

    def factory(ctx: runner.ServiceContext) -> tuple[LocalVideoService, ...]:
        """Builds the real page over a directory that does not exist.

        The snapshot is read here, while the core runs, because the gate closes at shutdown.

        Args:
            ctx: The context of the run.

        Returns:
            The page service.
        """
        snapshots.append(ctx.snapshot())
        return (
            LocalVideoService(
                ctx.kit,
                ctx.snapshot,
                notice=lambda _text: None,
                static_dir=tmp_path / "no-such-page",
            ),
        )

    async def scenario() -> int:
        asyncio.get_running_loop().call_later(0.05, os.kill, os.getpid(), signal.SIGTERM)
        return await run_agent(
            _settings(tmp_path),
            transport_factory=lambda kit, port, loop: transport,
            service_factory=factory,
        )

    code = asyncio.run(scenario())

    assert code == EXIT_OK
    assert len(snapshots) == 1
    assert snapshots[0] is not None
    assert _kinds(transport)[-1] == "GOING_OFFLINE"
    disabled = [record for record in caplog.records if record.getMessage() == "video.disabled"]
    assert [_field(record, "code") for record in disabled] == ["MANIFEST_MISSING"]
    assert not _critical_halts(caplog)


def test_a_service_factory_that_raises_halts_the_run_with_exit_70(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A factory that cannot build its services halts the core, as a failed start does."""
    write_kit(tmp_path)
    transport = RunnerTransport()

    def factory(ctx: runner.ServiceContext) -> tuple[RuntimeService, ...]:
        """Fails at once, with a message that must never be logged.

        Args:
            ctx: The context of the run. Unused.

        Raises:
            RuntimeError: Always.
        """
        del ctx
        raise RuntimeError(SECRET)

    code = asyncio.run(
        run_agent(
            _settings(tmp_path),
            transport_factory=lambda kit, port, loop: transport,
            service_factory=factory,
        )
    )

    assert code == EXIT_SOFTWARE
    assert [_field(record, "reason") for record in _critical_halts(caplog)] == ["RuntimeError"]
    _assert_leaks_nothing(caplog, SECRET)


@pytest.mark.parametrize("hook", ["on_tick", "navigator"])
def test_a_simulator_hook_on_a_real_kit_is_refused_before_any_transport(
    tmp_path: Path,
    hook: str,
) -> None:
    """Given a per-tick hook or a navigator on a robot whose kit is not simulated, the run refuses.

    The refusal is a wiring error, so it raises rather than exiting 78, and it happens before the
    transport is built or the robot connects.
    """
    write_kit(tmp_path)
    created: list[LoadedKit] = []

    def factory(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> RunnerTransport:
        created.append(kit)
        return RunnerTransport()

    controls = (
        RunControls(on_tick=lambda _core, _index: None)
        if hook == "on_tick"
        else RunControls(navigator=StraightLineNavigator())
    )

    with pytest.raises(ValueError, match="simulator hooks"):
        asyncio.run(
            run_agent(_settings(tmp_path), transport_factory=factory, controls=controls),
        )

    assert created == []
