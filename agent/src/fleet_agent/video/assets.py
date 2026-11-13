"""Static files of the local video page, loaded once, verified, and served by exact lookup.

The built page is committed with a manifest of SHA-256 digests. The loader reads only the files the
manifest lists, checks each digest, and keeps the bytes in memory. A request is answered from a
dictionary of exact paths, so no filesystem path ever comes from a client.
"""

from __future__ import annotations

import hashlib
import re
import stat
from collections.abc import Mapping
from dataclasses import dataclass

# The agent requires Python 3.12, so the Python 3.6 compatibility rule does not apply.
# nosemgrep: python.lang.compatibility.python37.python37-compatibility-importlib2
from importlib import resources
from pathlib import Path, PurePosixPath
from typing import Final, Literal

from fleet_agent.video.constants import MAX_STATIC_FILE_BYTES, MAX_STATIC_FILES

MANIFEST_NAME: Final = "MANIFEST.sha256"
"""File name of the manifest, in the static directory. Its own digest is not listed."""

INDEX_PATH: Final = "index.html"
"""The file served at `/`."""

AssetErrorCode = Literal[
    "MANIFEST_MISSING",
    "MANIFEST_INVALID",
    "FILE_MISSING",
    "HASH_MISMATCH",
    "TOO_LARGE",
    "TOO_MANY",
    "NOT_REGULAR",
]
"""Why the static files cannot be loaded. The string form is the code alone."""

_MANIFEST_LINE = re.compile(r"([0-9a-f]{64})  (\S.*)")
"""One manifest line: a lowercase hex digest, two spaces, and a relative path."""

_TEXT: Final = "text/plain; charset=utf-8"
_HTML: Final = "text/html; charset=utf-8"
_JAVASCRIPT: Final = "text/javascript; charset=utf-8"
_CSS: Final = "text/css; charset=utf-8"

_CONTENT_TYPES: Final[Mapping[str, str]] = {
    ".html": _HTML,
    ".js": _JAVASCRIPT,
    ".css": _CSS,
    ".woff2": "font/woff2",
    ".txt": _TEXT,
    ".svg": "image/svg+xml",
}
"""Content type by file suffix. Any other suffix is refused at load."""


class AssetError(Exception):
    """The static files cannot be loaded. Its string form is the code alone.

    Attributes:
        code: The failed check.
    """

    def __init__(self, code: AssetErrorCode) -> None:
        """Creates the error.

        Args:
            code: The failed check.
        """
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class Asset:
    """One static file, held in memory, with the content type it is served under.

    Attributes:
        body: The verified bytes of the file.
        content_type: The `Content-Type` header value.
    """

    body: bytes
    content_type: str


class StaticAssets:
    """The verified static files of the page, served by exact request path.

    The paths are `/` for the index page and `/<relative path>` for every other file, so the
    vendored bundle is `/vendor/kvs-webrtc.min.js`.
    """

    def __init__(self, routes: Mapping[str, Asset]) -> None:
        """Holds the routes. Use `load` to build them from disk.

        Args:
            routes: The asset served at each exact request path.
        """
        self._routes: dict[str, Asset] = dict(routes)

    @classmethod
    def load(cls, directory: Path) -> StaticAssets:
        """Reads and verifies the files that the manifest lists.

        A file on disk that the manifest does not list is ignored and never served. A listed file
        must be a regular file (not a symbolic link), within the size limit, and match its digest.

        Args:
            directory: The static directory, which holds the manifest.

        Returns:
            The verified assets.

        Raises:
            AssetError: With the code of the first failed check.
        """
        manifest = directory / MANIFEST_NAME
        if not manifest.is_file():
            raise AssetError("MANIFEST_MISSING")
        entries = _parse_manifest(manifest)
        routes: dict[str, Asset] = {}
        for digest, relative in entries:
            routes[_request_path(relative)] = _load_file(directory, digest, relative)
        if _request_path(INDEX_PATH) not in routes:
            raise AssetError("FILE_MISSING")
        return cls(routes)

    def lookup(self, request_path: str) -> Asset | None:
        """Returns the asset served at an exact request path.

        Args:
            request_path: The request target, without a query string.

        Returns:
            The asset, or None when no listed file is served at that path.
        """
        return self._routes.get(request_path)


def packaged_static_dir() -> Path:
    """Returns the static directory shipped inside the agent package.

    Returns:
        The directory of the committed page.
    """
    return Path(str(resources.files("fleet_agent.video") / "static"))


def _request_path(relative: str) -> str:
    """Maps a manifest path to the request path that serves it.

    Args:
        relative: The path relative to the static directory.

    Returns:
        `/` for the index page, otherwise the path with a leading slash.
    """
    return "/" if relative == INDEX_PATH else f"/{relative}"


def _parse_manifest(manifest: Path) -> list[tuple[str, str]]:
    """Reads the manifest into (digest, relative path) pairs.

    Args:
        manifest: The manifest file.

    Returns:
        The entries, in manifest order.

    Raises:
        AssetError: With `MANIFEST_INVALID` for a malformed line, an unsafe path, a duplicate, or
            too many entries.
    """
    try:
        text = manifest.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        raise AssetError("MANIFEST_INVALID") from None
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in text.splitlines():
        match = _MANIFEST_LINE.fullmatch(line)
        if match is None or not _is_safe_relative(match.group(2)):
            raise AssetError("MANIFEST_INVALID")
        relative = match.group(2)
        if relative in seen:
            raise AssetError("MANIFEST_INVALID")
        seen.add(relative)
        entries.append((match.group(1), relative))
        if len(entries) > MAX_STATIC_FILES:
            raise AssetError("TOO_MANY")
    return entries


def _is_safe_relative(relative: str) -> bool:
    """Tells whether a manifest path stays inside the static directory.

    Args:
        relative: The path written in the manifest.

    Returns:
        True for a relative path without `..`, empty or dot segments.
    """
    pure = PurePosixPath(relative)
    return not pure.is_absolute() and all(part not in ("", ".", "..") for part in pure.parts)


def _load_file(directory: Path, digest: str, relative: str) -> Asset:
    """Reads one listed file and verifies it.

    Args:
        directory: The static directory.
        digest: The expected SHA-256 hex digest.
        relative: The path of the file, relative to the static directory.

    Returns:
        The asset, with its content type.

    Raises:
        AssetError: With `FILE_MISSING`, `NOT_REGULAR`, `TOO_LARGE`, `HASH_MISMATCH`, or
            `MANIFEST_INVALID` when the suffix has no content type.
    """
    content_type = _content_type(relative)
    path = directory / relative
    try:
        status = path.lstat()
    except FileNotFoundError:
        raise AssetError("FILE_MISSING") from None
    if not stat.S_ISREG(status.st_mode):
        raise AssetError("NOT_REGULAR")
    if status.st_size > MAX_STATIC_FILE_BYTES:
        raise AssetError("TOO_LARGE")
    body = path.read_bytes()
    if len(body) > MAX_STATIC_FILE_BYTES:
        raise AssetError("TOO_LARGE")
    if hashlib.sha256(body).hexdigest() != digest:
        raise AssetError("HASH_MISMATCH")
    return Asset(body=body, content_type=content_type)


def _content_type(relative: str) -> str:
    """Chooses the content type of a listed file from its name.

    The licence files are named `LICENSE` or `<name>.LICENSE`, which is why they are matched by
    name and not by suffix.

    Args:
        relative: The path of the file, relative to the static directory.

    Returns:
        The `Content-Type` header value.

    Raises:
        AssetError: With `MANIFEST_INVALID` when the file has no known content type.
    """
    name = PurePosixPath(relative).name
    if name == "LICENSE" or name.endswith(".LICENSE"):
        return _TEXT
    content_type = _CONTENT_TYPES.get(PurePosixPath(relative).suffix)
    if content_type is None:
        raise AssetError("MANIFEST_INVALID")
    return content_type
