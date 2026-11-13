"""Settings of the demo control page: site, simulator size, port and the paths it may use.

Every value is read once and checked here, so the rest of the package only sees valid values. The
page never reads a credential: the AWS session belongs to the `aws` CLI, and the page only runs
commands that the operator could run by hand.
"""

from __future__ import annotations

import argparse
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

LOOPBACK_HOST: Final = "127.0.0.1"
"""The only address the page listens on. Anything else is refused at start-up."""

SITE_ID_PATTERN: Final = re.compile(r"^[a-z0-9-]{3,32}$")
"""Grammar of a site identifier, the same as the protocol's `SiteIdSchema`."""

DEFAULT_SITE_ID: Final = "paris-01"
DEFAULT_PORT: Final = 8765
DEFAULT_SIM_COUNT: Final = 9
MAX_SIM_COUNT: Final = 20
DEFAULT_MAX_RUNTIME_S: Final = 7200
MAX_RUNTIME_CAP_S: Final = 14400

ScriptName = Literal[
    "demo-consumer.sh",
    "sim.sh",
    "sim-stop.sh",
    "sim-provision.sh",
    "bootstrap-admin.sh",
]
"""The repository scripts the page may run. Anything else is not a script of this page."""


class SettingsError(ValueError):
    """A setting or an option has an invalid value. The message is safe to print."""


@dataclass(frozen=True)
class Settings:
    """Validated settings of one run of the page.

    Attributes:
        site_id: The only site the page controls.
        port: The TCP port on the loopback address. 0 asks the system for a free port.
        sim_count: Number of simulated robots, from 1 to 20.
        max_runtime_s: Auto-stop of the simulators, in seconds, from 1 to 14400.
        repo_root: Root of the repository checkout that holds the scripts and the infrastructure.
        kit_root: Directory of the robot kits (one sub-directory per robot).
        state_dir: Private directory of the page (its log file).
        sim_lock_path: The lock file that a running simulator holds.
    """

    site_id: str
    port: int
    sim_count: int
    max_runtime_s: int
    repo_root: Path
    kit_root: Path
    state_dir: Path
    sim_lock_path: Path

    @property
    def stack_dir(self) -> Path:
        """Directory of the demo Terraform root, read with `terraform output`.

        Returns:
            The `infra/envs/demo` directory of the checkout.
        """
        return self.repo_root / "infra" / "envs" / "demo"

    @property
    def sim_log_path(self) -> Path:
        """File that receives the output of the simulators started by the page.

        Returns:
            The log file in the private state directory.
        """
        return self.state_dir / "sim.log"

    def script(self, name: ScriptName) -> Path:
        """Returns the path of one of the repository scripts the page runs.

        Args:
            name: The script name, from the allow-list.

        Returns:
            The path of the script in the checkout.
        """
        return self.repo_root / "scripts" / name


def _default_repo_root() -> Path:
    """Locates the checkout from the location of this package.

    Returns:
        The repository root: this file sits five levels below it
        (agent/src/fleet_agent/demo_ui).
    """
    return Path(__file__).resolve().parents[4]


def _port(value: str) -> int:
    """Parses the `--port` option.

    Args:
        value: The text given on the command line.

    Returns:
        The port, from 0 to 65535.

    Raises:
        argparse.ArgumentTypeError: When the value is not a port.
    """
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("the port must be a whole number") from error
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("the port must be from 0 to 65535")
    return port


def _parser() -> argparse.ArgumentParser:
    """Builds the command line parser of the page.

    Returns:
        A parser with `--port`, `--host` (only the loopback address is accepted) and
        `--site-id`.
    """
    parser = argparse.ArgumentParser(
        prog="python -m fleet_agent.demo_ui",
        description="Local control page of the demo: start and stop the simulators, read links.",
    )
    parser.add_argument("--port", type=_port, default=DEFAULT_PORT, help="port (0 = a free port)")
    parser.add_argument(
        "--host",
        default=LOOPBACK_HOST,
        help="address to listen on; only 127.0.0.1 is accepted",
    )
    parser.add_argument("--site-id", default=None, help="site to control (default: SIM_SITE_ID)")
    return parser


def _integer_in_range(raw: str | None, default: int, low: int, high: int, name: str) -> int:
    """Reads an integer setting from the environment and checks its range.

    Args:
        raw: The text of the variable, or None when it is unset.
        default: The value used when the variable is unset or empty.
        low: The smallest accepted value.
        high: The largest accepted value.
        name: The variable name, used in the message.

    Returns:
        The value.

    Raises:
        SettingsError: When the text is not an integer in the range.
    """
    if raw is None or raw == "":
        return default
    if not re.fullmatch(r"-?[0-9]{1,6}", raw):
        raise SettingsError(f"{name} must be a whole number from {low} to {high}")
    value = int(raw)
    if not low <= value <= high:
        raise SettingsError(f"{name} must be from {low} to {high}")
    return value


def load_settings(env: Mapping[str, str], argv: Sequence[str]) -> Settings:
    """Reads and validates the settings of the page from the environment and the command line.

    Precedence of the site: `--site-id`, then `SIM_SITE_ID`, then the default. Environment variables
    `SIM_N` and `SIM_MAX_RUNTIME_S` are read with the same names and defaults as `scripts/sim.sh`.

    Args:
        env: The environment (a mapping, so tests need no real environment).
        argv: The command line arguments after the program name.

    Returns:
        The validated settings.

    Raises:
        SettingsError: When a value is out of range, the site is malformed, the host is not the
        loopback
            address, or the page runs outside a repository checkout.
        SystemExit: When the command line does not parse (argparse prints its usage first).
    """
    args = _parser().parse_args(list(argv))
    if args.host != LOOPBACK_HOST:
        raise SettingsError("the demo page only listens on 127.0.0.1; --host is refused")

    site_id: str = args.site_id or env.get("SIM_SITE_ID") or DEFAULT_SITE_ID
    if SITE_ID_PATTERN.fullmatch(site_id) is None:
        raise SettingsError("the site identifier must match ^[a-z0-9-]{3,32}$")

    sim_count = _integer_in_range(env.get("SIM_N"), DEFAULT_SIM_COUNT, 1, MAX_SIM_COUNT, "SIM_N")
    max_runtime = _integer_in_range(
        env.get("SIM_MAX_RUNTIME_S"),
        DEFAULT_MAX_RUNTIME_S,
        1,
        MAX_RUNTIME_CAP_S,
        "SIM_MAX_RUNTIME_S",
    )

    repo_root = _default_repo_root()
    if not (repo_root / "scripts" / "sim.sh").is_file():
        raise SettingsError("the demo page must run from the repository checkout")

    home = Path(env["HOME"]) if env.get("HOME") else Path.home()
    # Same resolution as scripts/sim.sh and scripts/sim-stop.sh, so that the page and the scripts
    # agree on the lock file.
    state_root = Path(env["XDG_STATE_HOME"]) if env.get("XDG_STATE_HOME") else home / ".local/state"
    return Settings(
        site_id=site_id,
        port=args.port,
        sim_count=sim_count,
        max_runtime_s=max_runtime,
        repo_root=repo_root,
        kit_root=home / ".fleet" / "robots",
        state_dir=state_root / "fleet" / "demo-ui",
        sim_lock_path=state_root / "fleet" / "sim.lock",
    )
