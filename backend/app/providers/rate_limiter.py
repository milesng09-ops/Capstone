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
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque

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

    def __init__(self, max_calls: int, per_seconds: float, name: str = "provider") -> None:
        if max_calls < 1:
            raise ValueError("max_calls must be at least 1")
        self._max_calls = max_calls
        self._per = per_seconds
        self._name = name
        self._calls: deque[float] = deque()
        self._lock = asyncio.Lock()

    @property
    def max_calls(self) -> int:
        return self._max_calls

    def _now(self) -> float:
        # Monotonic: a clock adjustment mid-window must not hand out free slots.
        return asyncio.get_running_loop().time()

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

        # The lock is held across the sleep on purpose.  Waiters that checked
        # concurrently would each see the same free slot and all take it; the
        # serialisation is what makes the count exact, and it also makes the
        # queue first-come-first-served instead of a scramble on wake-up.
        async with self._lock:
            while True:
                now = self._now()
                self._expire(now)

                if len(self._calls) < self._max_calls:
                    self._calls.append(now)
                    return max(0.0, now - (deadline - max_wait))

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
        _massive_limiter = SlidingWindowRateLimiter(
            max_calls=settings.massive_max_requests_per_minute,
            per_seconds=60.0,
            name="massive",
        )
    return _massive_limiter


def reset_massive_limiter() -> None:
    """Drop the shared budget. For tests and for a settings reload."""

    global _massive_limiter
    _massive_limiter = None
