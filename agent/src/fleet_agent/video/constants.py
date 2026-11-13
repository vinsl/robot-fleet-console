"""Limits and timings of the local video service, gathered in one place.

Each value bounds a path that a local process or a slow client can reach, or a failure that can
repeat. Keeping them together lets a reviewer read every limit of the page at once.
"""

from __future__ import annotations

from typing import Final

LOOPBACK_HOST: Final = "127.0.0.1"
"""The only address the page listens on and the only peer it answers."""

CLAIM_TTL_S: Final = 900.0
"""Lifetime of an unclaimed one-time token, in seconds."""

MAX_CLAIM_FAILURES: Final = 5
"""Wrong tokens presented before the claim locks and the token is burnt."""

IDLE_SESSION_S: Final = 30.0
"""Seconds without an authenticated request after which the session is reported stale in the log."""

MAX_CONNECTIONS: Final = 16
"""Connections served at once. The next one is closed without an answer."""

READ_HEAD_S: Final = 5.0
"""Deadline for the request line and the headers to arrive."""

READ_BODY_S: Final = 5.0
"""Deadline for the body of a POST to arrive."""

WRITE_S: Final = 10.0
"""Deadline for a response to be accepted by the socket, after which the socket is aborted."""

CONNECTION_MAX_S: Final = 15.0
"""Lifetime cap of one connection, whatever its state."""

MAX_REQUEST_LINE: Final = 2048
"""Largest request line accepted, in bytes."""

MAX_HEADER_BYTES: Final = 8192
"""Largest request head (request line and headers), in bytes."""

MAX_HEADER_COUNT: Final = 40
"""Largest number of header fields accepted."""

MAX_BODY_BYTES: Final = 512
"""Largest request body accepted. The claim body is about 60 bytes."""

RATE_PER_S: Final = 30.0
"""Sustained request rate of the whole page, across every client."""

RATE_BURST: Final = 60
"""Requests accepted at once before the sustained rate applies."""

RATE_LOG_INTERVAL_S: Final = 1.0
"""Smallest interval between two rate-limit log lines. The refusals in between are counted."""

MAX_STATIC_FILE_BYTES: Final = 2 * 1024 * 1024
"""Largest static file accepted at load."""

MAX_STATIC_FILES: Final = 64
"""Largest number of files in the static manifest."""

CREDENTIALS_REFRESH_BEFORE_EXPIRY_S: Final = 1200.0
"""Credentials are fetched again when this much validity is left (20 minutes)."""

CREDENTIALS_MIN_REMAINING_S: Final = 300.0
"""A fetch that returns less validity than this is a failure: a clock or alias fault."""

CREDENTIALS_CALL_TIMEOUT_S: Final = 15.0
"""Deadline of one call to the credentials provider."""

CREDENTIALS_BACKOFF_BASE_S: Final = 2.0
"""First retry window after a failed credentials fetch."""

CREDENTIALS_BACKOFF_CAP_S: Final = 60.0
"""Longest retry window after a failed credentials fetch."""

CREDENTIALS_SLEEP_SLICE_S: Final = 30.0
"""Longest single sleep of the refresh loop, so that a stop and a clock step are seen promptly."""

STOP_BUDGET_S: Final = 2.0
"""Time the service may take to stop. It stays below the runner's bound for services."""
