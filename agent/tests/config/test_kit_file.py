"""Tests of the robot kit: owner-only read, schema, identity cross-checks and redaction."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from fleet_agent.config import kit_file
from fleet_agent.config.kit_file import (
    KIT_FILE_NAME,
    MAX_KIT_BYTES,
    KitError,
    TlsMaterial,
    is_robot_id,
    kit_dir_for,
    load_kit,
)
from tests.protocol.conftest import FIXTURES_DIR, read_fixture

# Split so that secret scanners do not mistake a test marker for a key.
PEM_KEY_BEGIN = b"-----BEGIN " + b"PRIVATE KEY-----"
PEM_KEY_END = b"-----END " + b"PRIVATE KEY-----"

ROBOT_ID = "kali-01"
_VALID_FIXTURE = FIXTURES_DIR / "register-robot-response" / "valid" / "01.json"


def _invoke_document() -> dict[str, object]:
    """Builds the registration document of a successful invocation from the protocol fixture.

    Returns:
        The `RegisterInvokeOk` document a robot kit file holds.
    """
    body = read_fixture(_VALID_FIXTURE)
    return {"ok": True, "status": 201, "body": body}


def _with(document: dict[str, object], path: tuple[str, ...], value: object) -> dict[str, object]:
    """Returns a copy of the document with one nested value replaced.

    Args:
        document: The document to copy.
        path: The keys leading to the value to replace.
        value: The replacement.

    Returns:
        The modified copy.
    """
    copied: dict[str, object] = json.loads(json.dumps(document))
    node: dict[str, object] = copied
    for key in path[:-1]:
        child = node[key]
        assert isinstance(child, dict)
        node = child
    node[path[-1]] = value
    return copied


def _private_dir(path: Path) -> Path:
    """Creates a directory with owner-only access.

    Args:
        path: The directory to create.

    Returns:
        The directory.
    """
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def _write_kit(root: Path, document: object, robot_id: str = ROBOT_ID, mode: int = 0o600) -> Path:
    """Writes a kit file under the kit root, in a private robot directory.

    Args:
        root: The kit root.
        document: The JSON value to write.
        robot_id: The directory name of the robot.
        mode: The mode of the kit file.

    Returns:
        The path of the kit file.
    """
    kit_dir = _private_dir(root / robot_id)
    path = kit_dir / KIT_FILE_NAME
    path.write_text(json.dumps(document), encoding="utf-8")
    path.chmod(mode)
    return path


@pytest.fixture
def kit_root(tmp_path: Path) -> Path:
    """Provides a private kit root holding a valid kit for `kali-01`.

    Args:
        tmp_path: The per-test directory.

    Returns:
        The kit root.
    """
    root = _private_dir(tmp_path / "robots")
    _write_kit(root, _invoke_document())
    return root


def test_loads_a_valid_kit(kit_root: Path) -> None:
    """A valid kit loads, with its configuration and its TLS material in memory as bytes."""
    kit = load_kit(kit_root, ROBOT_ID)

    assert kit.config.robot_id == ROBOT_ID
    assert kit.config.thing_name == "mfc-demo-kali-01"
    assert kit.kit_dir == kit_root / ROBOT_ID
    assert kit.tls.certificate_pem.startswith(b"-----BEGIN CERTIFICATE-----")
    assert kit.tls.private_key_pem.startswith(PEM_KEY_BEGIN)
    assert kit.tls.root_ca_pem.startswith(b"-----BEGIN CERTIFICATE-----")


def test_tls_material_is_redacted_in_every_representation(kit_root: Path) -> None:
    """Neither the material nor the kit shows any key text in its repr or its string form."""
    kit = load_kit(kit_root, ROBOT_ID)

    assert repr(kit.tls) == "TlsMaterial(<redacted>)"
    assert str(kit.tls) == "TlsMaterial(<redacted>)"
    assert "PRIVATE" not in repr(kit)
    assert "PRIVATE" not in str(kit)


def test_tls_material_repr_hides_the_bytes() -> None:
    """A TLS material built directly is redacted, whatever its content."""
    material = TlsMaterial(b"cert", PEM_KEY_BEGIN, b"ca")

    assert "PRIVATE" not in repr(material)
    assert repr(material) == "TlsMaterial(<redacted>)"


# Each payload stays under MAX_KIT_BYTES, so that the nesting, not the size, is what is tested.
@pytest.mark.parametrize("raw", [b"[" * 60_000, b'{"a":' * 12_000], ids=["array", "object"])
def test_a_document_nested_past_the_decoder_limit_is_not_json(kit_root: Path, raw: bytes) -> None:
    """Deep nesting makes the decoder hit its recursion limit: that is refused as not JSON."""
    (kit_root / ROBOT_ID / KIT_FILE_NAME).write_bytes(raw)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_NOT_JSON"


def test_refuses_a_failed_registration(kit_root: Path) -> None:
    """A document that reports `ok: false` gives KIT_NOT_A_SUCCESS, before any schema check."""
    _write_kit(kit_root, {"ok": False, "status": 409, "problem": {}})

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_NOT_A_SUCCESS"


def test_refuses_a_schema_error_with_paths_and_no_key_text(kit_root: Path) -> None:
    """A schema error names the failed fields by path, and never repeats key text."""
    bad = _with(_invoke_document(), ("status",), 500)
    bad = _with(bad, ("body", "kit", "privateKeyPem"), PEM_KEY_BEGIN.decode() + "\nbad\n")
    _write_kit(kit_root, bad)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    error = caught.value
    assert error.code == "KIT_SCHEMA"
    assert "status" in error.paths
    assert "PRIVATE" not in str(error)
    assert all("PRIVATE" not in path for path in error.paths)
    assert error.__context__ is None


def test_refuses_a_document_that_is_not_json(kit_root: Path) -> None:
    """A kit file that is not JSON gives KIT_NOT_JSON."""
    path = kit_root / ROBOT_ID / KIT_FILE_NAME
    path.write_text("{not json", encoding="utf-8")

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_NOT_JSON"


def test_refuses_a_robot_id_that_differs_from_the_kit(kit_root: Path) -> None:
    """A kit for `kali-01` loaded as another robot gives KIT_MISMATCH."""
    shutil.copytree(kit_root / ROBOT_ID, kit_root / "sim-99")

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, "sim-99")

    assert caught.value.code == "KIT_MISMATCH"


def test_refuses_a_simulated_flag_that_differs_between_registry_and_config(
    kit_root: Path,
) -> None:
    """A registry entry that disagrees with the kit config on `simulated` gives KIT_MISMATCH."""
    bad = _with(_invoke_document(), ("body", "robot", "simulated"), True)
    _write_kit(kit_root, bad)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_MISMATCH"


def test_refuses_a_missing_kit_file(tmp_path: Path) -> None:
    """A robot directory without a kit file gives KIT_FILE_MISSING."""
    root = _private_dir(tmp_path / "robots")
    _private_dir(root / ROBOT_ID)

    with pytest.raises(KitError) as caught:
        load_kit(root, ROBOT_ID)

    assert caught.value.code == "KIT_FILE_MISSING"


def test_refuses_a_missing_robot_directory(tmp_path: Path) -> None:
    """A kit root without the robot's directory gives KIT_FILE_MISSING, not a crash."""
    root = _private_dir(tmp_path / "robots")

    with pytest.raises(KitError) as caught:
        load_kit(root, ROBOT_ID)

    assert caught.value.code == "KIT_FILE_MISSING"


def test_refuses_a_kit_wider_than_0600(kit_root: Path) -> None:
    """A kit readable by its group gives KIT_FILE_INSECURE."""
    (kit_root / ROBOT_ID / KIT_FILE_NAME).chmod(0o640)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_FILE_INSECURE"


def test_refuses_a_symlinked_kit(tmp_path: Path) -> None:
    """A kit file that is a symlink gives KIT_FILE_INSECURE, even when its target is private."""
    root = _private_dir(tmp_path / "robots")
    real = _write_kit(tmp_path / "elsewhere", _invoke_document())
    kit_dir = _private_dir(root / ROBOT_ID)
    (kit_dir / KIT_FILE_NAME).symlink_to(real)

    with pytest.raises(KitError) as caught:
        load_kit(root, ROBOT_ID)

    assert caught.value.code == "KIT_FILE_INSECURE"


def test_refuses_a_kit_owned_by_another_user(
    kit_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A kit file whose owner is not the running user gives KIT_FILE_INSECURE.

    The directory checks are switched off here, so that the file check is the one that refuses.
    """
    monkeypatch.setattr(kit_file, "check_private_dir", lambda _path: None)
    other_uid = os.getuid() + 1
    monkeypatch.setattr(os, "getuid", lambda: other_uid)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_FILE_INSECURE"


def test_refuses_a_kit_root_open_to_others(kit_root: Path) -> None:
    """A kit root readable by others gives KIT_DIR_INSECURE before the file is read."""
    (kit_root).chmod(0o755)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_DIR_INSECURE"


def test_refuses_a_kit_directory_open_to_others(kit_root: Path) -> None:
    """A robot's kit directory readable by others gives KIT_DIR_INSECURE."""
    (kit_root / ROBOT_ID).chmod(0o755)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_DIR_INSECURE"


def test_refuses_a_kit_directory_owned_by_another_user(
    kit_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A kit directory owned by another user gives KIT_DIR_INSECURE."""
    other_uid = os.getuid() + 1
    monkeypatch.setattr(os, "getuid", lambda: other_uid)

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_DIR_INSECURE"


def test_refuses_an_oversize_kit(kit_root: Path) -> None:
    """A kit file over the size limit gives KIT_FILE_TOO_LARGE."""
    (kit_root / ROBOT_ID / KIT_FILE_NAME).write_bytes(b" " * (MAX_KIT_BYTES + 1))

    with pytest.raises(KitError) as caught:
        load_kit(kit_root, ROBOT_ID)

    assert caught.value.code == "KIT_FILE_TOO_LARGE"


def test_is_robot_id_follows_the_protocol_pattern() -> None:
    """Identifiers match the protocol pattern, and anything with a separator or case does not."""
    assert is_robot_id("kali-01")
    assert not is_robot_id("../etc")
    assert not is_robot_id("Kali-01")
    assert not is_robot_id("ab")


def test_kit_dir_for_refuses_a_path_that_escapes_the_root(tmp_path: Path) -> None:
    """A robot identifier cannot name a directory outside the kit root."""
    with pytest.raises(ValueError, match="identifier pattern"):
        kit_dir_for(tmp_path, "../etc")
