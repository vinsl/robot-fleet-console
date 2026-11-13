"""Tests of the settings: precedence, the environment map, the TOML file rules and validation."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from fleet_agent.config.settings import (
    SETTINGS_FILE_NAME,
    AgentSettings,
    SettingsError,
    default_kit_root,
    geometry_of,
    load_settings,
)

ROBOT = "kali-01"


def _robot_dir(root: Path, robot_id: str = ROBOT) -> Path:
    """Creates a private robot directory under the kit root.

    Args:
        root: The kit root.
        robot_id: The directory name.

    Returns:
        The robot directory.
    """
    directory = root / robot_id
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    return directory


def _settings_file(root: Path, text: str, mode: int = 0o600, robot_id: str = ROBOT) -> Path:
    """Writes the optional settings file of a robot, with the given mode.

    Args:
        root: The kit root.
        text: The TOML text.
        mode: The mode of the file.
        robot_id: The robot whose directory receives the file.

    Returns:
        The path of the settings file.
    """
    path = _robot_dir(root, robot_id) / SETTINGS_FILE_NAME
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)
    return path


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """Provides an empty private kit root.

    Args:
        tmp_path: The per-test directory.

    Returns:
        The kit root.
    """
    directory = tmp_path / "robots"
    directory.mkdir()
    directory.chmod(0o700)
    return directory


def test_defaults_apply_when_nothing_is_set(root: Path) -> None:
    """With no file and no environment, every setting takes its documented default."""
    settings = load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert settings.mqtt_port == 8883
    assert settings.log_level == "INFO"
    assert settings.start_x == 5.0
    assert settings.charger_x == 1.0
    assert settings.speed_mps == 0.5
    assert settings.battery_start == 80.0


def test_precedence_is_defaults_then_file_then_environment(root: Path) -> None:
    """The file overrides the defaults, and the environment overrides the file."""
    _settings_file(root, "speed_mps = 0.7\nbattery_start = 50.0\nstart_x = 1.0\n")

    settings = load_settings(
        robot_id=ROBOT,
        kit_root=root,
        environ={"FLEET_START_X": "2.5"},
    )

    assert settings.speed_mps == 0.7
    assert settings.battery_start == 50.0
    assert settings.start_x == 2.5
    assert settings.start_y == 5.0


def test_command_line_identifier_beats_the_environment(root: Path) -> None:
    """A command-line robot identifier wins over the environment and locates the file."""
    _settings_file(root, "speed_mps = 0.9\n")

    settings = load_settings(
        robot_id=ROBOT,
        kit_root=root,
        environ={"FLEET_ROBOT_ID": "sim-99"},
    )

    assert settings.robot_id == ROBOT
    assert settings.speed_mps == 0.9


def test_command_line_kit_root_beats_the_environment(root: Path, tmp_path: Path) -> None:
    """A kit root given on the command line wins over the environment."""
    other = tmp_path / "other"

    settings = load_settings(
        robot_id=ROBOT,
        kit_root=root,
        environ={"FLEET_KIT_ROOT": str(other)},
    )

    assert settings.kit_root == root


def test_environment_kit_root_beats_the_default(root: Path) -> None:
    """A kit root from the environment is used when the command line gives none."""
    settings = load_settings(robot_id=ROBOT, kit_root=None, environ={"FLEET_KIT_ROOT": str(root)})

    assert settings.kit_root == root


def test_default_kit_root_is_the_fleet_directory_of_the_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Without any kit root, the default is `.fleet/robots` under the home directory."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    settings = load_settings(robot_id=ROBOT, kit_root=None, environ={})

    assert settings.kit_root == tmp_path / ".fleet" / "robots"
    assert default_kit_root() == tmp_path / ".fleet" / "robots"


def test_refuses_an_unknown_fleet_variable_by_name(root: Path) -> None:
    """A `FLEET_*` variable the agent does not read is refused, and its name is reported."""
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={"FLEET_FOO": "1"})

    assert caught.value.code == "UNKNOWN_ENV"
    assert caught.value.name == "FLEET_FOO"


def test_ignores_variables_outside_the_prefix(root: Path) -> None:
    """Variables that do not start with `FLEET_` are not the agent's business."""
    settings = load_settings(robot_id=ROBOT, kit_root=root, environ={"PATH": "/usr/bin"})

    assert settings.robot_id == ROBOT


def test_refuses_a_robot_identifier_in_the_file(root: Path) -> None:
    """The file cannot choose the robot, so a `robot_id` key in it is refused by name."""
    _settings_file(root, 'robot_id = "sim-99"\n')

    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert caught.value.code == "FORBIDDEN_TOML_KEY"
    assert caught.value.name == "robot_id"


def test_refuses_a_kit_root_in_the_file(root: Path) -> None:
    """The file cannot move the kit root either."""
    _settings_file(root, 'kit_root = "/tmp"\n')

    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert caught.value.code == "FORBIDDEN_TOML_KEY"


def test_refuses_a_group_writable_file(root: Path) -> None:
    """A settings file another user can write gives TOML_INSECURE."""
    _settings_file(root, "speed_mps = 0.6\n", mode=0o664)

    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert caught.value.code == "TOML_INSECURE"


def test_accepts_a_file_readable_by_others(root: Path) -> None:
    """A settings file that others can read, but not write, is accepted: it holds no secret."""
    _settings_file(root, "speed_mps = 0.6\n", mode=0o644)

    settings = load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert settings.speed_mps == 0.6


def test_refuses_a_file_that_is_not_toml(root: Path) -> None:
    """A settings file that does not parse gives TOML_INVALID."""
    _settings_file(root, "speed_mps = = 1\n")

    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert caught.value.code == "TOML_INVALID"


def test_a_settings_file_nested_past_the_parser_limit_is_invalid(root: Path) -> None:
    """Deep nesting makes the TOML parser hit its recursion limit: refused as invalid TOML."""
    # Stays under MAX_SETTINGS_BYTES, so that the nesting, not the size, is what is tested.
    _settings_file(root, "speed_mps = " + "[" * 15_000)

    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert caught.value.code == "TOML_INVALID"


def test_an_empty_kit_root_variable_is_the_same_as_no_variable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """An empty `FLEET_KIT_ROOT` is unset: the default root applies, not the working directory."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    settings = load_settings(robot_id=ROBOT, kit_root=None, environ={"FLEET_KIT_ROOT": ""})

    assert settings.kit_root == tmp_path / ".fleet" / "robots"


def test_a_settings_file_in_a_directory_others_can_write_is_not_read(root: Path) -> None:
    """A robot directory another user can write yields no settings; the kit check refuses it."""
    _settings_file(root, "speed_mps = 0.6\n")
    _robot_dir(root).chmod(0o775)

    settings = load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert settings.speed_mps == 0.5


def test_refuses_an_out_of_range_speed_by_field_name(root: Path) -> None:
    """A speed above the limit gives INVALID, naming the field and not the value."""
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={"FLEET_SPEED_MPS": "3"})

    assert caught.value.code == "INVALID"
    assert caught.value.name == "speed_mps"


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_refuses_a_non_finite_coordinate(root: Path, value: str) -> None:
    """A coordinate that is not a finite number is refused by its range check."""
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={"FLEET_START_X": value})

    assert caught.value.code == "INVALID"
    assert caught.value.name == "start_x"


def test_accepts_the_port_as_text_from_the_environment(root: Path) -> None:
    """An environment variable carries text, so a port written as digits is accepted."""
    settings = load_settings(robot_id=ROBOT, kit_root=root, environ={"FLEET_MQTT_PORT": "443"})

    assert settings.mqtt_port == 443


def test_accepts_an_integer_port_from_the_file(root: Path) -> None:
    """A port written as an integer in the file needs no conversion and is accepted."""
    _settings_file(root, "mqtt_port = 443\n")

    settings = load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert settings.mqtt_port == 443


def test_refuses_a_port_other_than_the_two_allowed(root: Path) -> None:
    """Only 8883 and 443 are ports the agent connects to."""
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={"FLEET_MQTT_PORT": "1883"})

    assert caught.value.code == "INVALID"
    assert caught.value.name == "mqtt_port"


def test_refuses_a_missing_robot_identifier(root: Path) -> None:
    """Without an identifier from the command line or the environment, the run is refused."""
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=None, kit_root=root, environ={})

    assert caught.value.code == "INVALID"
    assert caught.value.name == "robot_id"


def test_refuses_an_identifier_that_is_not_a_robot_id(root: Path) -> None:
    """An identifier with a separator is refused, and no settings file is read for it."""
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id="../etc", kit_root=root, environ={})

    assert caught.value.code == "INVALID"
    assert caught.value.name == "robot_id"


def test_there_is_no_simulated_setting(root: Path) -> None:
    """A robot is simulated only by its kit, so no setting or file key can say so."""
    assert "simulated" not in AgentSettings.model_fields

    _settings_file(root, "simulated = true\n")
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={})

    assert caught.value.code == "INVALID"
    assert caught.value.name == "simulated"


def test_geometry_follows_the_settings(root: Path) -> None:
    """The site layout takes the charger and start pose of the settings."""
    settings = load_settings(
        robot_id=ROBOT,
        kit_root=root,
        environ={"FLEET_CHARGER_X": "2", "FLEET_START_HEADING": str(math.pi / 2)},
    )

    geometry = geometry_of(settings)

    assert geometry.charger.x == 2.0
    assert geometry.charger.y == 1.0
    assert geometry.start.x == 5.0
    assert geometry.start_heading == pytest.approx(math.pi / 2)
    assert geometry.speed_mps == 0.5


def test_the_video_page_is_on_by_default(root: Path) -> None:
    """Without the switch the local video page is served."""
    assert load_settings(robot_id=ROBOT, kit_root=root, environ={}).video_enabled is True


@pytest.mark.parametrize(
    ("text", "expected"),
    [("true", True), ("1", True), ("false", False), ("0", False)],
)
def test_the_video_switch_accepts_only_the_four_spellings(
    root: Path, text: str, expected: bool
) -> None:
    """The switch reads true, false, 1 and 0, and nothing else."""
    settings = load_settings(robot_id=ROBOT, kit_root=root, environ={"FLEET_VIDEO_ENABLED": text})

    assert settings.video_enabled is expected


@pytest.mark.parametrize("text", ["yes", "on", "TRUE", "ture", ""])
def test_refuses_any_other_video_switch_by_variable_name(root: Path, text: str) -> None:
    """A switch outside the four spellings is refused by its variable, never by its value."""
    with pytest.raises(SettingsError) as caught:
        load_settings(robot_id=ROBOT, kit_root=root, environ={"FLEET_VIDEO_ENABLED": text})

    assert caught.value.code == "INVALID"
    assert caught.value.name == "FLEET_VIDEO_ENABLED"
    assert str(caught.value) == "INVALID"
