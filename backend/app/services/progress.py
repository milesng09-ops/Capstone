"""What a running backtest is doing right now, for the screen.

A GXT run over half a year of 1-minute candles makes dozens of Massive calls
against a five-a-minute quota: ten minutes or more, most of it spent waiting
for the quota. When that ran inside one long HTTP request, the page could only
say "Testing..." -- a run working through its quota and a run that was stuck
looked the same, and a refresh threw the result away.

Code deep in the data layer reports here, and the job that owns the run (see
:mod:`app.services.backtest_jobs`) turns it into the status the page polls. A
context variable carries the reporter, so nothing between the job and the
provider has to pass it along, and code running outside a job -- the chart's
own bar requests -- reports into nothing.
"""

from __future__ import annotations

import time
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass
class Progress:
    """The latest word from a running job. Plain values only: it is read as-is."""

    stage: str = "Starting"
    detail: str | None = None
    done: int | None = None
    total: int | None = None
    waiting_until: float | None = None
    updated_at: float = field(default_factory=time.time)


_current: ContextVar[Progress | None] = ContextVar("backtest_progress", default=None)


def bind(progress: Progress) -> None:
    """Make ``progress`` the reporter for this task and the tasks it starts."""

    _current.set(progress)


def report(
    stage: str,
    *,
    detail: str | None = None,
    done: int | None = None,
    total: int | None = None,
) -> None:
    progress = _current.get()
    if progress is None:
        return
    progress.stage = stage
    progress.detail = detail
    progress.done = done
    progress.total = total
    progress.waiting_until = None
    progress.updated_at = time.time()


def detail(text: str) -> None:
    """Refine the current stage without resetting its count."""

    progress = _current.get()
    if progress is None:
        return
    progress.detail = text
    progress.waiting_until = None
    progress.updated_at = time.time()


def waiting(provider: str, seconds: float, limit: int) -> None:
    """A provider's quota is full: say so, and for how long, rather than look stuck."""

    progress = _current.get()
    if progress is None:
        return
    progress.detail = (
        f"Waiting {seconds:.0f}s for {provider}'s rate limit ({limit} requests per minute)"
    )
    progress.waiting_until = time.time() + seconds
    progress.updated_at = time.time()
