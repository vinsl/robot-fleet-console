"""Shared setup of the core tests: every log call the core makes is checked against the allowlist.

The production writer drops what is outside the closed list and the allowlist, so it never raises
on the safety path. The tests are where such a drop must be noticed, so this fixture refuses, with
an assertion, any core log call that would lose something.
"""

from __future__ import annotations

import pytest

from fleet_agent.core.corelog import CoreLog, LogValue, unloggable_reasons


@pytest.fixture(autouse=True)
def _strict_core_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fails any core log call that names an unlisted event or a field outside the allowlist.

    Args:
        monkeypatch: The fixture that installs the checking wrapper for the test.
    """
    real_log = CoreLog.log

    def strict_log(self: CoreLog, level: int, event: str, **fields: LogValue) -> None:
        """Checks one log call, then writes it through the real writer.

        Args:
            self: The writer.
            level: The standard logging level.
            event: The event name.
            **fields: The fields of the line.

        Raises:
            AssertionError: If the call names an unlisted event or a field outside the allowlist.
        """
        refused = unloggable_reasons(event, fields)
        if refused:
            raise AssertionError(f"log call {event} would lose: {', '.join(refused)}")
        real_log(self, level, event, **fields)

    monkeypatch.setattr(CoreLog, "log", strict_log)
