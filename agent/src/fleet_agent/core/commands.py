"""Pure helpers that read a screened command: its lock identity, its issue time and its refusals.

The helpers hold no state and touch no I/O. They are kept apart from the core so that the rules of
the command pipeline, which are the security-relevant part, read as one short module.
"""

from __future__ import annotations

from fleet_agent.core.lock import LockHolder
from fleet_agent.core.screening import AnyCommand, Refused, Screened, Stage
from fleet_agent.protocol.acks import AckReason
from fleet_agent.protocol.commands import SimulateFaultCommand


def holder_of(cmd: AnyCommand) -> LockHolder | None:
    """Builds the lock identity a command presents, from its token and its subject.

    Args:
        cmd: A command that passed screening.

    Returns:
        The holder, or None when the command carries no lock token.
    """
    if cmd.lock_token is None:
        return None
    return LockHolder(cmd.lock_token, cmd.issued_by)


def issue_time_ms(screened: Screened, now: int) -> int:
    """Returns the monotonic time at which the operator issued a command.

    A command that arrives after it was issued has spent its age in transit, so the proof of life
    it carries dates from the issue, not the arrival. A command with no age, or a future one, is
    treated as issued now, so it can never move the deadman forward.

    Args:
        screened: The command that passed screening.
        now: The monotonic time at which the command arrived, in milliseconds.

    Returns:
        The monotonic issue time, in milliseconds.
    """
    return now - max(screened.age_ms or 0, 0)


def refusal_for(screened: Screened, stage: Stage, reason: AckReason) -> Refused:
    """Builds the refusal of a screened command that the core, not screening, rejects.

    Args:
        screened: The command that passed screening.
        stage: The stage that refuses it: the lock or the state machine.
        reason: The reason the answer carries.

    Returns:
        The refusal, with the identifiers and the age of the command.
    """
    cmd = screened.command
    return Refused(
        stage=stage,
        reason=reason,
        command_id=cmd.command_id,
        correlation_id=cmd.correlation_id,
        command_type=cmd.type,
        silent=screened.silent,
        age_ms=screened.age_ms,
    )


def fault_duration_ms(cmd: AnyCommand) -> int | None:
    """Returns the duration a simulated fault asked for, in milliseconds, if it gave one.

    Args:
        cmd: A command that passed screening.

    Returns:
        The duration in milliseconds, or None for any command but a timed fault injection.
    """
    if isinstance(cmd, SimulateFaultCommand) and cmd.params.duration_s is not None:
        return cmd.params.duration_s * 1000
    return None
