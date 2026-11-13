"""Tests of the one-time claim: token, lock, lifetime, session key and redaction."""

from __future__ import annotations

from fleet_agent.video.claim import ClaimGate, ClaimGranted, ClaimRefused
from fleet_agent.video.constants import CLAIM_TTL_S
from tests.video.support import SESSION_KEY, TOKEN, FakeClock, sequence


def _gate(clock: FakeClock, *values: str) -> ClaimGate:
    """Builds a gate whose tokens come from the given values, with the fake clock.

    Args:
        clock: The clock that controls the lifetime.
        values: The tokens and keys, in the order the gate asks for them.

    Returns:
        The gate.
    """
    return ClaimGate(now=clock.mono_now, token_factory=sequence(*values))


def test_correct_token_grants_a_43_char_key_and_claims() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY)

    result = gate.claim(TOKEN)

    assert isinstance(result, ClaimGranted)
    assert len(result.session_key) == 43
    assert result.session_key == SESSION_KEY
    assert gate.phase == "CLAIMED"


def test_the_same_token_again_is_refused_as_used() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY)
    gate.claim(TOKEN)

    result = gate.claim(TOKEN)

    assert result == ClaimRefused("used")
    assert gate.authorize(f"Bearer {SESSION_KEY}")


def test_five_wrong_tokens_lock_the_claim_even_for_the_right_one() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY)
    wrong = "B" * 43

    results = [gate.claim(wrong) for _ in range(5)]
    late = gate.claim(TOKEN)

    assert results == [ClaimRefused("wrong")] * 5
    assert late == ClaimRefused("locked")
    assert gate.phase == "LOCKED"


def test_a_token_past_its_lifetime_is_refused_as_expired() -> None:
    clock = FakeClock()
    gate = _gate(clock, TOKEN, SESSION_KEY)

    clock.advance(CLAIM_TTL_S + 1)

    assert gate.phase == "EXPIRED"
    assert gate.claim(TOKEN) == ClaimRefused("expired")


def test_a_malformed_token_is_wrong_and_counts_as_a_failure() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY)

    too_short = gate.claim("abc")
    bad_alphabet = gate.claim("!" * 43)
    trailing_newline = gate.claim(TOKEN + "\n")

    assert too_short == ClaimRefused("wrong")
    assert bad_alphabet == ClaimRefused("wrong")
    assert trailing_newline == ClaimRefused("wrong")
    assert gate.phase == "OPEN"


def test_authorize_accepts_only_the_bearer_scheme_and_the_current_key() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY)
    before = gate.authorize(f"Bearer {SESSION_KEY}")
    gate.claim(TOKEN)

    assert before is False
    assert gate.authorize(f"Bearer {SESSION_KEY}") is True
    assert gate.authorize(f"bearer {SESSION_KEY}") is False
    assert gate.authorize(None) is False
    assert gate.authorize(f"Bearer {'Z' * 43}") is False
    assert gate.authorize(f"Basic {SESSION_KEY}") is False
    assert gate.authorize(SESSION_KEY) is False


def test_rearm_revokes_the_old_key_and_the_new_token_works_once() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY, "N" * 43, "M" * 43)
    for _ in range(3):
        gate.claim("B" * 43)
    gate.claim(TOKEN)

    new_token = gate.rearm()

    assert new_token == "N" * 43
    assert gate.authorize(f"Bearer {SESSION_KEY}") is False
    assert gate.phase == "OPEN"
    assert isinstance(gate.claim(new_token), ClaimGranted)
    assert gate.claim(new_token) == ClaimRefused("used")


def test_revoke_drops_the_key_without_issuing_a_token_or_reopening_the_claim() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY)
    gate.claim(TOKEN)

    gate.revoke()

    assert gate.authorize(f"Bearer {SESSION_KEY}") is False
    assert gate.token == ""
    assert gate.phase == "CLAIMED"
    assert gate.claim(TOKEN) == ClaimRefused("used")


def test_rearm_resets_the_failure_count() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY, "N" * 43)
    for _ in range(4):
        gate.claim("B" * 43)
    gate.rearm()

    result = gate.claim("B" * 43)

    assert result == ClaimRefused("wrong")
    assert gate.phase == "OPEN"


def test_repr_and_str_never_show_the_token_or_the_key() -> None:
    gate = _gate(FakeClock(), TOKEN, SESSION_KEY)
    granted = gate.claim(TOKEN)

    texts = [repr(gate), str(gate), repr(granted), str(granted), repr(ClaimRefused("used"))]

    for text in texts:
        assert TOKEN not in text
        assert SESSION_KEY not in text
    assert "phase=CLAIMED" in repr(gate)
