"""UUIDv7 generator (RFC 9562, section 5.7), mirrored from `packages/protocol/src/uuidv7.ts`.

Python 3.12 has no `uuid7`, and the generator is about twenty lines, so it is written here and
tested against the same layout rules as the TypeScript one.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable

_MAX_UNIX_MS = 2**48 - 1
_RANDOM_BYTES = 10


def uuid7(
    now_ms: int | None = None,
    rand: Callable[[int], bytes] = os.urandom,
) -> str:
    """Generates a UUIDv7 string in lowercase hexadecimal.

    Args:
        now_ms: Unix time in milliseconds, an integer in [0, 2^48). Defaults to the current time.
        rand: Source of ``count`` random bytes. Injected so that tests can pin the random bits.

    Returns:
        The identifier in the canonical 8-4-4-4-12 form.

    Raises:
        ValueError: If ``now_ms`` is out of range or ``rand`` returns the wrong number of bytes.
    """
    if now_ms is None:
        now_ms = time.time_ns() // 1_000_000
    if isinstance(now_ms, bool) or not 0 <= now_ms <= _MAX_UNIX_MS:
        raise ValueError("now_ms must be an integer in [0, 2^48)")
    entropy = rand(_RANDOM_BYTES)
    if len(entropy) != _RANDOM_BYTES:
        raise ValueError("rand must return 10 bytes")

    # The 48-bit timestamp is big-endian. Bytes 6 to 8 carry the version nibble (0111) and the
    # variant bits (10), which overwrite the reserved bits of the random bytes they replace.
    head = now_ms.to_bytes(6, "big")
    middle = bytes(
        (
            0x70 | (entropy[0] & 0x0F),
            entropy[1],
            0x80 | (entropy[2] & 0x3F),
        )
    )
    raw = head + middle + entropy[3:]
    hex_text = raw.hex()
    return f"{hex_text[0:8]}-{hex_text[8:12]}-{hex_text[12:16]}-{hex_text[16:20]}-{hex_text[20:32]}"
