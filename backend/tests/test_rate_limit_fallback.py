"""What happens when Massive says 429.

The behaviour under test is the one that used to be silent: a quota rejection
knocked Massive out for a two-minute cool-off, the chain walked down to
bundled demo data, and the chart carried on drawing candles that were not
market prices.  A strategy tested in that window scored on invented data and
looked exactly like a live run.

So the chain now ends at real data or at an error, and the rate limit travels
far enough up the stack for the UI to say "wait", with a number, rather than
"something went wrong".
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models.domain import Candle, ProviderFetchResult
from app.providers.base import (
    MarketDataProvider,
    ProviderRateLimitError,
    ProviderThrottledError,
    ProviderUnavailableError,
)
from app.providers.fallback_provider import CHAINS, AutomaticFallbackProvider
from app.providers.health import ProviderHealthRegistry

START = datetime(2026, 9, 2, tzinfo=timezone.utc)
END = START + timedelta(hours=4)


class StubProvider(MarketDataProvider):
    """A provider that does exactly one thing, on demand."""

    native_intervals = {"1h"}

    def __init__(self, name: str, *, error: Exception | None = None) -> None:
        self.name = name
        self.display_name = name.title()
        self.quality = "delayed"
        self._error = error
        self.calls = 0

    async def is_configured(self) -> bool:
        return True

    async def get_symbols(self):
        return []

    async def get_bars(self, symbol, interval, start_time, end_time):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return [
            Candle(
                symbol=symbol,
                time=int(start_time.timestamp() * 1000),
                open=1.0,
                high=2.0,
                low=0.5,
                close=1.5,
                volume=10,
            )
        ]

    async def close(self) -> None:
        return None


def build(providers: dict[str, MarketDataProvider]) -> AutomaticFallbackProvider:
    return AutomaticFallbackProvider(
        providers=providers, registry=ProviderHealthRegistry()
    )


# --------------------------------------------------------------------------
# The chain itself
# --------------------------------------------------------------------------
class TestChains:
    @pytest.mark.parametrize("requested", ["auto", "massive", "yahoo"])
    def test_no_automatic_chain_can_reach_demo_data(self, requested):
        assert "demo" not in CHAINS[requested]

    def test_demo_is_still_reachable_by_asking_for_it(self):
        # The no-API-key path for someone who just cloned the repo. Choosing
        # synthetic data is fine; being handed it silently is not.
        assert CHAINS["demo"] == ["demo"]


# --------------------------------------------------------------------------
# A quota rejection
# --------------------------------------------------------------------------
class TestRateLimit:
    @pytest.mark.anyio
    async def test_yahoo_still_covers_for_a_rate_limited_massive(self):
        limited = StubProvider(
            "massive",
            error=ProviderRateLimitError("HTTP 429", provider="massive", retry_after_seconds=12),
        )
        yahoo = StubProvider("yahoo")
        provider = build({"massive": limited, "yahoo": yahoo})

        result = await provider.fetch("ES", "1h", START, END)

        assert isinstance(result, ProviderFetchResult)
        assert result.provider == "yahoo"
        assert result.bars, "real bars, from the second real provider"

    @pytest.mark.anyio
    async def test_the_429_survives_when_nothing_else_can_serve(self):
        limited = StubProvider(
            "massive",
            error=ProviderRateLimitError("HTTP 429", provider="massive", retry_after_seconds=12),
        )
        broken = StubProvider("yahoo", error=ProviderUnavailableError("socket closed"))
        provider = build({"massive": limited, "yahoo": broken})

        with pytest.raises(ProviderRateLimitError) as caught:
            await provider.fetch("ES", "1h", START, END)

        # Not flattened into "All providers failed": the wait time is the
        # whole point, and a generic outage message throws it away.
        assert caught.value.retry_after_seconds == 12

    @pytest.mark.anyio
    async def test_the_rate_limit_outranks_a_later_unrelated_failure(self):
        # Massive is over quota and Yahoo is simply down. "Wait 12s" is the
        # actionable half, so that is what the user is told.
        limited = StubProvider(
            "massive",
            error=ProviderRateLimitError("HTTP 429", provider="massive", retry_after_seconds=12),
        )
        broken = StubProvider("yahoo", error=ProviderUnavailableError("HTTP 500"))
        provider = build({"massive": limited, "yahoo": broken})

        with pytest.raises(ProviderRateLimitError):
            await provider.fetch("ES", "1h", START, END)

    @pytest.mark.anyio
    async def test_the_registry_records_it_as_a_quota_not_an_outage(self):
        registry = ProviderHealthRegistry()
        limited = StubProvider(
            "massive",
            error=ProviderRateLimitError("HTTP 429", provider="massive", retry_after_seconds=12),
        )
        provider = AutomaticFallbackProvider(
            providers={"massive": limited, "yahoo": StubProvider("yahoo")},
            registry=registry,
        )

        await provider.fetch("ES", "1h", START, END)

        entry = registry.entry("massive")
        assert entry.rate_limited is True
        assert entry.healthy is False

    @pytest.mark.anyio
    async def test_a_plain_outage_is_not_labelled_a_quota_problem(self):
        registry = ProviderHealthRegistry()
        provider = AutomaticFallbackProvider(
            providers={
                "massive": StubProvider("massive", error=ProviderUnavailableError("timeout")),
                "yahoo": StubProvider("yahoo"),
            },
            registry=registry,
        )

        await provider.fetch("ES", "1h", START, END)

        assert registry.entry("massive").rate_limited is False

    @pytest.mark.anyio
    async def test_a_recovered_provider_stops_reporting_a_stale_quota(self):
        registry = ProviderHealthRegistry()
        registry.mark_failure("massive", "HTTP 429", rate_limited=True)

        registry.mark_success("massive")

        entry = registry.entry("massive")
        assert entry.rate_limited is False
        assert entry.cooldown_until_ms is None


# --------------------------------------------------------------------------
# Our own pacing, as opposed to the provider's verdict
# --------------------------------------------------------------------------
class TestClientSideThrottle:
    """The throttle must not cause the outage it exists to prevent.

    A 429 costs a two-minute cool-off. If declining to send a call imposed the
    same cool-off, the limiter would buy the entire penalty while skipping the
    request that might have succeeded -- strictly worse than not having it.
    """

    @pytest.mark.anyio
    async def test_being_paced_does_not_mark_the_provider_unhealthy(self):
        registry = ProviderHealthRegistry()
        paced = StubProvider(
            "massive",
            error=ProviderThrottledError(
                "budget spent", provider="massive", retry_after_seconds=4
            ),
        )
        provider = AutomaticFallbackProvider(
            providers={"massive": paced, "yahoo": StubProvider("yahoo")},
            registry=registry,
        )

        await provider.fetch("ES", "1h", START, END)

        entry = registry.entry("massive")
        assert entry.healthy is True, "we paced it; it did not fail"
        assert registry.is_available("massive") is True

    @pytest.mark.anyio
    async def test_the_next_request_may_try_massive_again_immediately(self):
        registry = ProviderHealthRegistry()
        # Spent budget on the first call, a free slot by the second.
        paced = StubProvider(
            "massive",
            error=ProviderThrottledError(
                "budget spent", provider="massive", retry_after_seconds=4
            ),
        )
        provider = AutomaticFallbackProvider(
            providers={"massive": paced, "yahoo": StubProvider("yahoo")},
            registry=registry,
        )
        await provider.fetch("ES", "1h", START, END)

        paced._error = None
        result = await provider.fetch("ES", "1h", START, END)

        # A cool-off would have skipped Massive without calling it at all.
        assert result.provider == "massive"
        assert paced.calls == 2

    @pytest.mark.anyio
    async def test_the_countdown_is_still_published_for_the_ui(self):
        registry = ProviderHealthRegistry()
        provider = AutomaticFallbackProvider(
            providers={
                "massive": StubProvider(
                    "massive",
                    error=ProviderThrottledError(
                        "budget spent", provider="massive", retry_after_seconds=4
                    ),
                ),
                "yahoo": StubProvider("yahoo"),
            },
            registry=registry,
        )

        await provider.fetch("ES", "1h", START, END)

        entry = registry.entry("massive")
        assert entry.rate_limited is True
        assert entry.cooldown_until_ms is not None

    @pytest.mark.anyio
    async def test_a_throttle_still_reads_as_a_rate_limit_further_up(self):
        # Subclassing ProviderRateLimitError is what lets the route answer 429
        # with a Retry-After instead of a bare 503.
        throttled = StubProvider(
            "massive",
            error=ProviderThrottledError(
                "budget spent", provider="massive", retry_after_seconds=4
            ),
        )
        broken = StubProvider("yahoo", error=ProviderUnavailableError("down"))
        provider = build({"massive": throttled, "yahoo": broken})

        with pytest.raises(ProviderRateLimitError) as caught:
            await provider.fetch("ES", "1h", START, END)

        assert caught.value.retry_after_seconds == 4
