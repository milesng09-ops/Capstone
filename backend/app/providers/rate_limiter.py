"""Client-side pacing for a provider with a published request quota.

Massive allows five requests a minute.  Going over does not merely fail the
request that went over: the 429 knocks the provider out of the chain for a
two-minute health cool-off, so one burst costs far more than the calls in it.
The cheapest fix is not to send the sixth request in the first place.

This is a sliding-window limiter rather than a token bucket because the quota
is written as "5 per minute" and a bucket with a refill rate approximates that
in a way that is off by a token exactly when it matters -- at the burst.  Here
the window holds the timestamps of the calls actually made, so the limit is
the literal one the vendor documents.

Two things the window alone cannot know are fed into it:

* **A 429.** The vendor counts every call made with the key, including ones
  from another process or another machine sharing it, so its verdict
  outranks our own count. :meth:`SlidingWindowRateLimiter.block_for` closes
  the window until the vendor says it reopens, and every queued caller waits
  it out instead of each spending a retry on it.
* **A restart.** ``uvicorn --reload`` restarts the process on every save, and
  a fresh process with an empty window would send five calls straight after
  the old one sent five. The window is written to a small state file and read
  back on first use, so a restart inherits the minute it interrupted.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import deque
from pathlib import Path

logger = logging.getLogger(__name__)


class RateLimitExceeded(Exception):
    """Raised when a slot will not free up within the caller's patience.

    Carries the wait the caller declined, so the layer above can turn it into
    a countdown rather than a bare failure.
    """

    def __init__(self, retry_after_seconds: float) -> None:
        super().__init__(
            f"Local request budget is spent; next slot in {retry_after_seconds:.1f}s"
        )
        self.retry_after_seconds = retry_after_seconds


class SlidingWindowRateLimiter:
    """Admits at most ``max_calls`` in any ``per_seconds`` window."""

    def __init__(
        self,
        max_calls: int,
        per_seconds: float,
        name: str = "provider",
        state_path: Path | None = None,
    ) -> None:
        if max_calls < 1:
            raise ValueError("max_calls must be at least 1")
        self._max_calls = max_calls
        self._per = per_seconds
        self._name = name
        self._calls: deque[float] = deque()
        self._lock = asyncio.Lock()
        #: Loop time before which no call is admitted, whatever the window
        #: holds. Set by :meth:`block_for` when the vendor answers 429.
        self._blocked_until = 0.0
        self._state_path = state_path
        # Read lazily: the window is kept in loop time, and there is no running
        # loop to convert the saved wall-clock times against at construction.
        self._restored = state_path is None

    @property
    def max_calls(self) -> int:
        return self._max_calls

    def _now(self) -> float:
        # Monotonic: a clock adjustment mid-window must not hand out free slots.
        return asyncio.get_running_loop().time()

    # ------------------------------------------------------------------
    # The state file
    # ------------------------------------------------------------------
    def _restore(self, now: float) -> None:
        """Adopt the window a previous process left behind, once.

        Saved as wall-clock times, because loop time restarts with the
        process; converted back by age, so only calls still inside the window
        come back. A missing or unreadable file is an empty window -- the
        state is a courtesy to the quota, never a reason to fail a request.
        """

        if self._restored:
            return
        self._restored = True
        assert self._state_path is not None
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
            wall = time.time()
            ages = sorted(
                (wall - float(stamp) for stamp in data.get("calls", [])), reverse=True
            )
            blocked = float(data.get("blocked_until", 0.0)) - wall
        except (OSError, ValueError, TypeError, AttributeError):
            return
        for age in ages:
            if 0.0 <= age < self._per:
                self._calls.append(now - age)
        while len(self._calls) > self._max_calls:
            self._calls.popleft()
        if blocked > 0:
            self._blocked_until = max(self._blocked_until, now + blocked)

    def _save(self, now: float) -> None:
        if self._state_path is None:
            return
        wall = time.time()
        state = {
            "calls": [wall - (now - stamp) for stamp in self._calls],
            "blocked_until": wall + max(0.0, self._blocked_until - now),
        }
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            # Written beside the target and swapped in, so a process killed
            # mid-write leaves the previous state rather than half of one.
            scratch = self._state_path.with_suffix(".tmp")
            scratch.write_text(json.dumps(state), encoding="utf-8")
            os.replace(scratch, self._state_path)
        except OSError as exc:
            logger.debug("Could not save the %s budget: %s", self._name, exc)

    # ------------------------------------------------------------------
    def block_for(self, seconds: float) -> None:
        """Admit nothing for ``seconds``: the vendor has said the quota is spent.

        Not taken under the lock, which a queued caller holds across its
        sleep; the waiter re-reads the block when it wakes.
        """

        now = self._now()
        if not self._restored:
            self._restore(now)
        self._blocked_until = max(self._blocked_until, now + max(0.0, seconds))
        self._save(now)

    def _expire(self, now: float) -> None:
        horizon = now - self._per
        while self._calls and self._calls[0] <= horizon:
            self._calls.popleft()

    async def acquire(self, max_wait: float) -> float:
        """Reserve a slot, waiting up to ``max_wait`` seconds for one.

        Returns how long the caller was made to wait.  Raises
        :class:`RateLimitExceeded` instead of waiting longer than asked.
        """

        # Fixed before queueing, so ``max_wait`` bounds the total time spent
        # here rather than only the final sleep.  Waiters queue on the lock,
        # and a limit of five a minute means the fifth in a burst would
        # otherwise be told a short wait and then serve a long one.
        deadline = self._now() + max_wait
        waited = self._lock.locked()

        # The lock is held across the sleep on purpose.  Waiters that checked
        # concurrently would each see the same free slot and all take it; the
        # serialisation is what makes the count exact, and it also makes the
        # queue first-come-first-served instead of a scramble on wake-up.
        async with self._lock:
            while True:
                now = self._now()
                if not self._restored:
                    self._restore(now)
                self._expire(now)

                if now < self._blocked_until:
                    ready_at = self._blocked_until
                elif len(self._calls) < self._max_calls:
                    self._calls.append(now)
                    self._save(now)
                    return max(0.0, now - (deadline - max_wait)) if waited else 0.0
                else:
                    ready_at = self._calls[0] + self._per
                if ready_at > deadline:
                    raise RateLimitExceeded(max(0.0, ready_at - now))

                logger.debug(
                    "%s budget full (%s/%ss); waiting %.1fs",
                    self._name,
                    self._max_calls,
                    self._per,
                    ready_at - now,
                )
                waited = True
                await asyncio.sleep(max(0.0, ready_at - now))

    def snapshot(self) -> tuple[int, int]:
        """``(used, max)`` in the current window, for diagnostics."""

        try:
            self._expire(self._now())
        except RuntimeError:
            # No running loop; report what is recorded rather than failing.
            pass
        return len(self._calls), self._max_calls

    def reset(self) -> None:
        self._calls.clear()
        self._blocked_until = 0.0


# --------------------------------------------------------------------------
# The process-wide budget for Massive
# --------------------------------------------------------------------------
_massive_limiter: SlidingWindowRateLimiter | None = None


def get_massive_limiter() -> SlidingWindowRateLimiter:
    """The one budget shared by every Massive call in this process.

    The quota is a property of the API key, so it is held here rather than on
    the provider object: two providers built by accident would otherwise each
    pace themselves perfectly and together send twice the allowed rate.
    """

    global _massive_limiter
    if _massive_limiter is None:
        from app.config import get_settings

        settings = get_settings()
        state = settings.massive_quota_state_file.strip()
        _massive_limiter = SlidingWindowRateLimiter(
            max_calls=settings.massive_max_requests_per_minute,
            per_seconds=60.0,
            name="massive",
            state_path=Path(state) if state else None,
        )
    return _massive_limiter


def reset_massive_limiter() -> None:
    """Drop the shared budget. For tests and for a settings reload."""

    global _massive_limiter
    _massive_limiter = None
