"""Command line of the robot agent: `run`, the two isolation probes, `estop-command` and `sim`.

Exit codes are stable, because the Makefile, the runbook and systemd read them:
0 for success, 1 when an isolation probe found a failed check, 64 for a usage error, 70 when the
core halted, 75 when another simulator already runs on this host, 78 when the settings, the kit,
the latch or the simulator's parameters cannot be used, and 130 when a second stop signal forced
the exit.

Each command logs at the configured level. `run`, `probe-isolation` and `probe-video-isolation`
write their log lines to standard output, and the probes' `probe.result` lines are their result, so
they are written there too. `estop-command` writes exactly one JSON line to standard output, so its
logs go to standard error.
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import logging
import os
import sys
from collections.abc import Callable, Coroutine, Mapping, Sequence
from pathlib import Path
from typing import Any, Final, NoReturn

from pydantic import TypeAdapter, ValidationError

from fleet_agent.adapters.mqtt_crt import build_crt_transport
from fleet_agent.adapters.system_clock import SystemClock
from fleet_agent.config.kit_file import KitError, LoadedKit, is_robot_id, load_kit, log_kit_refusal
from fleet_agent.config.settings import (
    AgentSettings,
    SettingsError,
    default_kit_root,
    load_settings,
)
from fleet_agent.logs import configure_logging
from fleet_agent.protocol.primitives import SiteId
from fleet_agent.runtime.runner import (
    EXIT_CONFIG,
    EXIT_OK,
    RuntimeService,
    ServiceContext,
    run_agent,
)
from fleet_agent.sim.fleet import RUNTIME_LIMIT_S, SimConfig, run_fleet
from fleet_agent.tools.estop_command import build_estop_command
from fleet_agent.tools.isolation_probe import ProbeResult, run_isolation_probe
from fleet_agent.tools.video_isolation_probe import (
    other_channel_arn_for,
    run_video_isolation_probe,
)
from fleet_agent.video.service import LocalVideoService

EXIT_USAGE: Final = 64
"""The command line was not understood."""

EXIT_PROBE_FAILED: Final = 1
"""The isolation probe ran, and at least one check did not behave as the policy requires."""

_LOG: Final = logging.getLogger("fleet_agent.cli")
_SITE_ID: Final = TypeAdapter(SiteId)
_PROBE_NOTICE: Final = (
    "fleet-agent: stop the agent first. The probe connects with the robot's own identity, "
    "and a second connection with the same client identifier makes the broker drop the agent.\n"
)


_USAGE_PREFIX: Final = "fleet-agent: error: "

_ProbeRun = Callable[[AgentSettings, LoadedKit], Coroutine[Any, Any, list[ProbeResult]]]
"""Runs one isolation probe with the resolved settings and the robot's kit."""
"""The prefix of every usage error on standard error, as the parser writes its own."""


class _UsageError(Exception):
    """A command line the parser refused. Its message names the problem, never a value."""


class _Parser(argparse.ArgumentParser):
    """An argument parser that raises on a usage error, so that `main` picks the exit code."""

    def error(self, message: str) -> NoReturn:
        """Raises instead of exiting, so that the usage error gets its own exit code.

        Args:
            message: The parser's message.

        Raises:
            _UsageError: Always.
        """
        raise _UsageError(message)


def main(argv: Sequence[str] | None = None) -> int:
    """Runs one command of the agent and returns its exit code.

    Args:
        argv: The arguments without the program name. Defaults to the process arguments.

    Returns:
        The exit code of the command.
    """
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except _UsageError as err:
        sys.stderr.write(parser.format_usage())
        sys.stderr.write(f"{_USAGE_PREFIX}{err}\n")
        return EXIT_USAGE
    handler = _HANDLERS.get(args.command)
    if handler is None:
        sys.stderr.write(parser.format_usage())
        sys.stderr.write(f"{_USAGE_PREFIX}unknown command\n")
        return EXIT_USAGE
    return handler(args)


def _build_parser() -> argparse.ArgumentParser:
    """Builds the parser with its three commands.

    Returns:
        The top-level parser.
    """
    parser = _Parser(
        prog="fleet-agent",
        description="Fleet robot agent: runs one robot, and checks its isolation and e-stop.",
    )
    commands = parser.add_subparsers(
        dest="command",
        required=True,
        parser_class=_Parser,
        metavar="COMMAND",
    )

    run = commands.add_parser(
        "run",
        help="run the robot agent until it is stopped",
        description="Connects the robot to the fleet and runs it until SIGTERM or SIGINT.",
    )
    _add_robot_arguments(run)

    probe = commands.add_parser(
        "probe-isolation",
        help="check that the robot policy keeps the robot to its own topics",
        description=(
            "Runs nine checks with the robot's own identity and prints one probe.result line per "
            "check. Stop the agent first: the probe connects with the robot's identity."
        ),
    )
    _add_robot_arguments(probe)
    probe.add_argument(
        "--other-robot-id",
        required=True,
        type=_robot_id_argument,
        help="the other robot, whose topics the robot must be refused",
    )
    probe.add_argument(
        "--other-site-id",
        type=_site_id_argument,
        default=None,
        help="the site of the other robot; defaults to the robot's own site",
    )

    video_probe = commands.add_parser(
        "probe-video-isolation",
        help="check that the robot's video identity reaches only its own channel",
        description=(
            "Runs six read-only checks with the robot's video credentials and prints one "
            "probe.result line per check. It needs no MQTT connection, so the agent may keep "
            "running."
        ),
    )
    _add_robot_arguments(video_probe)
    video_probe.add_argument(
        "--other-robot-id",
        required=True,
        type=_robot_id_argument,
        help="the other robot, whose channel and credentials the robot must be refused",
    )
    video_probe.add_argument(
        "--other-channel-arn",
        default=None,
        help="the other robot's real channel ARN, when the synthetic one is not enough",
    )

    estop = commands.add_parser(
        "estop-command",
        help="print one ESTOP command for the robot, to publish by hand",
        description="Prints one validated ESTOP command as one JSON line on standard output.",
    )
    _add_robot_arguments(estop)

    sim = commands.add_parser(
        "sim",
        help="run simulated robots on a site map, until stopped or for two hours",
        description=(
            "Runs N simulated robots in this process, each with its own kit and the production "
            "agent core. They drive around the walls of the site map, take missions and suffer "
            "random faults. Only a kit that says it is simulated is accepted. One simulator "
            "runs per host: a second one exits 75 at once."
        ),
    )
    sim.add_argument(
        "--count",
        required=True,
        type=int,
        help="the number of simulated robots, from 1 to 20",
    )
    sim.add_argument(
        "--site-id",
        required=True,
        type=_site_id_argument,
        help="the site the robots belong to; every kit must name it",
    )
    sim.add_argument(
        "--map",
        dest="map_path",
        required=True,
        type=Path,
        help="the site map, as GeoJSON in the local metric frame",
    )
    sim.add_argument(
        "--prefix",
        default="sim",
        help="the prefix of the robot identifiers, which end in -01 to -NN (default: sim)",
    )
    sim.add_argument(
        "--seed",
        type=int,
        default=1,
        help="the seed of the run: the same seed gives the same missions and faults (default: 1)",
    )
    sim.add_argument(
        "--fault-rate-per-hour",
        type=float,
        default=6.0,
        help="the mean random faults per robot per hour; 0 disables them (default: 6)",
    )
    sim.add_argument(
        "--max-runtime-seconds",
        type=int,
        default=RUNTIME_LIMIT_S,
        help="the auto-stop of the run, in seconds, at most 14400 (default: 7200)",
    )
    sim.add_argument(
        "--stagger-ms",
        type=int,
        default=250,
        help="the gap between two robot starts, in milliseconds (default: 250)",
    )
    sim.add_argument(
        "--kit-root",
        type=Path,
        default=None,
        help="the directory holding one kit per robot; defaults to ~/.fleet/robots",
    )
    return parser


def _add_robot_arguments(parser: argparse.ArgumentParser) -> None:
    """Adds the options that locate a robot: its identifier and the kit root.

    Both can also come from the environment or the optional settings file.

    Args:
        parser: The command's parser.
    """
    parser.add_argument(
        "--robot-id",
        type=_robot_id_argument,
        default=None,
        help="the robot to run; defaults to FLEET_ROBOT_ID",
    )
    parser.add_argument(
        "--kit-root",
        type=Path,
        default=None,
        help="the directory holding one kit per robot; defaults to FLEET_KIT_ROOT",
    )


def _robot_id_argument(value: str) -> str:
    """Accepts a robot identifier, and refuses anything else at parse time.

    Args:
        value: The value given on the command line.

    Returns:
        The identifier.

    Raises:
        argparse.ArgumentTypeError: If the value is not a robot identifier. The value is not echoed.
    """
    if not is_robot_id(value):
        raise argparse.ArgumentTypeError("not a robot identifier")
    return value


def _site_id_argument(value: str) -> str:
    """Accepts a site identifier, and refuses anything else at parse time.

    Args:
        value: The value given on the command line.

    Returns:
        The identifier.

    Raises:
        argparse.ArgumentTypeError: If the value is not a site identifier. The value is not echoed.
    """
    try:
        return _SITE_ID.validate_python(value)
    except ValidationError:
        raise argparse.ArgumentTypeError("not a site identifier") from None


def video_service_factory(
    enabled: bool,
    ctx: ServiceContext,
) -> tuple[RuntimeService, ...]:
    """Builds the local video page of a real robot, unless the page is switched off.

    A simulated robot has no camera, so it gets no page and nothing is logged for it. The
    setting is bound with `functools.partial`, so the factory's only runtime argument is the
    context.

    Args:
        enabled: Whether the page is switched on (`FLEET_VIDEO_ENABLED`).
        ctx: The kit and the read-only view of the core.

    Returns:
        The page service, or no service when the page is off or the robot is simulated.
    """
    if not enabled or ctx.kit.config.simulated:
        return ()
    return (LocalVideoService(ctx.kit, ctx.snapshot),)


def _run(args: argparse.Namespace) -> int:
    """Runs the robot agent until it is stopped, with the logs at the configured level.

    The local video page is built beside the core, unless the settings switch it off.

    Args:
        args: The parsed arguments of `run`.

    Returns:
        The exit code of the run.
    """
    configure_logging("INFO")
    settings = _settings_of(args)
    if settings is None:
        return EXIT_CONFIG
    configure_logging(settings.log_level)
    factory = functools.partial(video_service_factory, settings.video_enabled)
    return asyncio.run(run_agent(settings, service_factory=factory))


def _probe_isolation(args: argparse.Namespace) -> int:
    """Runs the isolation probe and reports one line per check.

    The other robot must be a different robot: a probe against the robot itself would test
    nothing, since its own topics are the ones it is allowed.

    Args:
        args: The parsed arguments of `probe-isolation`.

    Returns:
        0 when every check passed, 1 when one failed, 64 for a probe against the robot itself,
        or a configuration exit code.
    """
    other_robot_id: str = args.other_robot_id
    other_site_id: str | None = args.other_site_id

    async def probe(settings: AgentSettings, kit: LoadedKit) -> list[ProbeResult]:
        """Runs the MQTT isolation checks of the kit.

        Args:
            settings: The resolved settings, for the broker port.
            kit: The robot's loaded kit.

        Returns:
            One result per check.
        """
        return await run_isolation_probe(
            kit,
            other_site_id=other_site_id if other_site_id is not None else kit.config.site_id,
            other_robot_id=other_robot_id,
            port=settings.mqtt_port,
            transport_factory=build_crt_transport,
        )

    return _run_probe(args, probe, notice=_PROBE_NOTICE)


def _probe_video_isolation(args: argparse.Namespace) -> int:
    """Runs the video isolation probe and reports one line per check.

    The other robot must be a different robot, and an optional channel ARN must name that
    robot's channel. The probe uses only the robot's own kit and is safe to run while the agent
    runs.

    Args:
        args: The parsed arguments of `probe-video-isolation`.

    Returns:
        0 when every check passed, 1 when one failed, 64 for a usage error, or a configuration
        exit code.
    """
    other_robot_id: str = args.other_robot_id
    other_channel_arn: str | None = args.other_channel_arn

    def channel_arn_error() -> str | None:
        """Checks the optional channel ARN without echoing its value.

        Returns:
            The usage message when the ARN is not that robot's channel, otherwise None.
        """
        if other_channel_arn is None:
            return None
        try:
            other_channel_arn_for(other_channel_arn, other_robot_id)
        except ValueError:
            return "--other-channel-arn is not that robot's channel"
        return None

    async def probe(_settings: AgentSettings, kit: LoadedKit) -> list[ProbeResult]:
        """Runs the video checks of the kit. The ARN was checked by `channel_arn_error`.

        Args:
            _settings: The resolved settings. Unused by this probe.
            kit: The robot's loaded kit.

        Returns:
            One result per check.
        """
        return await run_video_isolation_probe(
            kit,
            other_robot_id=other_robot_id,
            other_channel_arn=other_channel_arn,
        )

    return _run_probe(args, probe, argument_error=channel_arn_error)


def _no_argument_error() -> str | None:
    """Accepts every argument. It is the default for a probe with no argument of its own.

    Returns:
        None, always.
    """
    return None


def _run_probe(
    args: argparse.Namespace,
    probe: _ProbeRun,
    *,
    argument_error: Callable[[], str | None] = _no_argument_error,
    notice: str | None = None,
) -> int:
    """Resolves the settings and the kit, runs one isolation probe and reports its checks.

    The two isolation probes share this scaffold: logging, the refusal of a probe against the
    robot itself, the kit, the refusal of a kit that the TLS context rejects, and one
    `probe.result` line per check.

    Args:
        args: The parsed arguments of the probe command, with the robot and kit root options.
        probe: Runs the probe with the resolved settings and the kit.
        argument_error: Returns the usage message for a bad argument of the probe, or None. It runs
            before the kit is loaded, so a bad argument is reported before a missing kit.
        notice: Written to standard error before the probe runs, when given.

    Returns:
        0 when every check passed, 1 when one failed, 64 for a usage error, or a configuration
        exit code.
    """
    configure_logging("INFO")
    settings = _settings_of(args)
    if settings is None:
        return EXIT_CONFIG
    configure_logging(settings.log_level)
    other_robot_id: str = args.other_robot_id
    if other_robot_id == settings.robot_id:
        sys.stderr.write(f"{_USAGE_PREFIX}--other-robot-id must not be the robot itself\n")
        return EXIT_USAGE
    message = argument_error()
    if message is not None:
        sys.stderr.write(f"{_USAGE_PREFIX}{message}\n")
        return EXIT_USAGE
    kit = _kit_of(settings)
    if kit is None:
        return EXIT_CONFIG
    if notice is not None:
        sys.stderr.write(notice)
    try:
        results = asyncio.run(probe(settings, kit))
    except KitError as err:
        log_kit_refusal(err)
        return EXIT_CONFIG
    _log_probe_results(results)
    return EXIT_OK if all(result.passed for result in results) else EXIT_PROBE_FAILED


def _log_probe_results(results: Sequence[ProbeResult]) -> None:
    """Writes one `probe.result` line per check, shared by both isolation probes.

    The line reuses the fields for its own meaning: the label is the check's name, the reason is
    the policy the check expects, and the outcome is what was observed.

    Args:
        results: The results, in the order the checks ran.
    """
    for result in results:
        _LOG.info(
            "probe.result",
            extra={
                "label": result.check,
                "reason": result.expected,
                "outcome": result.observed,
                "result": "PASS" if result.passed else "FAIL",
            },
        )


def _estop_command(args: argparse.Namespace) -> int:
    """Prints one ESTOP command for the robot, as one JSON line on standard output.

    Logs go to standard error, so that standard output carries only the command.

    Args:
        args: The parsed arguments of `estop-command`.

    Returns:
        0 on success, or a configuration exit code.
    """
    configure_logging("INFO", stream=sys.stderr)
    settings = _settings_of(args)
    if settings is None:
        return EXIT_CONFIG
    configure_logging(settings.log_level, stream=sys.stderr)
    kit = _kit_of(settings)
    if kit is None:
        return EXIT_CONFIG
    line = build_estop_command(kit.config, now_wall_ms=SystemClock().wall_ms())
    sys.stdout.write(f"{line}\n")
    return EXIT_OK


def _sim(args: argparse.Namespace) -> int:
    """Runs the simulated fleet until every robot has stopped.

    The parameters are checked by the fleet before anything connects, so an out-of-range count
    exits 78 with the reason logged, not as a usage error.

    Args:
        args: The parsed arguments of `sim`.

    Returns:
        The exit code of the fleet.
    """
    configure_logging("INFO")
    kit_root: Path | None = args.kit_root
    config = SimConfig(
        count=args.count,
        site_id=args.site_id,
        prefix=args.prefix,
        map_path=args.map_path,
        kit_root=kit_root if kit_root is not None else default_kit_root(),
        seed=args.seed,
        fault_rate_per_hour=args.fault_rate_per_hour,
        max_runtime_s=args.max_runtime_seconds,
        stagger_ms=args.stagger_ms,
    )
    return asyncio.run(run_fleet(config))


def _settings_of(args: argparse.Namespace) -> AgentSettings | None:
    """Resolves the settings of a command, logging the refusal when they cannot be used.

    Args:
        args: The parsed arguments, with the robot and kit root options.

    Returns:
        The validated settings, or None when they are refused.
    """
    robot_id: str | None = args.robot_id
    kit_root: Path | None = args.kit_root
    try:
        return load_settings(robot_id=robot_id, kit_root=kit_root, environ=os.environ)
    except SettingsError as err:
        # The config.refused line reuses `label` for the name of the setting that failed.
        _LOG.error("config.refused", extra={"reason": err.code, "label": err.name})
        return None


def _kit_of(settings: AgentSettings) -> LoadedKit | None:
    """Loads the kit of the settings, logging the refusal when it cannot be used.

    Args:
        settings: The validated settings, which name the robot and the kit root.

    Returns:
        The loaded kit, or None when it is refused.
    """
    try:
        return load_kit(settings.kit_root, settings.robot_id)
    except KitError as err:
        log_kit_refusal(err)
        return None


_HANDLERS: Final[Mapping[str, Callable[[argparse.Namespace], int]]] = {
    "run": _run,
    "probe-isolation": _probe_isolation,
    "probe-video-isolation": _probe_video_isolation,
    "estop-command": _estop_command,
    "sim": _sim,
}
"""Each command's handler, by its name. A command outside this table is a usage error, so no
command runs by falling through to another one."""
