"""Unit tests for the retry delay computation."""

import math
import random
from collections.abc import Callable

import pytest

from fleet_agent.core.backoff import compute_backoff_s

# The largest float strictly below 1.0: the upper edge of the allowed draw interval.
JUST_BELOW_ONE = math.nextafter(1.0, 0.0)


def _constant(value: float) -> Callable[[], float]:
    """Return a draw source that always yields ``value``."""

    def draw() -> float:
        return value

    return draw


@pytest.mark.parametrize(
    ("attempt", "rand", "base_s", "cap_s", "expected"),
    [
        # First retry: window is base_s, so a draw of 0.5 gives half of it.
        (0, 0.5, 1.0, 10.0, 0.5),
        # Third retry: window is 8 s; the draw is just under 1, so the delay stays below 8 s.
        (3, JUST_BELOW_ONE, 1.0, 10.0, JUST_BELOW_ONE * 8.0),
        # Tenth retry: the window would be 1024 s but the cap clamps it to 5 s.
        (10, 0.5, 1.0, 5.0, 2.5),
        # A zero draw always yields a zero delay.
        (4, 0.0, 1.0, 10.0, 0.0),
    ],
    ids=["first-retry", "below-window", "capped", "zero-draw"],
)
def test_compute_backoff_s_returns_jittered_capped_delay(
    attempt: int, rand: float, base_s: float, cap_s: float, expected: float
) -> None:
    assert compute_backoff_s(attempt, base_s=base_s, cap_s=cap_s, rand=_constant(rand)) == expected


def test_compute_backoff_s_stays_finite_and_capped_for_huge_attempt() -> None:
    delay = compute_backoff_s(10_000, base_s=1.0, cap_s=30.0, rand=_constant(JUST_BELOW_ONE))

    assert math.isfinite(delay)
    assert delay <= 30.0


@pytest.mark.parametrize(
    ("attempt", "base_s", "cap_s", "rand", "message"),
    [
        pytest.param(-1, 1.0, 10.0, _constant(0.5), "attempt", id="negative-attempt"),
        # A float retry number is a caller bug; reject it rather than silently truncating.
        pytest.param(  # type: ignore[arg-type]
            1.5, 1.0, 10.0, _constant(0.5), "attempt", id="float-attempt"
        ),
        # bool is an int subclass; True must not be accepted as retry number 1.
        pytest.param(True, 1.0, 10.0, _constant(0.5), "attempt", id="bool-attempt"),
        # False is an int subclass equal to 0; accepting it would silently pick the first retry.
        pytest.param(False, 1.0, 10.0, _constant(0.5), "attempt", id="false-attempt"),
        pytest.param(1, 0.0, 10.0, _constant(0.5), "base_s", id="zero-base"),
        pytest.param(1, math.nan, 10.0, _constant(0.5), "base_s", id="nan-base"),
        pytest.param(1, math.inf, 10.0, _constant(0.5), "base_s", id="infinite-base"),
        pytest.param(1, 5.0, 2.0, _constant(0.5), "cap_s", id="cap-below-base"),
        # NaN fails every comparison, so it must be rejected explicitly by the negated check.
        pytest.param(1, 1.0, math.nan, _constant(0.5), "cap_s", id="nan-cap"),
        pytest.param(1, 1.0, 10.0, _constant(1.0), "rand", id="draw-at-one"),
        pytest.param(1, 1.0, 10.0, _constant(math.nan), "rand", id="nan-draw"),
        pytest.param(1, 1.0, 10.0, _constant(-0.1), "rand", id="negative-draw"),
    ],
)
def test_compute_backoff_s_rejects_invalid_arguments(
    attempt: int,
    base_s: float,
    cap_s: float,
    rand: Callable[[], float],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        compute_backoff_s(attempt, base_s=base_s, cap_s=cap_s, rand=rand)


def test_compute_backoff_s_rejects_an_infinite_cap() -> None:
    # An infinite cap would let base_s * 2 ** 64 overflow, so the delay could be nan or inf.
    with pytest.raises(ValueError, match="cap_s"):
        compute_backoff_s(64, base_s=1e308, cap_s=math.inf, rand=_constant(0.0))


def test_compute_backoff_s_keeps_every_delay_within_zero_and_window() -> None:
    # Seeded so the sweep is reproducible. The draws are test data, not secrets.
    generator = random.Random(20_261_031)  # noqa: S311
    draws = [0.0, 0.5, JUST_BELOW_ONE, *(generator.random() for _ in range(200))]
    violations: list[str] = []

    for base_s, cap_s in [(1.0, 10.0), (0.5, 7.25), (1.0, 1.0), (250.0, 250_000.0)]:
        for attempt in range(61):
            # The window is the documented upper bound; 2.0 ** 60 keeps it finite.
            window = min(cap_s, base_s * 2.0**attempt)
            for draw in draws:
                delay = compute_backoff_s(attempt, base_s=base_s, cap_s=cap_s, rand=_constant(draw))
                if not 0.0 <= delay < window:
                    violations.append(
                        f"attempt={attempt} base_s={base_s} cap_s={cap_s} "
                        f"draw={draw!r} delay={delay!r}"
                    )

    assert violations == []
