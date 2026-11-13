"""UUIDv7 generator: layout bits, timestamp placement, ordering, and argument checks."""

from __future__ import annotations

import re

import pytest

from fleet_agent.core.ids import uuid7

UUIDV7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _fixed(byte: int) -> object:
    """Returns a random source that yields the same byte everywhere.

    Args:
        byte: The byte to repeat.

    Returns:
        A callable with the signature `rand(count) -> bytes`.
    """

    def rand(count: int) -> bytes:
        return bytes([byte]) * count

    return rand


def test_version_and_variant_bits_are_set() -> None:
    """The version nibble is 7 and the variant bits are 10, whatever the random bytes are."""
    identifier = uuid7(1_700_000_000_000, rand=_fixed(0xFF))  # type: ignore[arg-type]
    assert UUIDV7.match(identifier)


def test_the_timestamp_occupies_the_first_twelve_hex_digits() -> None:
    """The millisecond timestamp is written big-endian in the leading 48 bits."""
    now_ms = 0x0189_4A2B_C123
    identifier = uuid7(now_ms, rand=_fixed(0x00))  # type: ignore[arg-type]
    assert identifier.replace("-", "")[:12] == f"{now_ms:012x}"


def test_identifiers_sort_in_the_order_of_their_timestamps() -> None:
    """Two identifiers compare as strings in the order they were issued."""
    earlier = uuid7(1_000, rand=_fixed(0xFF))  # type: ignore[arg-type]
    later = uuid7(1_001, rand=_fixed(0x00))  # type: ignore[arg-type]
    assert earlier < later


def test_the_default_clock_and_source_produce_valid_identifiers() -> None:
    """Without arguments the generator uses the current time and the operating system's randomness.
    Without arguments the generator uses the current time and the operating system's randomness."""
    assert UUIDV7.match(uuid7())


@pytest.mark.parametrize("now_ms", [-1, 2**48, True])
def test_an_out_of_range_timestamp_is_refused(now_ms: int) -> None:
    """A timestamp outside [0, 2^48), or a boolean, is a caller error."""
    with pytest.raises(ValueError, match="now_ms"):
        uuid7(now_ms, rand=_fixed(0))  # type: ignore[arg-type]


def test_a_random_source_with_the_wrong_length_is_refused() -> None:
    """The generator needs exactly ten random bytes."""
    with pytest.raises(ValueError, match="10 bytes"):
        uuid7(1, rand=lambda count: bytes(count - 1))
