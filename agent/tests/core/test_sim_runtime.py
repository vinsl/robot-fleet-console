"""Tests of the runner's controls: signal ownership, the per-tick hook and its fault gate.

The runtime runs over a booted core and a fake transport, with a short tick. The shutdown wait for
the goodbye is shortened, because the fake transport never completes the publish.
"""

from __future__ import annotations

import asyncio
import signal

import pytest

from fleet_agent.core.agent import AgentCore
from fleet_agent.core.model import Point
from fleet_agent.core.navigation import StraightLineNavigator
from fleet_agent.runtime import runner
from fleet_agent.runtime.runner import EXIT_OK, EXIT_SOFTWARE, AgentRuntime, FaultGate, RunControls

from .fakes import FakeTransport, make_core

STATION = Point(4.0, 0.0)


@pytest.fixture(autouse=True)
def _short_goodbye_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shortens the wait for the goodbye, which the fake transport never completes.

    Args:
        monkeypatch: The fixture that patches the runner's wait.
    """
    monkeypatch.setattr(runner, "GOODBYE_WAIT_S", 0.01)


def _runtime(
    core: AgentCore,
    transport: FakeTransport,
    *,
    install_signals: bool = False,
    on_tick: runner.TickHook | None = None,
) -> AgentRuntime:
    """Builds a runtime over a booted core, with a fault gate bound to it.

    Args:
        core: The booted core.
        transport: The transport the runtime disconnects at shutdown.
        install_signals: Whether the runtime owns the stop signals.
        on_tick: The per-tick hook, if any.

    Returns:
        The runtime, ticking every 5 ms.
    """
    gate = FaultGate()
    gate.bind(core)
    return AgentRuntime(
        core,
        transport,
        gate=gate,
        tick_interval_ms=5,
        install_signals=install_signals,
        on_tick=on_tick,
    )


def test_the_hook_runs_after_each_tick_with_its_index_and_the_run_stops() -> None:
    """Given a per-tick hook, it runs once per tick with consecutive indices until the stop."""
    core, _, transport, _ = make_core(simulated=True)
    seen: list[int] = []

    def on_tick(_core: AgentCore, index: int) -> None:
        """Records the index of the tick.

        Args:
            _core: The core of the run. Unused.
            index: The index of the tick, from zero.
        """
        seen.append(index)

    runtime = _runtime(core, transport, on_tick=on_tick)

    async def scenario() -> int:
        """Requests the stop after a short run and returns the exit code.

        Returns:
            The exit code of the run.
        """
        asyncio.get_running_loop().call_later(0.05, runtime.request_stop)
        return await runtime.run()

    assert asyncio.run(scenario()) == EXIT_OK
    assert len(seen) >= 2
    assert seen == list(range(len(seen)))


@pytest.mark.parametrize("owns_signals", [True, False])
def test_the_run_installs_the_stop_signals_only_when_it_owns_them(
    monkeypatch: pytest.MonkeyPatch,
    owns_signals: bool,
) -> None:
    """Given a runtime, the stop handlers are installed and removed only if it owns the signals."""
    core, _, transport, _ = make_core(simulated=True)
    installed: list[signal.Signals] = []
    removed: list[signal.Signals] = []
    runtime = _runtime(core, transport, install_signals=owns_signals)

    async def scenario() -> int:
        """Records the handler calls of the loop and runs until the stop.

        Returns:
            The exit code of the run.
        """
        loop = asyncio.get_running_loop()

        def add(sig: signal.Signals, callback: object, *args: object) -> None:
            """Records an installed handler. The callback is not run.

            Args:
                sig: The signal the handler is for.
                callback: The handler. Unused.
                *args: Extra arguments. Unused.
            """
            del callback, args
            installed.append(sig)

        def remove(sig: signal.Signals) -> bool:
            """Records a removed handler.

            Args:
                sig: The signal whose handler is removed.

            Returns:
                True, as the loop does for a handler it had installed.
            """
            removed.append(sig)
            return True

        monkeypatch.setattr(loop, "add_signal_handler", add)
        monkeypatch.setattr(loop, "remove_signal_handler", remove)
        loop.call_later(0.02, runtime.request_stop)
        return await runtime.run()

    assert asyncio.run(scenario()) == EXIT_OK
    expected = [signal.SIGTERM, signal.SIGINT] if owns_signals else []
    assert installed == expected
    assert removed == expected


def test_a_simulator_call_from_the_hook_of_a_real_robot_halts_that_robot() -> None:
    """Given a real robot whose hook calls a simulator-only method, the gate halts it, exit 70."""
    core, _, transport, _ = make_core(simulated=False)

    def on_tick(robot: AgentCore, index: int) -> None:
        """Tries to give the real robot a mission, which the core refuses.

        Args:
            robot: The core of the run.
            index: The index of the tick. Unused.
        """
        del index
        robot.assign_mission("m-real-0001", [STATION])

    runtime = _runtime(core, transport, on_tick=on_tick)

    async def scenario() -> int:
        """Runs the robot until the gate stops it, with a safety stop in case it does not.

        Returns:
            The exit code of the run.
        """
        asyncio.get_running_loop().call_later(1.0, runtime.request_stop)
        return await runtime.run()

    assert asyncio.run(scenario()) == EXIT_SOFTWARE
    assert core.halted is True
    assert core.snapshot().state == "IDLE"


def test_the_hook_is_not_called_again_once_the_core_has_halted() -> None:
    """Given a hook that halts the core on its first tick, the hook runs once and the exit is 70."""
    core, _, transport, _ = make_core(simulated=True)
    calls: list[int] = []

    def on_tick(robot: AgentCore, index: int) -> None:
        """Records the tick and halts the robot.

        Args:
            robot: The core of the run.
            index: The index of the tick.
        """
        calls.append(index)
        robot.halt("RuntimeError")

    runtime = _runtime(core, transport, on_tick=on_tick)

    async def scenario() -> int:
        """Runs until the halt ends the loop, with a safety stop in case it does not.

        Returns:
            The exit code of the run.
        """
        asyncio.get_running_loop().call_later(1.0, runtime.request_stop)
        return await runtime.run()

    assert asyncio.run(scenario()) == EXIT_SOFTWARE
    assert calls == [0]


def test_run_controls_carry_a_navigator_to_the_core() -> None:
    navigator = StraightLineNavigator()

    assert RunControls(navigator=navigator).navigator is navigator
    assert RunControls().navigator is None
