"""Retry delay computation for the agent's reconnection loops.

Mirrors the rules of ``apps/console/src/lib/backoff.ts`` so both ends of the link retry with
the same shape.
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable

# 2 ** 64 already exceeds any realistic window; clamping the exponent keeps the arithmetic
# finite for very large attempt counts instead of overflowing on a long-running agent.
_MAX_EXPONENT = 64


def compute_backoff_s(
    attempt: int,
    *,
    base_s: float,
    cap_s: float,
    rand: Callable[[], float] = random.random,
) -> float:
    """Return the delay in seconds before retry number ``attempt`` using full jitter.

    The delay is a uniform draw over the capped exponential window
    ``min(cap_s, base_s * 2 ** attempt)``. Full jitter spreads the reconnections of a whole
    fleet after a broker restart instead of letting them arrive in lockstep.

    Args:
        attempt: Zero-based retry number. Must be an ``int`` and not a ``bool``.
        base_s: Window of the first retry, in seconds. Must be finite and strictly positive.
        cap_s: Upper bound of any window, in seconds. Must be finite and at least ``base_s``.
        rand: Source of uniform draws in ``[0, 1)``. Injected so tests are deterministic.

    Returns:
        The delay in seconds, in ``[0, min(cap_s, base_s * 2 ** attempt))``.

    Raises:
        ValueError: If an argument is out of range, or ``rand`` returns a value outside
            ``[0, 1)``.
    """
    # bool is a subclass of int; a boolean retry number is always a programming error.
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 0:
        raise ValueError("attempt must be an int >= 0")
    if not math.isfinite(base_s) or base_s <= 0:
        raise ValueError("base_s must be finite and > 0")
    # Negated comparison so that NaN, which fails every comparison, is rejected. An infinite
    # cap is rejected too: it would let ``base_s * 2 ** 64`` overflow into inf or nan.
    if not (math.isfinite(cap_s) and cap_s >= base_s):
        raise ValueError("cap_s must be finite and >= base_s")

    draw = rand()
    # Negated comparison again: rejects NaN as well as out-of-range draws.
    if not 0.0 <= draw < 1.0:
        raise ValueError("rand must return a value in [0, 1)")

    # Float base keeps the power typed as float; int ** int is typed Any by typeshed.
    window_s = min(cap_s, base_s * (2.0 ** min(attempt, _MAX_EXPONENT)))
    return draw * window_s
