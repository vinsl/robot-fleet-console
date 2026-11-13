"""Writes a valid robot kit under a temporary kit root, for the tests that load one from disk."""

from __future__ import annotations

import json
from pathlib import Path

from fleet_agent.config.kit_file import KIT_FILE_NAME
from tests.protocol.conftest import FIXTURES_DIR, read_fixture

ROBOT_ID = "kali-01"
"""The robot of the valid kit fixture."""

_VALID_FIXTURE = FIXTURES_DIR / "register-robot-response" / "valid" / "01.json"


def write_kit(root: Path, *, mode: int = 0o600, kit_dir_mode: int = 0o700) -> Path:
    """Writes the kit of the fixture robot under the kit root, with owner-only directories.

    Args:
        root: The kit root. It is created when missing and made private.
        mode: The mode of the kit file. Owner-only by default; tests widen it to be refused.
        kit_dir_mode: The mode of the robot's directory.

    Returns:
        The robot's kit directory.
    """
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    kit_dir = root / ROBOT_ID
    kit_dir.mkdir(parents=True, exist_ok=True)
    kit_dir.chmod(kit_dir_mode)
    document = {"ok": True, "status": 201, "body": read_fixture(_VALID_FIXTURE)}
    path = kit_dir / KIT_FILE_NAME
    path.write_text(json.dumps(document), encoding="utf-8")
    path.chmod(mode)
    return kit_dir
