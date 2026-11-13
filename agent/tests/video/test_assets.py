"""Tests of the static files: manifest, digests, limits, content types and lookup."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from pathlib import Path

import pytest

from fleet_agent.video.assets import AssetError, StaticAssets, packaged_static_dir
from fleet_agent.video.constants import MAX_STATIC_FILE_BYTES, MAX_STATIC_FILES
from tests.video.support import standard_files, write_static

_REPOSITORY_VENDOR_MANIFEST = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "robot-video"
    / "src"
    / "kvs"
    / "vendor-manifest.ts"
)
"""The TypeScript file that records the vendored bundle's digest, read by regex in one test."""


def test_a_valid_directory_serves_the_index_as_html(tmp_path: Path) -> None:
    static = write_static(tmp_path / "static", standard_files())

    assets = StaticAssets.load(static)
    index = assets.lookup("/")

    assert index is not None
    assert index.body == standard_files()["index.html"]
    assert index.content_type == "text/html; charset=utf-8"


@pytest.mark.parametrize(
    ("code", "build"),
    [
        ("HASH_MISMATCH", lambda root: _flip_a_byte(root)),
        ("FILE_MISSING", lambda root: _remove(root, "assets/app.js")),
        ("NOT_REGULAR", lambda root: _symlink(root, "assets/app.js")),
        ("TOO_LARGE", lambda root: _oversized(root)),
        ("TOO_MANY", lambda root: _many_files(root)),
        ("MANIFEST_INVALID", lambda root: _unknown_suffix(root)),
        ("MANIFEST_MISSING", lambda root: _without_manifest(root)),
    ],
)
def test_each_failed_check_names_its_code(
    tmp_path: Path, code: str, build: Callable[[Path], Path]
) -> None:
    static = build(tmp_path / "static")

    with pytest.raises(AssetError) as caught:
        StaticAssets.load(static)

    assert caught.value.code == code
    assert str(caught.value) == code


def test_a_file_on_disk_that_the_manifest_does_not_list_is_never_served(tmp_path: Path) -> None:
    static = write_static(tmp_path / "static", standard_files())
    (static / "assets" / "extra.js").write_bytes(b"unlisted")

    assets = StaticAssets.load(static)

    assert assets.lookup("/assets/extra.js") is None


@pytest.mark.parametrize(
    "request_path",
    ["/../x", "/assets/%2e%2e/x", "//", "", "/index.html", "/assets/app.js?x=1"],
)
def test_lookup_is_by_exact_path_only(tmp_path: Path, request_path: str) -> None:
    static = write_static(tmp_path / "static", standard_files())

    assert StaticAssets.load(static).lookup(request_path) is None


def test_the_committed_page_loads_and_carries_the_vendored_bundle_and_its_licence() -> None:
    static = packaged_static_dir()

    assets = StaticAssets.load(static)

    assert assets.lookup("/") is not None
    vendored = assets.lookup("/vendor/kvs-webrtc.min.js")
    licence = assets.lookup("/vendor/kvs-webrtc.LICENSE")
    assert vendored is not None
    assert licence is not None
    assert licence.content_type == "text/plain; charset=utf-8"
    recorded = _recorded_vendor_digest()
    assert hashlib.sha256(vendored.body).hexdigest() == recorded


def test_the_packaged_static_directory_is_inside_the_agent_package() -> None:
    assert packaged_static_dir().name == "static"
    assert packaged_static_dir().parent.name == "video"


def _recorded_vendor_digest() -> str:
    """Reads the SHA-256 that the vendor manifest records for the bundle.

    Returns:
        The hex digest.

    Raises:
        AssertionError: When the manifest has no digest line.
    """
    text = _REPOSITORY_VENDOR_MANIFEST.read_text(encoding="utf-8")
    match = re.search(r'fileSha256: "([0-9a-f]{64})"', text)
    if match is None:
        raise AssertionError("vendor digest not found")
    return match.group(1)


def _flip_a_byte(root: Path) -> Path:
    """Writes a valid page and then changes one byte of a listed file.

    Args:
        root: The static directory to write.

    Returns:
        The directory.
    """
    static = write_static(root, standard_files())
    (static / "assets" / "app.js").write_bytes(b"console.log(2);")
    return static


def _remove(root: Path, relative: str) -> Path:
    """Writes a valid page and then removes one listed file.

    Args:
        root: The static directory to write.
        relative: The file to remove.

    Returns:
        The directory.
    """
    static = write_static(root, standard_files())
    (static / relative).unlink()
    return static


def _symlink(root: Path, relative: str) -> Path:
    """Writes a valid page and replaces one listed file by a symbolic link to a copy of it.

    Args:
        root: The static directory to write.
        relative: The file to replace.

    Returns:
        The directory.
    """
    static = write_static(root, standard_files())
    target = static / relative
    copy = root / "copy.js"
    copy.write_bytes(target.read_bytes())
    target.unlink()
    target.symlink_to(copy)
    return static


def _oversized(root: Path) -> Path:
    """Writes a page whose listed file is one byte over the size limit.

    Args:
        root: The static directory to write.

    Returns:
        The directory.
    """
    files = standard_files()
    files["assets/app.js"] = b"x" * (MAX_STATIC_FILE_BYTES + 1)
    return write_static(root, files)


def _many_files(root: Path) -> Path:
    """Writes a manifest with one more entry than the file limit allows.

    Args:
        root: The static directory to write.

    Returns:
        The directory.
    """
    files = {"index.html": b"<html>"}
    for index in range(MAX_STATIC_FILES):
        files[f"assets/f{index}.js"] = f"{index}".encode("ascii")
    return write_static(root, files)


def _unknown_suffix(root: Path) -> Path:
    """Writes a page with a listed file whose suffix has no content type.

    Args:
        root: The static directory to write.

    Returns:
        The directory.
    """
    files = standard_files()
    files["assets/data.bin"] = b"\x00\x01"
    return write_static(root, files)


def _without_manifest(root: Path) -> Path:
    """Writes a page without its manifest.

    Args:
        root: The static directory to write.

    Returns:
        The directory.
    """
    return write_static(root, standard_files(), manifest=False)
