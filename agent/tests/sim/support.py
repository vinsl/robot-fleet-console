"""Shared helpers of the simulator tests: the sample map, small maps and kits written to disk.

The sample map is the protocol's fixture, read by its relative path, so the two languages test the
same file. The helpers write only under the temporary directories the tests give them.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Final

from fleet_agent.config.kit_file import KIT_FILE_NAME
from tests.protocol.conftest import FIXTURES_DIR, read_fixture

REPOSITORY_ROOT: Final = Path(__file__).resolve().parents[3]
"""The root of the repository, three levels above this file."""

SAMPLE_MAP_PATH: Final = (
    REPOSITORY_ROOT
    / "packages"
    / "protocol"
    / "test"
    / "fixtures"
    / "site-map"
    / "sample-warehouse.geojson"
)
"""The protocol's sample site map, the same file the console's tests load."""

INVALID_MAP_DIR: Final = (
    REPOSITORY_ROOT / "packages" / "protocol" / "test" / "fixtures" / "site-map" / "invalid"
)
"""The protocol's invalid site maps. Each must be refused by the simulator too."""

SIMULATED_KIT_FIXTURE: Final = FIXTURES_DIR / "register-robot-response" / "valid" / "02.json"
"""A kit of a simulated robot, whose identifiers the helper rewrites for each robot."""


def sample_document() -> dict[str, object]:
    """Reads the sample map as a mutable document, for a test to change one part of it.

    Returns:
        The parsed sample map.
    """
    loaded = json.loads(SAMPLE_MAP_PATH.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return copy.deepcopy(loaded)


def write_map(path: Path, document: Mapping[str, object]) -> Path:
    """Writes a map document to a file, as JSON.

    Args:
        path: The file to write.
        document: The map.

    Returns:
        The file.
    """
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def write_kit(
    kit_root: Path, robot_id: str, *, simulated: bool = True, site_id: str = "paris-01"
) -> Path:
    """Writes the kit of one robot under a kit root, with owner-only permissions.

    The kit is the protocol's simulated fixture with the identifiers, the thing name, the channel
    and the flag rewritten, so the identity checks of the kit loader pass. A kit with `simulated`
    false is the same kit as a real robot's, which the simulator must refuse.

    Args:
        kit_root: The kit root, created when missing.
        robot_id: The robot identifier, which names the kit directory.
        simulated: Whether the kit says the robot is simulated.
        site_id: The site the kit names.

    Returns:
        The kit file.
    """
    body = copy.deepcopy(read_fixture(SIMULATED_KIT_FIXTURE))
    assert isinstance(body, dict)
    robot = body["robot"]
    config = body["kit"]["config"]
    assert isinstance(robot, dict)
    assert isinstance(config, dict)
    robot["robotId"] = robot_id
    robot["siteId"] = site_id
    robot["simulated"] = simulated
    config["robotId"] = robot_id
    config["siteId"] = site_id
    config["thingName"] = f"mfc-demo-{robot_id}"
    config["kvsChannelName"] = f"mfc-demo-{robot_id}"
    config["kvsChannelArn"] = str(config["kvsChannelArn"]).replace(
        "mfc-demo-sim-01", f"mfc-demo-{robot_id}"
    )
    config["simulated"] = simulated
    directory = kit_root / robot_id
    directory.mkdir(parents=True, exist_ok=True)
    kit_root.chmod(0o700)
    directory.chmod(0o700)
    document = {"ok": True, "status": 201, "body": body}
    path = directory / KIT_FILE_NAME
    path.write_text(json.dumps(document), encoding="utf-8")
    path.chmod(0o600)
    return path
