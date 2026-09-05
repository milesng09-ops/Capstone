"""The session calendar, and what providers do with a closed market.

The distinction under test is the one that matters to the fallback chain:
"nothing came back because nothing trades then" is an answer, and "nothing
came back while the market was open" is a failure.  Reading the first as the
second is what demoted every provider in the chain each weekend and stamped a
chart of real prices as demo data.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.providers.base import ProviderDataError
from app.providers.massive_provider import MassiveProvider
from app.providers.trading_hours import has_trading_session, is_trading_minute

CHICAGO = ZoneInfo("America/Chicago")


def local(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=CHICAGO)


def ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


# --------------------------------------------------------------------------
# The minute rule
# --------------------------------------------------------------------------
class TestIsTradingMinute:
    def test_saturday_is_closed_all_day(self):
        for hour in (0, 9, 17, 23):
            assert is_trading_minute(local(2026, 9, 5, hour)) is False

    def test_sunday_opens_at_five_in_the_evening(self):
        assert is_trading_minute(local(2026, 9, 6, 16, 59)) is False
        assert is_trading_minute(local(2026, 9, 6, 17, 0)) is True

    def test_friday_closes_at_four(self):
        assert is_trading_minute(local(2026, 9, 4, 15, 59)) is True
        assert is_trading_minute(local(2026, 9, 4, 16, 0)) is False
        assert is_trading_minute(local(2026, 9, 4, 20, 0)) is False

    def test_the_daily_maintenance_hour_is_closed(self):
        # Wednesday: open either side of the halt, shut during it.
        assert is_trading_minute(local(2026, 9, 2, 15, 59)) is True
        assert is_trading_minute(local(2026, 9, 2, 16, 30)) is False
        assert is_trading_minute(local(2026, 9, 2, 17, 0)) is True

    def test_the_overnight_session_is_open(self):
        assert is_trading_minute(local(2026, 9, 2, 3, 0)) is True


# --------------------------------------------------------------------------
# Windows
# --------------------------------------------------------------------------
class TestHasTradingSession:
    def test_a_saturday_morning_holds_no_session(self):
        # The exact case that broke: a trailing gap fetched on a Saturday.
        assert (
            has_trading_session(ms(local(2026, 9, 5, 0)), ms(local(2026, 9, 5, 9)))
            is False
        )

    def test_the_whole_weekend_holds_no_session(self):
        assert (
            has_trading_session(ms(local(2026, 9, 4, 16)), ms(local(2026, 9, 6, 17)))
            is False
        )

    def test_a_weekend_window_that_reaches_the_reopen_does(self):
        assert (
            has_trading_session(ms(local(2026, 9, 5, 0)), ms(local(2026, 9, 6, 18)))
            is True
        )

    def test_a_window_ending_at_the_friday_close_still_holds_one(self):
        assert (
            has_trading_session(ms(local(2026, 9, 4, 15)), ms(local(2026, 9, 4, 16)))
            is True
        )

    def test_the_maintenance_hour_alone_holds_none(self):
        assert (
            has_trading_session(ms(local(2026, 9, 2, 16)), ms(local(2026, 9, 2, 17)))
            is False
        )

    def test_a_window_longer_than_any_closure_always_holds_one(self):
        # The early exit that keeps the scan off the hot path.
        start = ms(local(2026, 9, 4, 16))
        assert has_trading_session(start, start + int(timedelta(days=30).total_seconds() * 1000))

    def test_an_empty_or_reversed_window_holds_none(self):
        moment = ms(local(2026, 9, 2, 10))
        assert has_trading_session(moment, moment) is False
        assert has_trading_session(moment, moment - 60_000) is False

    def test_a_minute_of_open_market_is_not_stepped_over(self):
        # Shorter than the scan step, which is why the tail is checked too.
        assert (
            has_trading_session(ms(local(2026, 9, 2, 10)), ms(local(2026, 9, 2, 10, 1)))
            is True
        )

    def test_it_survives_the_spring_forward_weekend(self):
        # 8 March 2026: clocks go forward, so the closure is 48 hours, not 49.
        assert (
            has_trading_session(ms(local(2026, 3, 6, 16)), ms(local(2026, 3, 8, 17)))
            is False
        )

    def test_it_survives_the_fall_back_weekend(self):
        # 1 November 2026: the closure runs to 50 hours.
        assert (
            has_trading_session(ms(local(2026, 10, 30, 16)), ms(local(2026, 11, 1, 17)))
            is False
        )


# --------------------------------------------------------------------------
# What a provider does with it
# --------------------------------------------------------------------------
class TestProviderTreatsClosureAsAnAnswer:
    @staticmethod
    def _provider(monkeypatch) -> MassiveProvider:
        provider = MassiveProvider(api_key="test-key")

        async def no_rows(*args, **kwargs):
            return []

        monkeypatch.setattr(provider, "_fetch_contract", no_rows)
        return provider

    @pytest.mark.anyio
    async def test_no_bars_over_a_closed_market_returns_nothing(self, monkeypatch):
        provider = self._provider(monkeypatch)
        bars = await provider.get_bars(
            "ES", "1h", local(2026, 9, 5, 0), local(2026, 9, 5, 9)
        )
        assert bars == []

    @pytest.mark.anyio
    async def test_no_bars_while_the_market_was_open_is_still_a_failure(self, monkeypatch):
        provider = self._provider(monkeypatch)
        with pytest.raises(ProviderDataError):
            await provider.get_bars(
                "ES", "1h", local(2026, 9, 2, 9), local(2026, 9, 2, 15)
            )


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
