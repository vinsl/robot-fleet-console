"""Tests of the `sim` command line: its usage errors,
its exit codes and the configuration it builds."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

import pytest

from fleet_agent import cli
from fleet_agent.sim.fleet import SimConfig
from tests.sim.support import SAMPLE_MAP_PATH


@pytest.fixture(autouse=True)
def _restored_root_logger() -> Iterator[None]:
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


def _sim_arguments(map_path: Path = SAMPLE_MAP_PATH, *extra: str) -> list[str]:
    """Builds the arguments of a `sim` run with the required options.

    Args:
        map_path: The map to name.
        *extra: Any further arguments.

    Returns:
        The argument list, without the program name.
    """
    return ["sim", "--count", "2", "--site-id", "paris-01", "--map", str(map_path), *extra]


def test_the_sim_help_documents_the_options(capsys: pytest.CaptureFixture[str]) -> None:
    """Given the `sim` command, when its help is asked for,
    then it exits 0 and names its options."""
    with pytest.raises(SystemExit) as exited:
        cli.main(["sim", "--help"])

    assert exited.value.code == 0
    text = capsys.readouterr().out
    for option in (
        "--count",
        "--site-id",
        "--map",
        "--max-runtime-seconds",
        "--fault-rate-per-hour",
    ):
        assert option in text


def test_a_missing_count_is_a_usage_error() -> None:
    """Given no count, when the command is parsed, then it is a usage error (64)."""
    assert cli.main(["sim", "--site-id", "paris-01", "--map", str(SAMPLE_MAP_PATH)]) == 64


def test_a_site_identifier_outside_the_grammar_is_a_usage_error() -> None:
    """Given a site identifier with a space, when parsed, then it is a usage error (64)."""
    code = cli.main(["sim", "--count", "1", "--site-id", "bad site", "--map", str(SAMPLE_MAP_PATH)])

    assert code == 64


def test_the_no_timeout_option_is_gone_and_is_a_usage_error() -> None:
    """Given --no-timeout, when parsed, then it is refused as an unknown option (64).

    A run always has an auto-stop, so there is no option that removes it (THREAT_MODEL T22).
    """
    code = cli.main(_sim_arguments(SAMPLE_MAP_PATH, "--no-timeout"))

    assert code == 64


def test_a_runtime_above_the_four_hour_cap_exits_78_before_any_connection(tmp_path: Path) -> None:
    """Given a runtime of 14401 seconds, when the command runs,
    then it exits 78 and the kit root is never read."""
    code = cli.main(
        _sim_arguments(
            SAMPLE_MAP_PATH,
            "--max-runtime-seconds",
            "14401",
            "--kit-root",
            str(tmp_path / "absent"),
        )
    )

    assert code == 78


def test_an_out_of_range_count_exits_78_before_any_connection(tmp_path: Path) -> None:
    """Given a count of 21, when the command runs,
    then it exits 78 and the kit root is never read."""
    code = cli.main(
        [
            "sim",
            "--count",
            "21",
            "--site-id",
            "paris-01",
            "--map",
            str(SAMPLE_MAP_PATH),
            "--kit-root",
            str(tmp_path / "absent"),
        ]
    )

    assert code == 78


def test_the_command_builds_the_configuration_from_its_options(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Given the options of a run, when the command runs,
    then the fleet receives the matching configuration."""
    received: list[SimConfig] = []

    async def fake_fleet(config: SimConfig, **kwargs: object) -> int:
        """Records the configuration and reports a clean run.

        Args:
            config: The configuration the command built.
            **kwargs: The factory. Unused.

        Returns:
            0.
        """
        del kwargs
        received.append(config)
        return 0

    monkeypatch.setattr(cli, "run_fleet", fake_fleet)

    code = cli.main(
        _sim_arguments(
            SAMPLE_MAP_PATH,
            "--prefix",
            "lab",
            "--seed",
            "9",
            "--fault-rate-per-hour",
            "0",
            "--max-runtime-seconds",
            "60",
            "--stagger-ms",
            "100",
            "--kit-root",
            str(tmp_path),
        )
    )

    assert code == 0
    (config,) = received
    assert config.count == 2
    assert config.site_id == "paris-01"
    assert config.prefix == "lab"
    assert config.seed == 9
    assert config.fault_rate_per_hour == 0.0
    assert config.max_runtime_s == 60
    assert config.stagger_ms == 100
    assert config.kit_root == tmp_path
    assert config.map_path == SAMPLE_MAP_PATH


def test_the_default_run_stops_after_two_hours_and_uses_the_default_kit_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given no timeout or kit root option, when the command runs,
    then the run has the two-hour limit and the default root."""
    received: list[SimConfig] = []

    async def fake_fleet(config: SimConfig, **kwargs: object) -> int:
        """Records the configuration and reports a clean run.

        Args:
            config: The configuration the command built.
            **kwargs: The factory. Unused.

        Returns:
            0.
        """
        del kwargs
        received.append(config)
        return 0

    monkeypatch.setattr(cli, "run_fleet", fake_fleet)

    cli.main(_sim_arguments(SAMPLE_MAP_PATH))

    (config,) = received
    assert config.max_runtime_s == 7200
    assert config.kit_root == Path.home() / ".fleet" / "robots"
    assert config.fault_rate_per_hour == 6.0
