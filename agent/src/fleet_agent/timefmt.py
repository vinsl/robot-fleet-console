"""ISO 8601 timestamps with millisecond precision, in integer arithmetic.

The protocol carries times as `YYYY-MM-DDTHH:MM:SS.mmmZ`. Floating point would lose the
millisecond on large epoch values, and the age check compares these values to the millisecond, so
the conversion is done on integers only.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_ONE_MS = timedelta(milliseconds=1)
_MAX_WALL_MS = (datetime(9999, 12, 31, 23, 59, 59, 999000, tzinfo=UTC) - _EPOCH) // _ONE_MS
_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def format_iso_ms(wall_ms: int) -> str:
    """Formats a Unix time in milliseconds as an ISO 8601 UTC string with milliseconds.

    Args:
        wall_ms: Milliseconds since the Unix epoch, in [0, 9999-12-31T23:59:59.999Z].

    Returns:
        The text `YYYY-MM-DDTHH:MM:SS.mmmZ`.

    Raises:
        ValueError: If the time is outside the representable range.
    """
    if isinstance(wall_ms, bool) or not 0 <= wall_ms <= _MAX_WALL_MS:
        raise ValueError("wall_ms must be an integer in the representable range")
    seconds, millis = divmod(wall_ms, 1000)
    instant = datetime.fromtimestamp(seconds, UTC)
    return f"{instant:%Y-%m-%dT%H:%M:%S}.{millis:03d}Z"


def parse_iso_ms(text: str) -> int:
    """Parses an ISO 8601 UTC timestamp with milliseconds into Unix milliseconds.

    The caller has already checked the pattern, so this only converts it.

    Args:
        text: A timestamp in the form `YYYY-MM-DDTHH:MM:SS.mmmZ`, or with fewer fraction digits.

    Returns:
        Milliseconds since the Unix epoch. Sub-millisecond digits are truncated.

    Raises:
        ValueError: If the text is not a valid UTC timestamp.
    """
    parsed = datetime.strptime(text, _FORMAT).replace(tzinfo=UTC)
    return (parsed - _EPOCH) // _ONE_MS
