"""Tests of the command line: usage errors, the exit codes, the e-stop line and the probe run."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from collections.abc import Callable, Iterator
from dataclasses import replace
from pathlib import Path

import pytest

from fleet_agent import cli
from fleet_agent.config.kit_file import KitError, LoadedKit, load_kit
from fleet_agent.core.ports import Transport, TransportFactory
from fleet_agent.protocol.commands import EstopCommand
from fleet_agent.protocol.topics import events_topic
from fleet_agent.runtime.runner import EXIT_CONFIG, EXIT_OK, EXIT_SOFTWARE, ServiceContext
from fleet_agent.video.service import LocalVideoService
from tests.kit_fixtures import ROBOT_ID, write_kit
from tests.tools.policy_broker import PolicyTransport, own_publish_topics, own_subscribe_filters

OTHER_ROBOT = "sim-99"


@pytest.fixture(autouse=True)
def _no_agent_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Removes every FLEET_ variable, so that the developer's shell cannot change a test.

    Args:
        monkeypatch: The fixture that restores the environment after the test.
    """
    for name in list(os.environ):
        if name.startswith("FLEET_"):
            monkeypatch.delenv(name)


@pytest.fixture
def restored_root_logger() -> Iterator[None]:
    """Puts the root logger back as it was, since the command line configures it.

    Yields:
        Nothing; the restoration happens after the test.
    """
    root = logging.getLogger()
    handlers = list(root.handlers)
    level = root.level
    yield
    root.handlers[:] = handlers
    root.setLevel(level)


pytestmark = pytest.mark.usefixtures("restored_root_logger")


@pytest.fixture(autouse=True)
def _probe_without_pauses(monkeypatch: pytest.MonkeyPatch) -> None:
    """Runs the probe without its connection spacing, which only matters against the real broker."""
    real = cli.run_isolation_probe
    monkeypatch.setattr(cli, "run_isolation_probe", lambda *a, **k: real(*a, spacing_s=0, **k))


def _probe_factory(allowed_extra: frozenset[str] = frozenset()) -> TransportFactory:
    """Builds a transport factory with the correct policy for the fixture robot, plus extras.

    Args:
        allowed_extra: Publish topics to allow beyond the robot's own, to model a broken policy.

    Returns:
        A factory whose transports refuse every topic but the allowed ones.
    """

    def factory(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> Transport:
        """Builds one policy transport for a check of the probe.

        Args:
            kit: The loaded kit.
            port: The broker port, unused by the policy.
            loop: The loop, unused by the policy.

        Returns:
            A transport following the policy.
        """
        del port, loop
        publish = own_publish_topics(kit.config.site_id, kit.config.robot_id)
        # The policy only lets the robot connect under its own thing name.
        return PolicyTransport(
            allowed_topics=publish | allowed_extra,
            allowed_filters=own_subscribe_filters(kit.config.site_id, kit.config.robot_id),
            refuse_connect=kit.config.thing_name != f"mfc-demo-{ROBOT_ID}",
        )

    return factory


def _json_lines(text: str) -> list[dict[str, object]]:
    """Decodes every line of a log or output as a JSON object.

    Args:
        text: The text, one JSON object per line.

    Returns:
        The decoded objects, in order.
    """
    lines: list[dict[str, object]] = []
    for line in text.splitlines():
        body = json.loads(line)
        assert isinstance(body, dict)
        lines.append(body)
    return lines


# Usage


def test_no_command_is_a_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    """A command line with no command exits 64 and says what was wrong."""
    assert cli.main([]) == cli.EXIT_USAGE
    assert "error" in capsys.readouterr().err


def test_an_unknown_command_is_a_usage_error() -> None:
    """A command that does not exist exits 64."""
    assert cli.main(["explode"]) == cli.EXIT_USAGE


class _ParsesAs:
    """A parser stand-in that parses every command line into one fixed command name."""

    def __init__(self, command: str) -> None:
        """Creates the stand-in.

        Args:
            command: The command name every command line is parsed into.
        """
        self._command = command

    def parse_args(self, argv: object) -> argparse.Namespace:
        """Returns the fixed command, ignoring the arguments.

        Args:
            argv: Ignored.

        Returns:
            A namespace naming the fixed command.
        """
        del argv
        return argparse.Namespace(command=self._command)

    def format_usage(self) -> str:
        """Returns a fixed usage line.

        Returns:
            The usage line.
        """
        return "usage: fleet-agent\n"


def test_a_command_outside_the_dispatch_table_never_runs_another_one(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A parsed command with no handler is a usage error, and no other handler runs."""
    monkeypatch.setattr(cli, "_build_parser", lambda: _ParsesAs("explode"))

    code = cli.main(["ignored"])

    captured = capsys.readouterr()
    assert code == cli.EXIT_USAGE
    assert captured.out == ""
    assert "unknown command" in captured.err


def test_a_malformed_robot_identifier_is_a_usage_error_that_does_not_echo_it(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A robot identifier outside the protocol pattern exits 64, and the value is not echoed."""
    assert cli.main(["run", "--robot-id", "NOT A ROBOT"]) == cli.EXIT_USAGE
    assert "NOT A ROBOT" not in capsys.readouterr().err


def test_the_probe_needs_the_other_robot(capsys: pytest.CaptureFixture[str]) -> None:
    """The probe without the other robot's identifier is a usage error."""
    assert cli.main(["probe-isolation", "--robot-id", ROBOT_ID]) == cli.EXIT_USAGE
    assert "--other-robot-id" in capsys.readouterr().err


def test_a_malformed_site_identifier_is_a_usage_error() -> None:
    """A site identifier outside the protocol pattern exits 64."""
    argv = [
        "probe-isolation",
        "--robot-id",
        ROBOT_ID,
        "--other-robot-id",
        OTHER_ROBOT,
        "--other-site-id",
        "BAD SITE",
    ]
    assert cli.main(argv) == cli.EXIT_USAGE


# Run


def test_run_refuses_to_start_without_a_robot_identifier(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Without a robot identifier, from the flag or the environment, the run exits 78."""
    write_kit(tmp_path)

    code = cli.main(["run", "--kit-root", str(tmp_path)])

    assert code == EXIT_CONFIG
    records = _json_lines(capsys.readouterr().out)
    assert [(record["event"], record["reason"]) for record in records] == [
        ("config.refused", "INVALID")
    ]


def test_run_returns_the_exit_code_of_the_agent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The run command returns what the runtime returns, here the halt code 70."""
    write_kit(tmp_path)

    async def fake_run_agent(settings: object, **_: object) -> int:
        """Stands in for the runtime, returning the halt code.

        Args:
            settings: The settings the command resolved.

        Returns:
            70.
        """
        del settings
        return EXIT_SOFTWARE

    monkeypatch.setattr(cli, "run_agent", fake_run_agent)

    assert cli.main(["run", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)]) == 70


# Estop command


def test_estop_command_prints_one_valid_estop_line(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The e-stop command prints one JSON line that validates as an ESTOP, with no kit data."""
    write_kit(tmp_path)

    code = cli.main(["estop-command", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)])

    captured = capsys.readouterr()
    assert code == EXIT_OK
    lines = captured.out.splitlines()
    assert len(lines) == 1
    command = EstopCommand.model_validate(json.loads(lines[0]))
    assert command.type == "ESTOP"
    assert command.issued_by == "local-operator"
    assert command.lock_token is None
    assert "PRIVATE" not in captured.out
    assert "BEGIN" not in captured.out
    assert "mfc-demo-" not in captured.out
    assert "amazonaws" not in captured.out


def test_estop_command_applies_the_configured_log_level(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The e-stop command logs at the level the settings name, on standard error."""
    write_kit(tmp_path)
    monkeypatch.setenv("FLEET_LOG_LEVEL", "ERROR")

    code = cli.main(["estop-command", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)])

    assert code == EXIT_OK
    assert logging.getLogger().level == logging.ERROR


def test_each_estop_command_has_fresh_identifiers(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Two builds give two commands with different identifiers, so a replay cannot match."""
    write_kit(tmp_path)
    argv = ["estop-command", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)]

    cli.main(argv)
    first = EstopCommand.model_validate(json.loads(capsys.readouterr().out))
    cli.main(argv)
    second = EstopCommand.model_validate(json.loads(capsys.readouterr().out))

    assert first.command_id != second.command_id
    assert first.message_id != second.message_id


def test_estop_command_refuses_a_kit_open_to_others_on_standard_error(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A kit the agent would refuse is refused here too: nothing on standard output, exit 78."""
    write_kit(tmp_path, kit_dir_mode=0o755)

    code = cli.main(["estop-command", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)])

    captured = capsys.readouterr()
    assert code == EXIT_CONFIG
    assert captured.out == ""
    records = _json_lines(captured.err)
    assert [(record["event"], record["reason"]) for record in records] == [
        ("kit.refused", "KIT_DIR_INSECURE")
    ]


def test_an_unknown_fleet_variable_is_refused_by_name(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A FLEET_ variable the agent does not read exits 78 and is named in the log."""
    write_kit(tmp_path)
    monkeypatch.setenv("FLEET_TYPO", "1")

    code = cli.main(["estop-command", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)])

    assert code == EXIT_CONFIG
    records = _json_lines(capsys.readouterr().err)
    assert [(record["event"], record["reason"], record["label"]) for record in records] == [
        ("config.refused", "UNKNOWN_ENV", "FLEET_TYPO")
    ]


# Probe


def test_the_probe_prints_one_line_per_check_and_exits_zero_when_all_pass(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A correct policy passes every check: exit 0, and the notice to stop the agent."""
    write_kit(tmp_path)
    monkeypatch.setattr(cli, "build_crt_transport", _probe_factory())

    code = cli.main(
        [
            "probe-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            OTHER_ROBOT,
            "--kit-root",
            str(tmp_path),
        ]
    )

    captured = capsys.readouterr()
    assert code == EXIT_OK
    records = _json_lines(captured.out)
    assert len(records) == 9
    assert {record["event"] for record in records} == {"probe.result"}
    assert {record["result"] for record in records} == {"PASS"}
    assert "stop the agent first" in captured.err


def test_the_probe_exits_one_when_a_check_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A policy that lets the robot publish on the other robot's topic fails the probe: exit 1."""
    write_kit(tmp_path)
    other_events = events_topic("paris-01", OTHER_ROBOT)
    monkeypatch.setattr(cli, "build_crt_transport", _probe_factory(frozenset({other_events})))

    code = cli.main(
        [
            "probe-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            OTHER_ROBOT,
            "--kit-root",
            str(tmp_path),
        ]
    )

    assert code == cli.EXIT_PROBE_FAILED
    results = {record["label"]: record["result"] for record in _json_lines(capsys.readouterr().out)}
    assert results["other-events-publish"] == "FAIL"
    assert results["own-events-publish"] == "PASS"


def test_the_probe_refuses_to_test_the_robot_against_itself(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A probe whose other robot is the robot itself is a usage error: nothing is connected."""
    write_kit(tmp_path)

    code = cli.main(
        [
            "probe-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            ROBOT_ID,
            "--kit-root",
            str(tmp_path),
        ]
    )

    captured = capsys.readouterr()
    assert code == cli.EXIT_USAGE
    assert captured.out == ""
    assert "must not be the robot itself" in captured.err


def test_the_probe_applies_the_configured_log_level(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The probe logs at the level the settings name, as the run does."""
    write_kit(tmp_path)
    monkeypatch.setenv("FLEET_LOG_LEVEL", "WARNING")
    monkeypatch.setattr(cli, "build_crt_transport", _probe_factory())

    code = cli.main(
        [
            "probe-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            OTHER_ROBOT,
            "--kit-root",
            str(tmp_path),
        ]
    )

    assert code == EXIT_OK
    assert logging.getLogger().level == logging.WARNING


def test_the_probe_refuses_a_kit_it_cannot_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A kit the agent would refuse stops the probe before any connection is made: exit 78."""
    write_kit(tmp_path, kit_dir_mode=0o755)
    built: list[object] = []

    def factory(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> Transport:
        """Records that a connection would have been built, which must not happen.

        Args:
            kit: The loaded kit.
            port: The port.
            loop: The loop.

        Raises:
            AssertionError: Always, since no transport may be built for a refused kit.
        """
        built.append(kit)
        raise AssertionError("no transport for a refused kit")

    monkeypatch.setattr(cli, "build_crt_transport", factory)

    code = cli.main(
        [
            "probe-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            OTHER_ROBOT,
            "--kit-root",
            str(tmp_path),
        ]
    )

    assert code == EXIT_CONFIG
    assert built == []


def test_the_probe_refuses_a_bad_setting_before_connecting(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A setting the agent cannot use stops the probe before any connection: exit 78."""
    write_kit(tmp_path)
    monkeypatch.setenv("FLEET_TYPO", "1")
    monkeypatch.setattr(cli, "build_crt_transport", _probe_factory())

    code = cli.main(
        [
            "probe-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            OTHER_ROBOT,
            "--kit-root",
            str(tmp_path),
        ]
    )

    assert code == EXIT_CONFIG
    assert [record["event"] for record in _json_lines(capsys.readouterr().out)] == [
        "config.refused"
    ]


def test_the_probe_maps_a_transport_key_refusal_to_exit_78(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transport whose TLS context refuses the key exits 78, not with a traceback."""
    write_kit(tmp_path)

    def refusing(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> Transport:
        """Refuses the kit's key, as the TLS context does.

        Args:
            kit: The loaded kit.
            port: The port.
            loop: The loop.

        Raises:
            KitError: Always.
        """
        raise KitError("KIT_KEY_INVALID")

    monkeypatch.setattr(cli, "build_crt_transport", refusing)

    code = cli.main(
        [
            "probe-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            OTHER_ROBOT,
            "--kit-root",
            str(tmp_path),
        ]
    )

    assert code == EXIT_CONFIG


# Local video page


def _context_of(root: Path, *, simulated: bool = False) -> ServiceContext:
    """Builds the context a service factory receives, from the fixture kit.

    Args:
        root: The kit root holding the fixture kit.
        simulated: Whether the kit is marked as simulated.

    Returns:
        The context, with a snapshot that reports no state.
    """
    kit = load_kit(root, ROBOT_ID)
    if simulated:
        kit = replace(kit, config=kit.config.model_copy(update={"simulated": True}))
    return ServiceContext(kit=kit, snapshot=lambda: None)


def _captured_factory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Callable[[ServiceContext], tuple[object, ...]]:
    """Runs `run` with a fake runtime and returns the service factory it handed over.

    Args:
        tmp_path: The kit root holding the fixture kit.
        monkeypatch: The fixture that replaces the runtime.

    Returns:
        The service factory the command passed to the runtime.
    """
    captured: list[Callable[[ServiceContext], tuple[object, ...]]] = []

    async def fake_run_agent(settings: object, **kwargs: object) -> int:
        """Stands in for the runtime, and keeps the factory it was given.

        Args:
            settings: The settings the command resolved. Unused.
            **kwargs: The runtime's keyword arguments, which carry the factory.

        Returns:
            0.
        """
        del settings
        factory = kwargs["service_factory"]
        assert callable(factory)
        captured.append(factory)
        return EXIT_OK

    monkeypatch.setattr(cli, "run_agent", fake_run_agent)
    assert cli.main(["run", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)]) == EXIT_OK
    return captured[0]


def test_the_video_page_is_not_built_when_it_is_switched_off(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With FLEET_VIDEO_ENABLED=false the run builds no page, so nothing binds."""
    write_kit(tmp_path)
    monkeypatch.setenv("FLEET_VIDEO_ENABLED", "false")
    factory = _captured_factory(tmp_path, monkeypatch)

    assert factory(_context_of(tmp_path)) == ()


def test_the_video_page_is_built_for_a_real_robot_when_it_is_on(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """By default a real robot gets exactly one local video page, built but not started."""
    write_kit(tmp_path)
    factory = _captured_factory(tmp_path, monkeypatch)

    services = factory(_context_of(tmp_path))

    assert len(services) == 1
    assert isinstance(services[0], LocalVideoService)


def test_a_simulated_robot_gets_no_video_page(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A simulated robot has no camera: the factory returns no service, whatever the setting."""
    write_kit(tmp_path)
    factory = _captured_factory(tmp_path, monkeypatch)

    assert factory(_context_of(tmp_path, simulated=True)) == ()
    assert cli.video_service_factory(True, _context_of(tmp_path, simulated=True)) == ()


def test_an_invalid_video_switch_is_refused_by_name_and_its_value_is_not_echoed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A switch outside true, false, 1 and 0 exits 78, names the variable and omits the value."""
    write_kit(tmp_path)
    monkeypatch.setenv("FLEET_VIDEO_ENABLED", "maybe-not-a-flag")

    code = cli.main(["run", "--robot-id", ROBOT_ID, "--kit-root", str(tmp_path)])

    assert code == EXIT_CONFIG
    output = capsys.readouterr().out
    records = _json_lines(output)
    assert [(record["event"], record["reason"], record["label"]) for record in records] == [
        ("config.refused", "INVALID", "FLEET_VIDEO_ENABLED")
    ]
    assert "maybe-not-a-flag" not in output
