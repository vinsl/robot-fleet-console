"""Millisecond timestamps: the wire format, the round trip and the leap day."""

from __future__ import annotations

import pytest

from fleet_agent.timefmt import format_iso_ms, parse_iso_ms


@pytest.mark.parametrize(
    "wall_ms",
    [0, 1, 999, 1_000, 1_793_613_600_123, 253_402_300_799_999],
    ids=["epoch", "one-ms", "sub-second", "one-second", "2026-11-02", "last-representable"],
)
def test_round_trip_keeps_the_millisecond(wall_ms: int) -> None:
    assert parse_iso_ms(format_iso_ms(wall_ms)) == wall_ms


def test_epoch_formats_as_the_unix_origin() -> None:
    assert format_iso_ms(0) == "1970-01-01T00:00:00.000Z"


def test_formats_the_fraction_with_three_digits() -> None:
    assert format_iso_ms(1_793_613_600_123) == "2026-11-02T10:00:00.123Z"


def test_leap_day_parses_to_the_right_instant() -> None:
    # 2028-02-29 is a leap day; the instant is 2028-02-29T12:00:00Z.
    assert format_iso_ms(parse_iso_ms("2028-02-29T12:00:00.000Z")) == "2028-02-29T12:00:00.000Z"


def test_parse_truncates_sub_millisecond_digits() -> None:
    assert parse_iso_ms("1970-01-01T00:00:01.123456Z") == 1123


@pytest.mark.parametrize(
    "wall_ms", [-1, 253_402_300_800_000, True], ids=["negative", "too-late", "bool"]
)
def test_format_refuses_a_time_outside_the_representable_range(wall_ms: int) -> None:
    with pytest.raises(ValueError, match="wall_ms"):
        format_iso_ms(wall_ms)


@pytest.mark.parametrize(
    "text",
    ["2026-11-02 10:00:00.000Z", "2026-13-01T00:00:00.000Z", "2026-11-02T10:00:00.000+01:00"],
    ids=["space-separator", "month-13", "offset"],
)
def test_parse_refuses_text_that_is_not_a_utc_timestamp(text: str) -> None:
    with pytest.raises(ValueError, match=r"does not match|unconverted|time data"):
        parse_iso_ms(text)
