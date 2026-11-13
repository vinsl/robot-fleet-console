"""Error helpers shared by the core and the adapters.

Validation errors describe where a value is wrong, never what the value was. The paths are the
only part of a pydantic error that may reach a log line, because the input may carry a secret or
personal data.
"""

from __future__ import annotations

import pydantic

_MAX_PATH_CHARS = 64


def validation_paths(err: pydantic.ValidationError, limit: int = 10) -> tuple[str, ...]:
    """Reduces a validation error to the dotted paths of the fields that failed.

    Args:
        err: The error raised by a pydantic model or type adapter.
        limit: The maximum number of paths returned. Bounds the size of a log line.

    Returns:
        One path per failed field, in the order pydantic reports them, each cut to 64 characters.
    """
    details = err.errors(include_input=False, include_url=False, include_context=False)
    paths = (".".join(str(part) for part in detail["loc"]) for detail in details[:limit])
    return tuple(path[:_MAX_PATH_CHARS] for path in paths)
