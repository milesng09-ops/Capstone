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
from app.providers.trading_hours import (
    empty_response_indicts_provider,
    has_trading_session,
    is_trading_minute,
)

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


# --------------------------------------------------------------------------
# Open, but only barely
# --------------------------------------------------------------------------
class TestASliverOfOpenMarketDoesNotIndictAProvider:
    """The window a coverage back-fill asks for, and what it may conclude.

    `has_trading_session` sees only open-or-shut.  These windows are open, for
    less time than a single bar covers, which is the case that used to demote
    a working provider.
    """

    #: The exact window that broke ES: the tail of the expiring June contract,
    #: Friday 15:00 CT to the Sunday reopen.  One open hour in thirty-eight.
    EXPIRING_TAIL = (ms(local(2026, 6, 5, 15)), ms(local(2026, 6, 7, 4, 59)))

    def test_the_window_really_does_hold_one_open_hour(self):
        # Guards the fixture itself: if the calendar ever changes underneath
        # this test, the cases below would pass for the wrong reason.
        start, end = self.EXPIRING_TAIL
        assert has_trading_session(start, end) is True

    def test_one_absent_hourly_bar_is_not_an_outage(self):
        start, end = self.EXPIRING_TAIL
        assert empty_response_indicts_provider(start, end, "1h") is False

    def test_the_same_window_still_indicts_at_a_finer_interval(self):
        # One open hour is twelve 5-minute bars. Missing all twelve is not a
        # single absent bar, so the concession does not apply.
        start, end = self.EXPIRING_TAIL
        assert empty_response_indicts_provider(start, end, "5m") is True

    def test_a_closed_window_is_still_excused(self):
        assert (
            empty_response_indicts_provider(
                ms(local(2026, 9, 5, 0)), ms(local(2026, 9, 5, 9)), "1h"
            )
            is False
        )

    def test_a_real_outage_still_fails_loudly(self):
        # A full trading day empty is empty across every bar in the window.
        assert (
            empty_response_indicts_provider(
                ms(local(2026, 9, 2, 9)), ms(local(2026, 9, 2, 15)), "1h"
            )
            is True
        )


class TestTheProviderSurvivesTheBackFillSliver:
    @pytest.mark.anyio
    async def test_the_expiring_contract_tail_does_not_demote_massive(
        self, monkeypatch
    ):
        """The regression: ES stuck loading because one hour had no bar.

        Three contract segments had already returned thousands of bars. The
        back-fill then asked for this sliver, got nothing, and the chain
        marked Massive unhealthy for two minutes over it.
        """

        provider = MassiveProvider(api_key="test-key")

        async def no_rows(*args, **kwargs):
            return []

        monkeypatch.setattr(provider, "_fetch_contract", no_rows)

        bars = await provider.get_bars(
            "ES", "1h", local(2026, 6, 5, 15), local(2026, 6, 7, 4, 59)
        )
        assert bars == []


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class TestTheCacheAgreesWithTheProvider:
    """The retry storm: excused by one layer, still owed by the other.

    The provider stopped calling a one-hour sliver an outage. The cache went
    on treating the same sliver as a range it had not been served, so the
    window was asked for, politely answered with nothing, left uncovered, and
    asked for again on the next poll -- three Massive calls a minute against a
    five-a-minute quota, with nobody touching the page.
    """

    #: The window that did it: Friday 15:00 CT to the Sunday reopen, one open
    #: hour in thirty-eight, on a contract with no bar there.
    SLIVER = (ms(local(2026, 6, 5, 15)), ms(local(2026, 6, 7, 4, 59)))

    def test_the_two_layers_reach_the_same_verdict(self):
        from app.providers.trading_hours import empty_response_indicts_provider

        start, end = self.SLIVER
        # Both sides now ask the same question of the same window.
        assert empty_response_indicts_provider(start, end, "1h") is False

    def test_an_excused_window_is_recorded_as_covered(self):
        """Covered, so the next poll does not ask for it again."""

        from app.services.candle_service import CandleService
        from app.database.repository import TimeRange

        start, end = self.SLIVER
        served = CandleService._served_span("ES", "1h", [], TimeRange(start, end))
        assert served == (start, end)

    def test_a_real_hole_is_still_left_uncovered(self):
        """The concession must not swallow a stretch we were genuinely owed."""

        from app.services.candle_service import CandleService
        from app.database.repository import TimeRange

        # A full trading day, empty: that is a hole, and re-asking is right.
        start, end = ms(local(2026, 9, 2, 9)), ms(local(2026, 9, 2, 15))
        assert CandleService._served_span("ES", "1h", [], TimeRange(start, end)) is None

    def test_a_closed_window_is_still_covered(self):
        from app.services.candle_service import CandleService
        from app.database.repository import TimeRange

        start, end = ms(local(2026, 9, 5, 0)), ms(local(2026, 9, 5, 9))
        assert CandleService._served_span("ES", "1h", [], TimeRange(start, end)) == (
            start,
            end,
        )
