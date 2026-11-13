"""Shared helpers of the protocol parity tests.

They read the fixture corpus and the generated artifacts, and expand the two private key
placeholders
the same way the TypeScript tests do. A literal key header would be flagged by secret scanners, so
the corpus stores placeholders and the header is assembled here, at run time.
"""

from __future__ import annotations

import json
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = REPOSITORY_ROOT / "packages" / "protocol" / "fixtures"
GENERATED_DIR = REPOSITORY_ROOT / "packages" / "protocol" / "generated"

_PEM_LABEL = "PRIVATE KEY"
_RSA_LABEL = f"RSA {_PEM_LABEL}"
_PEM_BODY = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA"
"""Fake key body. It only carries the PEM shape the schemas check; it is not key material."""

PLACEHOLDERS: dict[str, str] = {
    '"{{PEM:PRIVATE_KEY}}"': "\n".join(
        [f"-----BEGIN {_PEM_LABEL}-----", _PEM_BODY, f"-----END {_PEM_LABEL}-----", ""]
    ),
    # The footer names the other form than the header: the schema must refuse it.
    '"{{PEM:MISMATCHED}}"': "\n".join(
        [f"-----BEGIN {_RSA_LABEL}-----", _PEM_BODY, f"-----END {_PEM_LABEL}-----", ""]
    ),
}
"""Each corpus placeholder (as its JSON string) and the text it stands for."""


def read_fixture(path: Path) -> object:
    """Reads one fixture and expands its placeholders.

    Args:
        path: The JSON file of the corpus.

    Returns:
        The decoded JSON value.
    """
    text = path.read_text(encoding="utf-8")
    for token, value in PLACEHOLDERS.items():
        text = text.replace(token, json.dumps(value))
    return json.loads(text)


def read_generated(name: str) -> object:
    """Reads a generated artifact by file name.

    Args:
        name: The file name inside `packages/protocol/generated`.

    Returns:
        The decoded JSON value.
    """
    return json.loads((GENERATED_DIR / name).read_text(encoding="utf-8"))
