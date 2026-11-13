"""Agent settings: defaults, then an optional TOML file, then the environment, then flags.

Plain pydantic with the standard `tomllib` is used rather than a settings framework: the TOML
file's location depends on the robot identifier, which environment-driven settings sources do not
express cleanly. The file is read under the same owner-only rules as the kit.

There is deliberately no `simulated` setting. A robot is simulated only when its kit says so, so
that a real robot cannot be turned into a fault-injectable one from the environment (T20).
"""

from __future__ import annotations

import math
import tomllib
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Final, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from fleet_agent.config.files import InsecureFileError, check_private_dir, read_checked_file
from fleet_agent.config.kit_file import is_robot_id, kit_dir_for
from fleet_agent.core.errors import validation_paths
from fleet_agent.core.model import Point, SiteGeometry
from fleet_agent.protocol.primitives import RobotId

SETTINGS_FILE_NAME: Final = "agent.toml"
"""Optional settings file inside the robot's kit directory."""

MAX_SETTINGS_BYTES: Final = 16384
"""Largest settings file accepted."""

_ENV_PREFIX: Final = "FLEET_"

ENV_FIELDS: Final[Mapping[str, str]] = MappingProxyType(
    {
        "FLEET_ROBOT_ID": "robot_id",
        "FLEET_KIT_ROOT": "kit_root",
        "FLEET_LOG_LEVEL": "log_level",
        "FLEET_MQTT_PORT": "mqtt_port",
        "FLEET_START_X": "start_x",
        "FLEET_START_Y": "start_y",
        "FLEET_START_HEADING": "start_heading",
        "FLEET_CHARGER_X": "charger_x",
        "FLEET_CHARGER_Y": "charger_y",
        "FLEET_SPEED_MPS": "speed_mps",
        "FLEET_BATTERY_START": "battery_start",
        "FLEET_VIDEO_ENABLED": "video_enabled",
    }
)
"""Environment variables the agent reads, each mapped to its setting. Any other `FLEET_*` name is
refused, so a typo cannot silently leave a setting at its default."""

SettingsErrorCode = Literal[
    "UNKNOWN_ENV",
    "FORBIDDEN_TOML_KEY",
    "INVALID",
    "TOML_INSECURE",
    "TOML_INVALID",
]
"""Why the settings were refused."""

_BOOLEAN_TEXT: Final[Mapping[str, bool]] = MappingProxyType(
    {"true": True, "1": True, "false": False, "0": False}
)
"""The only spellings of a boolean environment variable. Anything else is refused, so that a typo
such as `ture` cannot silently leave the page on or off."""


def _flag_from_text(value: object) -> object:
    """Converts one of the four accepted spellings of a flag to its boolean.

    The environment is checked before this runs, so only those spellings arrive here. Any other
    value is returned unchanged for the boolean check, which refuses it.

    Args:
        value: The raw value of the setting.

    Returns:
        The boolean for an accepted spelling, else the value unchanged.
    """
    if isinstance(value, str) and value in _BOOLEAN_TEXT:
        return _BOOLEAN_TEXT[value]
    return value


_LOCATOR_KEYS: Final = ("robot_id", "kit_root")
"""Settings that locate the kit and therefore cannot come from the file that they locate."""


class SettingsError(Exception):
    """The settings cannot be used. Its string form is the code alone.

    Attributes:
        code: The failed check.
        name: The variable, key or field the check failed on. Never a value.
    """

    def __init__(self, code: SettingsErrorCode, name: str | None = None) -> None:
        """Creates the error.

        Args:
            code: The failed check.
            name: The variable, key or field the check failed on, if any.
        """
        super().__init__(code)
        self.code = code
        self.name = name


def _port_from_text(value: object) -> object:
    """Converts a port written as text, as an environment variable is, to an integer.

    Pydantic's lax mode does not turn a string into a literal integer, so the conversion is done
    here, and only for a string made of digits. Anything else is left for the literal check.

    Args:
        value: The raw value of the setting.

    Returns:
        The integer for a digit string, else the value unchanged.
    """
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return value


class AgentSettings(BaseModel):
    """The validated settings of one agent run.

    Attributes:
        robot_id: The identifier of the robot the agent speaks for.
        kit_root: The directory holding one kit per robot.
        log_level: The lowest level written to the log.
        mqtt_port: The broker port, 8883 for MQTT over TLS or 443 for ALPN.
        start_x: The robot's start position, in metres.
        start_y: The robot's start position, in metres.
        start_heading: The robot's start heading, in radians.
        charger_x: The charger position, in metres.
        charger_y: The charger position, in metres.
        speed_mps: The straight-line speed of the simulated motion, in metres per second.
        battery_start: The battery level at start, in percent.
        video_enabled: Whether the local video page is served. Set it to false to bind nothing.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    robot_id: RobotId
    kit_root: Path
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    mqtt_port: Annotated[
        Literal[8883, 443],
        BeforeValidator(_port_from_text),
    ] = 8883
    start_x: float = Field(5.0, ge=-1000, le=1000)
    start_y: float = Field(5.0, ge=-1000, le=1000)
    start_heading: float = Field(0.0, ge=-math.pi, le=math.pi)
    charger_x: float = Field(1.0, ge=-1000, le=1000)
    charger_y: float = Field(1.0, ge=-1000, le=1000)
    speed_mps: float = Field(0.5, gt=0, le=2)
    battery_start: float = Field(80.0, ge=0, le=100)
    video_enabled: Annotated[bool, BeforeValidator(_flag_from_text)] = True


def default_kit_root() -> Path:
    """Returns the kit root used when neither the command line nor the environment sets one.

    Returns:
        The directory `.fleet/robots` in the home directory of the user.
    """
    return Path.home() / ".fleet" / "robots"


def load_settings(
    *,
    robot_id: str | None,
    kit_root: Path | None,
    environ: Mapping[str, str],
) -> AgentSettings:
    """Builds the settings: defaults, then the optional file, then the environment, then the flags.

    The robot identifier and the kit root are resolved first, because they locate the settings
    file. The file cannot set either of them.

    Args:
        robot_id: The robot identifier from the command line, if given.
        kit_root: The kit root from the command line, if given.
        environ: The environment, as a mapping of variable names to values.

    Returns:
        The validated settings.

    Raises:
        SettingsError: With the code of the first failed check.
    """
    env = _env_values(environ)
    root_path = _kit_root_of(kit_root, env)
    robot = robot_id if robot_id is not None else env.get("robot_id")
    values: dict[str, object] = {}
    if robot is not None and is_robot_id(robot):
        values.update(_read_settings_file(kit_dir_for(root_path, robot)))
    values.update(env)
    if robot_id is not None:
        values["robot_id"] = robot_id
    if kit_root is not None:
        values["kit_root"] = kit_root
    values.setdefault("kit_root", root_path)
    try:
        return AgentSettings.model_validate(values)
    except ValidationError as err:
        paths = validation_paths(err, limit=1)
    raise SettingsError("INVALID", paths[0] if paths else None)


def geometry_of(settings: AgentSettings) -> SiteGeometry:
    """Builds the site layout of a run from the settings.

    Args:
        settings: The validated settings.

    Returns:
        The charger and the start pose of the robot.
    """
    return SiteGeometry(
        charger=Point(settings.charger_x, settings.charger_y),
        start=Point(settings.start_x, settings.start_y),
        start_heading=settings.start_heading,
        speed_mps=settings.speed_mps,
    )


def _kit_root_of(kit_root: Path | None, env: Mapping[str, str]) -> Path:
    """Resolves the kit root: the command line, then the environment, then the default.

    Args:
        kit_root: The kit root from the command line, if given.
        env: The agent's environment values, by setting name.

    Returns:
        The directory holding one kit per robot.
    """
    if kit_root is not None:
        return kit_root
    if "kit_root" in env:
        return Path(env["kit_root"])
    return default_kit_root()


def _env_values(environ: Mapping[str, str]) -> dict[str, str]:
    """Maps the agent's environment variables to their setting names.

    Args:
        environ: The environment.

    Returns:
        The setting name and text value of every agent variable that is set.

    Raises:
        SettingsError: With `UNKNOWN_ENV` and the variable name, for any `FLEET_*` variable the
            agent does not read; with `INVALID` and the variable name, for a flag that is not one
            of the four accepted spellings.
    """
    values: dict[str, str] = {}
    for name, value in environ.items():
        if not name.startswith(_ENV_PREFIX):
            continue
        field = ENV_FIELDS.get(name)
        if field is None:
            raise SettingsError("UNKNOWN_ENV", name)
        if field == "kit_root" and value == "":
            # An empty root would resolve to the current directory, which is not what was meant.
            continue
        if field == "video_enabled" and value not in _BOOLEAN_TEXT:
            # Checked here, not by the model, so the refusal names the variable and never a value.
            raise SettingsError("INVALID", name)
        values[field] = value
    return values


def _read_settings_file(kit_dir: Path) -> dict[str, object]:
    """Reads the optional settings file of one robot.

    Args:
        kit_dir: The robot's kit directory.

    Returns:
        The settings the file sets, or an empty mapping when the file is absent.

    The robot's directory is checked before the file is opened, so the file is never read from a
    directory another user can write. A directory that fails the check gives no settings: the kit
    check that follows refuses it with its own code, which names the directory rather than a file.

    Raises:
        SettingsError: With `TOML_INSECURE`, `TOML_INVALID` or `FORBIDDEN_TOML_KEY`.
    """
    try:
        check_private_dir(kit_dir)
    except InsecureFileError:
        return {}
    try:
        raw = read_checked_file(
            kit_dir / SETTINGS_FILE_NAME,
            forbidden_bits=0o022,
            max_bytes=MAX_SETTINGS_BYTES,
        )
    except InsecureFileError as err:
        if err.code == "MISSING":
            return {}
        raise SettingsError("TOML_INSECURE") from None
    try:
        parsed = tomllib.loads(raw.decode("utf-8"))
    except (ValueError, RecursionError):
        # Deeply nested input hits the recursion limit rather than a parse error.
        raise SettingsError("TOML_INVALID") from None
    for key in _LOCATOR_KEYS:
        if key in parsed:
            raise SettingsError("FORBIDDEN_TOML_KEY", key)
    return dict(parsed)
