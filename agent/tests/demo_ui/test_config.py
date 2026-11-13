"""Tests of the settings of the demo control page: defaults, precedence, and the refused values."""

from __future__ import annotations

from pathlib import Path

import pytest

from fleet_agent.demo_ui import config
from fleet_agent.demo_ui.config import Settings, SettingsError, load_settings


def test_defaults_follow_the_simulator_and_the_home_directory(tmp_path: Path) -> None:
    settings = load_settings({"HOME": str(tmp_path)}, [])

    assert settings.site_id == "paris-01"
    assert settings.port == 8765
    assert settings.sim_count == 9
    assert settings.max_runtime_s == 7200
    assert settings.kit_root == tmp_path / ".fleet" / "robots"
    assert settings.sim_lock_path == tmp_path / ".local/state/fleet/sim.lock"
    assert settings.state_dir == tmp_path / ".local/state/fleet/demo-ui"


def test_xdg_state_home_moves_the_lock_the_same_way_as_the_scripts(tmp_path: Path) -> None:
    state = tmp_path / "state"

    settings = load_settings({"HOME": str(tmp_path), "XDG_STATE_HOME": str(state)}, [])

    assert settings.sim_lock_path == state / "fleet" / "sim.lock"


def test_site_precedence_is_command_line_then_environment_then_default(tmp_path: Path) -> None:
    env = {"HOME": str(tmp_path), "SIM_SITE_ID": "lyon-02"}

    assert load_settings(env, []).site_id == "lyon-02"
    assert load_settings(env, ["--site-id", "nice-03"]).site_id == "nice-03"
    assert load_settings({"HOME": str(tmp_path), "SIM_SITE_ID": ""}, []).site_id == "paris-01"


@pytest.mark.parametrize("site", ["../x", "ab", "Paris-01", "x" * 33, "paris 01"])
def test_malformed_site_is_refused(tmp_path: Path, site: str) -> None:
    with pytest.raises(SettingsError, match="site identifier"):
        load_settings({"HOME": str(tmp_path)}, ["--site-id", site])


@pytest.mark.parametrize("value", ["0", "21", "-1", "many", "1.5"])
def test_simulator_count_outside_one_to_twenty_is_refused(tmp_path: Path, value: str) -> None:
    with pytest.raises(SettingsError, match="SIM_N"):
        load_settings({"HOME": str(tmp_path), "SIM_N": value}, [])


@pytest.mark.parametrize("value", ["0", "14401", "soon"])
def test_runtime_outside_its_range_is_refused(tmp_path: Path, value: str) -> None:
    with pytest.raises(SettingsError, match="SIM_MAX_RUNTIME_S"):
        load_settings({"HOME": str(tmp_path), "SIM_MAX_RUNTIME_S": value}, [])


def test_only_the_loopback_host_is_accepted(tmp_path: Path) -> None:
    with pytest.raises(SettingsError, match=r"127\.0\.0\.1"):
        # The address is only a value to refuse: nothing is bound to it.
        load_settings({"HOME": str(tmp_path)}, ["--host", "0.0.0.0"])  # noqa: S104

    assert load_settings({"HOME": str(tmp_path)}, ["--host", "127.0.0.1"]).port == 8765


@pytest.mark.parametrize("port", ["70000", "-1", "web"])
def test_port_outside_the_range_is_a_usage_error(tmp_path: Path, port: str) -> None:
    with pytest.raises(SystemExit):
        load_settings({"HOME": str(tmp_path)}, ["--port", port])


def test_port_zero_asks_for_a_free_port(tmp_path: Path) -> None:
    assert load_settings({"HOME": str(tmp_path)}, ["--port", "0"]).port == 0


def test_page_refuses_to_run_outside_a_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "_default_repo_root", lambda: tmp_path)

    with pytest.raises(SettingsError, match="repository checkout"):
        load_settings({"HOME": str(tmp_path)}, [])


def test_scripts_and_paths_are_derived_from_the_checkout(tmp_path: Path) -> None:
    settings = load_settings({"HOME": str(tmp_path)}, [])

    assert settings.script("sim.sh") == settings.repo_root / "scripts" / "sim.sh"
    assert settings.stack_dir == settings.repo_root / "infra" / "envs" / "demo"
    assert settings.sim_log_path == settings.state_dir / "sim.log"


def test_settings_are_immutable(tmp_path: Path) -> None:
    settings = load_settings({"HOME": str(tmp_path)}, [])

    with pytest.raises(AttributeError):
        settings.port = 1  # type: ignore[misc]
    assert isinstance(settings, Settings)
