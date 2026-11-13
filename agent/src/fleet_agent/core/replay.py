"""Replay memory: remembers recent command identifiers, so a replayed command is refused.

A command is valid for two seconds, but a broker or an attacker could replay it inside that window.
The guard refuses an identifier it has already seen, for as long as the identifier is remembered.
"""

from __future__ import annotations

from collections import OrderedDict

from fleet_agent.protocol.constants import REPLAY_LRU_SIZE


class ReplayGuard:
    """A bounded, first-in first-out memory of command identifiers.

    The order is the order of first arrival. A repeat does not refresh an identifier's place, so a
    flood of repeats cannot keep an old identifier alive and push out the others. Memory is bounded
    by the capacity, whatever the traffic.
    """

    def __init__(self, capacity: int = REPLAY_LRU_SIZE) -> None:
        """Creates an empty guard.

        Args:
            capacity: The number of identifiers remembered. Once it is reached, the oldest is
                forgotten to make room.

        Raises:
            ValueError: If the capacity is below 1.
        """
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self._capacity = capacity
        self._seen: OrderedDict[str, None] = OrderedDict()

    def seen_or_record(self, command_id: str) -> bool:
        """Tells whether the identifier was already seen, and records it if not.

        A caller must call this only for a message that passed every check before it. Otherwise a
        malformed message could burn an identifier that a legitimate command later needs.

        Args:
            command_id: The identifier of the command, already checked against its pattern.

        Returns:
            True if the identifier was seen before, False on its first sighting (which is then
            recorded).
        """
        if command_id in self._seen:
            return True
        self._seen[command_id] = None
        if len(self._seen) > self._capacity:
            self._seen.popitem(last=False)
        return False

    def __len__(self) -> int:
        """Returns the number of identifiers currently remembered.

        Returns:
            A number between 0 and the capacity.
        """
        return len(self._seen)
