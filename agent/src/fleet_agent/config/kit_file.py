"""The robot kit: the registration response the robot reads in place, validated and cross-checked.

`robots-admin.sh` writes the kit as the registration's `RegisterInvokeOk` into the robot's kit
directory. The agent reads that file where it is, once, in memory. It never copies the key to
another file, so the key lives on disk in one place only (T2).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, cast

from pydantic import TypeAdapter, ValidationError

from fleet_agent.config.files import InsecureFileError, check_private_dir, read_checked_file
from fleet_agent.core.errors import validation_paths
from fleet_agent.protocol.constants import THING_NAME_PREFIX
from fleet_agent.protocol.primitives import RobotId
from fleet_agent.protocol.robots import RegisterInvokeOk, RobotKitConfig

KIT_FILE_NAME: Final = "register-response.json"
"""File name of the kit inside the robot's kit directory, as `robots-admin.sh` writes it."""

MAX_KIT_BYTES: Final = 65536
"""Largest kit accepted. A kit holds two short certificates and one key, far below this."""

KIT_FORBIDDEN_BITS: Final = 0o177
"""Permission bits a kit must not carry: the execute bit and every group and other bit. The
kit is therefore 0600 or 0400."""

KitErrorCode = Literal[
    "KIT_DIR_INSECURE",
    "KIT_FILE_MISSING",
    "KIT_FILE_INSECURE",
    "KIT_FILE_TOO_LARGE",
    "KIT_NOT_JSON",
    "KIT_NOT_A_SUCCESS",
    "KIT_SCHEMA",
    "KIT_MISMATCH",
    "KIT_KEY_INVALID",
]
"""Why a kit was refused. It names the failed check and never carries key material."""

_INVOKE_OK: Final = TypeAdapter(RegisterInvokeOk)
_ROBOT_ID: Final = TypeAdapter(RobotId)
_LOG: Final = logging.getLogger(__name__)


class KitError(Exception):
    """The kit cannot be used. Its string form is the code alone.

    Attributes:
        code: The failed check.
        paths: The dotted paths of the fields that failed a schema check. Never a value.
    """

    def __init__(self, code: KitErrorCode, paths: tuple[str, ...] = ()) -> None:
        """Creates the error.

        Args:
            code: The failed check.
            paths: The dotted paths of the failed schema fields, if any.
        """
        super().__init__(code)
        self.code = code
        self.paths = paths


@dataclass(frozen=True, slots=True, repr=False)
class TlsMaterial:
    """The PEM material of the TLS identity, in memory as bytes, as the CRT takes it.

    The representation is redacted: a log line or a traceback that prints this object shows no
    key material.

    Attributes:
        certificate_pem: The robot's certificate.
        private_key_pem: The robot's private key.
        root_ca_pem: The root certificate authority that signs the broker's certificate.
    """

    certificate_pem: bytes
    private_key_pem: bytes
    root_ca_pem: bytes

    def __repr__(self) -> str:
        """Hides every field, so that no key material reaches a log or a traceback.

        Returns:
            A fixed redacted marker.
        """
        return "TlsMaterial(<redacted>)"


@dataclass(frozen=True, slots=True)
class LoadedKit:
    """A kit that passed every check, ready for the transport.

    Attributes:
        config: The non-secret configuration: identifiers, endpoints and the channel.
        tls: The TLS material, held in memory only.
        kit_dir: The directory the kit was read from.
    """

    config: RobotKitConfig
    tls: TlsMaterial
    kit_dir: Path


def is_robot_id(value: str) -> bool:
    """Tells whether a string is a robot identifier, by the protocol's own pattern.

    Args:
        value: The candidate identifier.

    Returns:
        True when the string matches the robot identifier pattern.
    """
    try:
        _ROBOT_ID.validate_python(value)
    except ValidationError:
        return False
    return True


def kit_dir_for(kit_root: Path, robot_id: str) -> Path:
    """Returns the directory of one robot's kit under the kit root.

    The identifier is checked before it becomes a path component, so it cannot name a directory
    outside the kit root.

    Args:
        kit_root: The directory holding one sub-directory per robot.
        robot_id: The robot identifier.

    Returns:
        The kit directory of the robot.

    Raises:
        ValueError: If the identifier does not match the robot identifier pattern.
    """
    if not is_robot_id(robot_id):
        raise ValueError("robot id does not match the identifier pattern")
    return kit_root / robot_id


def load_kit(kit_root: Path, robot_id: str) -> LoadedKit:
    """Loads and checks one robot's kit, in place.

    The checks run in this order, and the first failure wins: the directories are private, the
    file is owner-only, it is JSON, it is a successful registration, it matches the protocol
    schema, and its identifiers agree with the robot's.

    Args:
        kit_root: The directory holding one sub-directory per robot.
        robot_id: The identifier of the robot that must own the kit.

    Returns:
        The kit, with its TLS material in memory.

    Raises:
        KitError: With the code of the first failed check.
        ValueError: If the identifier does not match the robot identifier pattern.
    """
    kit_dir = kit_dir_for(kit_root, robot_id)
    _check_dir(kit_root)
    _check_dir(kit_dir)
    raw = _read_kit_file(kit_dir / KIT_FILE_NAME)
    document = _parse_document(raw)
    invoke = _validate_invoke(document)
    response = invoke.body
    _check_identity(
        response.robot.robot_id,
        response.robot.site_id,
        response.robot.simulated,
        response.kit.config,
        robot_id,
    )
    kit = response.kit
    tls = TlsMaterial(
        certificate_pem=kit.certificate_pem.encode("ascii"),
        private_key_pem=kit.private_key_pem.encode("ascii"),
        root_ca_pem=kit.root_ca_pem.encode("ascii"),
    )
    return LoadedKit(config=kit.config, tls=tls, kit_dir=kit_dir)


def _check_dir(path: Path) -> None:
    """Checks one directory of the kit.

    Args:
        path: The kit root or a robot's kit directory.

    Raises:
        KitError: With `KIT_FILE_MISSING` when the directory is missing, else `KIT_DIR_INSECURE`.
    """
    try:
        check_private_dir(path)
    except InsecureFileError as err:
        code: KitErrorCode = "KIT_FILE_MISSING" if err.code == "MISSING" else "KIT_DIR_INSECURE"
        raise KitError(code) from None


def _read_kit_file(path: Path) -> bytes:
    """Reads the kit file under the owner-only rules.

    Args:
        path: The kit file.

    Returns:
        The raw content of the file.

    Raises:
        KitError: With `KIT_FILE_MISSING`, `KIT_FILE_TOO_LARGE` or `KIT_FILE_INSECURE`.
    """
    try:
        return read_checked_file(path, forbidden_bits=KIT_FORBIDDEN_BITS, max_bytes=MAX_KIT_BYTES)
    except InsecureFileError as err:
        if err.code == "MISSING":
            raise KitError("KIT_FILE_MISSING") from None
        if err.code == "TOO_LARGE":
            raise KitError("KIT_FILE_TOO_LARGE") from None
        raise KitError("KIT_FILE_INSECURE") from None


def _parse_document(raw: bytes) -> object:
    """Decodes the kit file as JSON and refuses a document that reports a failure.

    The decoding error is not chained: its text can quote the bytes it failed on, which may be
    key material. Deeply nested input makes the decoder hit the recursion limit instead of a
    `ValueError`, so both are treated as not JSON.

    Args:
        raw: The raw content of the kit file.

    Returns:
        The decoded JSON value.

    Raises:
        KitError: With `KIT_NOT_JSON` when the content is not JSON, or `KIT_NOT_A_SUCCESS` when
            the document is a failed registration.
    """
    try:
        document: object = json.loads(raw)
    except (ValueError, RecursionError):
        raise KitError("KIT_NOT_JSON") from None
    if isinstance(document, Mapping) and cast("Mapping[str, object]", document).get("ok") is False:
        raise KitError("KIT_NOT_A_SUCCESS")
    return document


def _validate_invoke(document: object) -> RegisterInvokeOk:
    """Validates the document against the protocol schema of a successful registration.

    The validation error is not chained to the raised error: its text quotes the input values,
    which include the private key, so only the field paths leave this function.

    Args:
        document: The decoded JSON value.

    Returns:
        The validated registration.

    Raises:
        KitError: With `KIT_SCHEMA` and the failed paths, never the values.
    """
    try:
        return _INVOKE_OK.validate_python(document)
    except ValidationError as err:
        paths = validation_paths(err)
    raise KitError("KIT_SCHEMA", paths)


def _check_identity(
    robot_id_in_kit: str,
    site_id_in_kit: str,
    simulated_in_kit: bool,
    config: RobotKitConfig,
    robot_id: str,
) -> None:
    """Checks that the kit belongs to the robot being started and agrees with itself.

    Args:
        robot_id_in_kit: The robot identifier of the registry entry.
        site_id_in_kit: The site identifier of the registry entry.
        simulated_in_kit: The simulated flag of the registry entry.
        config: The configuration the kit carries.
        robot_id: The identifier of the robot being started.

    Raises:
        KitError: With `KIT_MISMATCH` when any identifier or flag disagrees.
    """
    consistent = (
        robot_id_in_kit == robot_id
        and config.robot_id == robot_id
        and site_id_in_kit == config.site_id
        and simulated_in_kit == config.simulated
        and config.thing_name == f"{THING_NAME_PREFIX}{robot_id}"
    )
    if not consistent:
        raise KitError("KIT_MISMATCH")


def log_kit_refusal(err: KitError) -> None:
    """Logs why a kit was refused. The code and the field paths only, never a value.

    Shared by the run and the operator tools, so that a refused kit reads the same everywhere.
    It lives next to `KitError` so that the operator tools do not depend on the run loop.

    Args:
        err: The kit error.
    """
    _LOG.error("kit.refused", extra={"reason": err.code, "errorPaths": list(err.paths)})
