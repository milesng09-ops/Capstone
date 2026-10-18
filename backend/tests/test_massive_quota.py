"""Staying inside Massive's five calls a minute when we are not its only user.

The limiter already counts our own calls. What it could not see were the
calls it did not make: another process on the same key (Miles's Mac and this
PC share one), or the process this one replaced on a ``--reload``. Both reach
us as a 429, and a 429 used to be retried a second and then four seconds
later -- two more rejected calls, each keeping the vendor's window full.

So these cover the three ways that budget now reaches past one process: the
vendor's verdict closes it, a restart inherits it, and work already paid for
is not bought twice when a load is cut short.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import httpx
import pytest

from app.providers.base import ProviderRateLimitError, ProviderThrottledError
from app.providers.health import ProviderHealthRegistry
from app.providers.massive_provider import MassiveProvider
from app.providers.rate_limiter import RateLimitExceeded, SlidingWindowRateLimiter


def limiter(tmp_path=None, max_calls: int = 5) -> SlidingWindowRateLimiter:
    state = tmp_path / "quota.json" if tmp_path is not None else None
    return SlidingWindowRateLimiter(max_calls, 60.0, name="test", state_path=state)


# --------------------------------------------------------------------------
# A 429 closes the budget
# --------------------------------------------------------------------------
class TestTheVendorsVerdict:
    @pytest.mark.anyio
    async def test_a_block_refuses_calls_the_window_would_admit(self):
        budget = limiter()
        budget.block_for(30)

        # Our own count is zero; the vendor's is not, and it wins.
        with pytest.raises(RateLimitExceeded) as caught:
            await budget.acquire(max_wait=5)
        assert 25 < caught.value.retry_after_seconds <= 30

    @pytest.mark.anyio
    async def test_a_caller_willing_to_wait_is_admitted_when_it_lifts(self):
        budget = limiter()
        budget.block_for(0.2)

        waited = await budget.acquire(max_wait=5)

        assert waited >= 0.15

    @pytest.mark.anyio
    async def test_a_429_is_not_retried(self):
        sent = []

        def vendor(request: httpx.Request) -> httpx.Response:
            sent.append(request)
            return httpx.Response(429)

        provider = massive(vendor)

        with pytest.raises(ProviderRateLimitError) as caught:
            await provider._request("/futures/v1/aggs/ESZ6", None)

        assert len(sent) == 1, "a retry is one more rejected call on a full window"
        # No Retry-After: wait out a whole window, the only certain answer.
        assert caught.value.retry_after_seconds == 60.0

    @pytest.mark.anyio
    async def test_the_vendors_retry_after_is_honoured(self):
        provider = massive(lambda _: httpx.Response(429, headers={"Retry-After": "7"}))

        with pytest.raises(ProviderRateLimitError) as caught:
            await provider._request("/futures/v1/aggs/ESZ6", None)

        assert caught.value.retry_after_seconds == 7.0

    @pytest.mark.anyio
    async def test_queued_callers_wait_out_the_429_instead_of_sending(self):
        provider = massive(lambda _: httpx.Response(429, headers={"Retry-After": "40"}))

        with pytest.raises(ProviderRateLimitError):
            await provider._request("/futures/v1/aggs/ESZ6", None)

        with pytest.raises(RateLimitExceeded):
            await provider._limiter.acquire(max_wait=5)

    def test_the_health_cool_off_lasts_as_long_as_the_vendor_asked(self):
        registry = ProviderHealthRegistry()
        before = int(time.time() * 1000)

        registry.mark_failure("massive", "HTTP 429", rate_limited=True, retry_after_seconds=7)

        until = registry.entry("massive").cooldown_until_ms
        assert until is not None
        # Seven seconds, not the generic two minutes.
        assert 6_000 <= until - before <= 9_000

    def test_an_outage_keeps_the_generic_cool_off(self):
        registry = ProviderHealthRegistry()
        before = int(time.time() * 1000)

        registry.mark_failure("massive", "HTTP 500", retry_after_seconds=7)

        until = registry.entry("massive").cooldown_until_ms
        assert until is not None and until - before >= 100_000


# --------------------------------------------------------------------------
# A restart inherits the minute it interrupted
# --------------------------------------------------------------------------
class TestARestart:
    @pytest.mark.anyio
    async def test_calls_made_before_a_restart_still_count(self, tmp_path):
        first = limiter(tmp_path, max_calls=2)
        await first.acquire(max_wait=0)
        await first.acquire(max_wait=0)

        # A new process: same file, empty memory.
        second = limiter(tmp_path, max_calls=2)

        with pytest.raises(RateLimitExceeded):
            await second.acquire(max_wait=0)

    @pytest.mark.anyio
    async def test_a_block_survives_a_restart(self, tmp_path):
        first = limiter(tmp_path)
        await first.acquire(max_wait=0)  # a running loop, as in the provider
        first.block_for(45)

        second = limiter(tmp_path)

        with pytest.raises(RateLimitExceeded) as caught:
            await second.acquire(max_wait=5)
        assert 40 < caught.value.retry_after_seconds <= 45

    @pytest.mark.anyio
    async def test_calls_older_than_the_window_are_forgotten(self, tmp_path):
        state = tmp_path / "quota.json"
        an_hour_ago = time.time() - 3600
        state.write_text(json.dumps({"calls": [an_hour_ago] * 5, "blocked_until": 0}))

        budget = limiter(tmp_path)

        assert await budget.acquire(max_wait=0) == 0.0

    @pytest.mark.anyio
    @pytest.mark.parametrize("content", ["", "not json", "[1, 2]", '{"calls": "x"}'])
    async def test_an_unreadable_file_is_an_empty_window(self, tmp_path, content):
        (tmp_path / "quota.json").write_text(content)

        budget = limiter(tmp_path)

        assert await budget.acquire(max_wait=0) == 0.0

    @pytest.mark.anyio
    async def test_without_a_path_nothing_is_written(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        budget = limiter()

        await budget.acquire(max_wait=0)
        budget.block_for(5)

        assert list(tmp_path.iterdir()) == []


# --------------------------------------------------------------------------
# A load cut short does not pay twice
# --------------------------------------------------------------------------
class TestSettledContracts:
    # Across the June roll, months in the past: two contracts, both final.
    START = datetime(2026, 5, 4, tzinfo=timezone.utc)
    END = datetime(2026, 7, 31, tzinfo=timezone.utc)

    @pytest.mark.anyio
    async def test_a_retry_only_buys_the_contract_it_is_missing(self, monkeypatch):
        provider = MassiveProvider(api_key="test-key", limiter=limiter())
        asked: list[str] = []
        budget = {"left": 1}

        async def fetch(ticker, resolution, start_ms, end_ms):
            asked.append(ticker)
            if budget["left"] == 0:
                raise ProviderThrottledError("budget spent", provider="massive")
            budget["left"] -= 1
            return [bar(start_ms)]

        monkeypatch.setattr(provider, "_fetch_contract", fetch)

        with pytest.raises(ProviderThrottledError):
            await provider.get_bars("ES", "1h", self.START, self.END)
        first, refused = asked
        assert first != refused

        budget["left"] = 5
        asked.clear()
        candles = await provider.get_bars("ES", "1h", self.START, self.END)

        assert asked == [refused], "the contract already paid for came from memory"
        assert len(candles) == 2

    @pytest.mark.anyio
    async def test_the_forming_contract_is_always_fetched(self, monkeypatch):
        provider = MassiveProvider(api_key="test-key", limiter=limiter())
        asked: list[str] = []

        async def fetch(ticker, resolution, start_ms, end_ms):
            asked.append(ticker)
            return [bar(end_ms - 3_600_000)]

        monkeypatch.setattr(provider, "_fetch_contract", fetch)
        end = datetime.now(tz=timezone.utc)
        start = datetime.fromtimestamp(end.timestamp() - 3 * 86_400, tz=timezone.utc)

        await provider.get_bars("ES", "1h", start, end)
        await provider.get_bars("ES", "1h", start, end)

        # Its last bars are still forming; a memo would freeze them.
        assert len(asked) == 2


# --------------------------------------------------------------------------
def massive(handler) -> MassiveProvider:
    provider = MassiveProvider(api_key="test-key", limiter=limiter())
    provider._client = httpx.AsyncClient(
        base_url="https://api.massive.test", transport=httpx.MockTransport(handler)
    )
    return provider


def bar(time_ms: int) -> dict:
    return {
        "time": time_ms,
        "open": 1.0,
        "high": 2.0,
        "low": 0.5,
        "close": 1.5,
        "volume": 10,
    }
