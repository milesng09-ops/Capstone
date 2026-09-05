"""The client-side budget that keeps us under Massive's five-a-minute quota.

Going over does not cost one rejected call.  It costs the call, plus a
two-minute health cool-off, plus -- before the chain was changed -- a chart
quietly drawn from synthetic candles.  So the limiter is load-bearing, and
the cases below are the ones where a limiter that looks right is not: bursts
arriving together, waiters queueing behind each other, and the window sliding
rather than resetting.
"""

from __future__ import annotations

import asyncio

import pytest

from app.providers.rate_limiter import (
    RateLimitExceeded,
    SlidingWindowRateLimiter,
    get_massive_limiter,
    reset_massive_limiter,
)


def limiter(max_calls: int = 5, per_seconds: float = 60.0) -> SlidingWindowRateLimiter:
    return SlidingWindowRateLimiter(max_calls, per_seconds, name="test")


class TestBudget:
    @pytest.mark.anyio
    async def test_calls_inside_the_budget_are_not_delayed(self):
        bucket = limiter(max_calls=5)

        waits = [await bucket.acquire(max_wait=0.0) for _ in range(5)]

        assert waits == [0.0] * 5

    @pytest.mark.anyio
    async def test_the_call_over_the_budget_is_refused_rather_than_sent(self):
        bucket = limiter(max_calls=5)
        for _ in range(5):
            await bucket.acquire(max_wait=0.0)

        with pytest.raises(RateLimitExceeded) as caught:
            await bucket.acquire(max_wait=0.0)

        # The wait is the payload: it becomes the countdown the user sees.
        assert caught.value.retry_after_seconds > 0

    @pytest.mark.anyio
    async def test_a_caller_willing_to_wait_gets_through(self):
        bucket = limiter(max_calls=2, per_seconds=0.3)
        await bucket.acquire(max_wait=0.0)
        await bucket.acquire(max_wait=0.0)

        waited = await bucket.acquire(max_wait=5.0)

        assert waited > 0, "the third call had to wait for the window to slide"

    @pytest.mark.anyio
    async def test_the_window_slides_instead_of_resetting(self):
        # A fixed-window limiter lets 2N calls through across a boundary. This
        # one must not: the quota is "in any minute", not "per calendar minute".
        bucket = limiter(max_calls=2, per_seconds=0.3)
        await bucket.acquire(max_wait=0.0)
        await asyncio.sleep(0.2)
        await bucket.acquire(max_wait=0.0)

        # 0.2s in, the first call is still inside the window, so this is over.
        with pytest.raises(RateLimitExceeded):
            await bucket.acquire(max_wait=0.0)

        await asyncio.sleep(0.15)
        # Now the first has aged out and exactly one slot has reopened.
        await bucket.acquire(max_wait=0.0)


class TestConcurrency:
    @pytest.mark.anyio
    async def test_a_simultaneous_burst_cannot_overshoot_the_budget(self):
        # The failure this guards: every waiter checks at once, all see the
        # same free slot, and all take it. The limit would hold on paper and
        # be exceeded on the wire.
        bucket = limiter(max_calls=5)

        results = await asyncio.gather(
            *(bucket.acquire(max_wait=0.0) for _ in range(20)),
            return_exceptions=True,
        )

        admitted = [item for item in results if not isinstance(item, Exception)]
        refused = [item for item in results if isinstance(item, RateLimitExceeded)]
        assert len(admitted) == 5
        assert len(refused) == 15

    @pytest.mark.anyio
    async def test_queued_waiters_are_admitted_in_order(self):
        bucket = limiter(max_calls=1, per_seconds=0.1)
        await bucket.acquire(max_wait=0.0)
        order: list[int] = []

        async def caller(index: int) -> None:
            await bucket.acquire(max_wait=5.0)
            order.append(index)

        await asyncio.gather(*(caller(index) for index in range(4)))

        assert order == [0, 1, 2, 3], "first to queue should be first to send"

    @pytest.mark.anyio
    async def test_the_wait_cap_covers_time_spent_queueing(self):
        # A waiter behind three others serves their waits as well as its own.
        # Bounding only the final sleep would let it sit far past its cap.
        bucket = limiter(max_calls=1, per_seconds=1.0)
        await bucket.acquire(max_wait=0.0)

        results = await asyncio.gather(
            *(bucket.acquire(max_wait=1.2) for _ in range(4)),
            return_exceptions=True,
        )

        refused = [item for item in results if isinstance(item, RateLimitExceeded)]
        assert refused, "someone deep in the queue should have given up"


class TestSharedBudget:
    def test_every_caller_in_the_process_draws_on_one_budget(self):
        # The quota belongs to the API key. Two limiters would each pace
        # themselves correctly and together send double the allowed rate.
        reset_massive_limiter()
        try:
            assert get_massive_limiter() is get_massive_limiter()
        finally:
            reset_massive_limiter()

    def test_the_budget_is_sized_from_settings(self):
        reset_massive_limiter()
        try:
            assert get_massive_limiter().max_calls == 5
        finally:
            reset_massive_limiter()
