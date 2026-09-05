"""Tests for candle aggregation and the bucket grid it lays bars on.

The expectations here are wall-clock times read off a calendar, not values
computed with the helper under test, so a failure means the rule moved rather
than that two copies of one bug agree.

The grid is the point.  A 4h bar that does not open when the trading day opens
is a bar no trader recognises, and the review that produced this file caught
exactly that by eye: bars opening at 16:00 New York instead of 18:00.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.database.repository import TimeRange
from app.models.domain import Candle
from app.providers.trading_hours import (
    TRADING_HOURS_PER_WEEK,
    is_trading_minute,
    trading_hours_between,
)
from app.services.aggregation_service import aggregate_candles, bucket_start
from app.services.cache_service import estimate_bar_count, storage_interval

NEW_YORK = ZoneInfo("America/New_York")
CHICAGO = ZoneInfo("America/Chicago")
HOUR_MS = 3_600_000


def at(iso: str) -> int:
    """A UTC instant, in milliseconds."""

    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)


def in_new_york(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=NEW_YORK).strftime("%Y-%m-%d %H:%M")


def bar(
    time_ms: int, open_: float, high: float, low: float, close: float, volume: float
) -> Candle:
    return Candle(
        symbol="ES",
        time=time_ms,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


class TestTheBucketGridFollowsTheSession:
    """The CME day opens 17:00 Chicago -- 18:00 New York -- all year round.

    That is the fact the grid has to honour, and it is why these cases are
    written in New York time: the same wall-clock answer must come back in
    both daylight and standard time, even though the UTC instant differs.
    """

    @pytest.mark.parametrize(
        ("instant", "expected"),
        [
            # Summer, CDT: 09:07 Chicago on a Wednesday.
            ("2026-07-15T14:07:00", "2026-07-15 10:00"),
            # The same wall-clock moment in winter, CST. A fixed UTC anchor
            # gets this one an hour early -- this is the regression case.
            ("2026-12-15T14:07:00", "2026-12-15 06:00"),
            # The first instant of a session opens its own bar.
            ("2026-07-14T22:00:00", "2026-07-14 18:00"),
            # ... and one millisecond earlier still belongs to the day before.
            ("2026-07-14T21:59:59.999", "2026-07-14 14:00"),
            # Winter session open: 17:00 Chicago is 23:00 UTC under CST.
            ("2026-12-14T23:00:00", "2026-12-14 18:00"),
        ],
    )
    def test_four_hour_bars_open_on_the_session_grid(self, instant: str, expected: str) -> None:
        assert in_new_york(bucket_start(at(instant), "4h")) == expected

    @pytest.mark.parametrize(
        ("instant", "expected"),
        [
            # 6h from an 18:00 New York open: 18:00, 00:00, 06:00, 12:00.
            ("2026-07-15T14:07:00", "2026-07-15 06:00"),
            ("2026-12-15T14:07:00", "2026-12-15 06:00"),
            ("2026-07-14T22:30:00", "2026-07-14 18:00"),
        ],
    )
    def test_six_hour_bars_open_on_the_session_grid(self, instant: str, expected: str) -> None:
        assert in_new_york(bucket_start(at(instant), "6h")) == expected

    @pytest.mark.parametrize(
        ("instant", "expected"),
        [
            # Wednesday morning belongs to the day that opened Tuesday evening.
            ("2026-07-15T14:07:00", "2026-07-14 18:00"),
            ("2026-12-15T14:07:00", "2026-12-14 18:00"),
        ],
    )
    def test_the_daily_bar_opens_the_previous_evening(self, instant: str, expected: str) -> None:
        assert in_new_york(bucket_start(at(instant), "1d")) == expected

    def test_the_same_new_york_hour_buckets_alike_across_daylight_saving(self) -> None:
        """The whole point, stated once.

        08:30 New York is a different UTC instant in July and December, and
        both must land in the 06:00 New York bar.  A constant UTC offset
        cannot satisfy both, which is how the old anchor came to be right for
        one half of the year and an hour out for the other.
        """

        summer = int(datetime(2026, 7, 15, 8, 30, tzinfo=NEW_YORK).timestamp() * 1000)
        winter = int(datetime(2026, 12, 15, 8, 30, tzinfo=NEW_YORK).timestamp() * 1000)

        assert in_new_york(bucket_start(summer, "4h")) == "2026-07-15 06:00"
        assert in_new_york(bucket_start(winter, "4h")) == "2026-12-15 06:00"

    @pytest.mark.parametrize(
        ("interval", "step"),
        [("5m", 300_000), ("15m", 900_000), ("1h", HOUR_MS)],
    )
    def test_short_intervals_stay_on_the_plain_utc_grid(self, interval: str, step: int) -> None:
        """They divide the session evenly from either origin, so the cheaper
        arithmetic is also the correct one -- and it needs no timezone."""

        instant = at("2026-12-15T14:07:33")
        start = bucket_start(instant, interval)

        assert start % step == 0
        assert 0 <= instant - start < step

    def test_a_bucket_start_is_its_own_bucket(self) -> None:
        """Idempotence. Without it, re-aggregating a series would drift."""

        once = bucket_start(at("2026-12-15T14:07:00"), "4h")
        assert bucket_start(once, "4h") == once


class TestTheOhlcvReduction:
    def test_open_high_low_close_and_volume(self) -> None:
        opening = bucket_start(at("2026-07-15T14:07:00"), "4h")
        bars = [
            bar(opening + 0 * HOUR_MS, 100, 105, 99, 104, 10),
            bar(opening + 1 * HOUR_MS, 104, 112, 103, 108, 20),
            bar(opening + 2 * HOUR_MS, 108, 110, 95, 97, 30),
            bar(opening + 3 * HOUR_MS, 97, 101, 96, 100, 40),
        ]

        (result,) = aggregate_candles(bars, "4h")

        assert result.time == opening
        assert result.open == 100  # the first bar's open, not the lowest
        assert result.high == 112
        assert result.low == 95
        assert result.close == 100  # the last bar's close, not the highest
        assert result.volume == 100

    def test_bars_either_side_of_a_session_open_land_in_different_days(self) -> None:
        """17:59 and 18:01 New York are two minutes apart and a day apart."""

        before = int(datetime(2026, 7, 14, 17, 59, tzinfo=NEW_YORK).timestamp() * 1000)
        after = int(datetime(2026, 7, 14, 18, 1, tzinfo=NEW_YORK).timestamp() * 1000)

        result = aggregate_candles(
            [bar(before, 100, 100, 100, 100, 1), bar(after, 200, 200, 200, 200, 2)], "1d"
        )

        assert len(result) == 2
        assert in_new_york(result[0].time) == "2026-07-13 18:00"
        assert in_new_york(result[1].time) == "2026-07-14 18:00"

    def test_no_candles_is_no_buckets(self) -> None:
        assert aggregate_candles([], "4h") == []


class TestCountingTradingHours:
    def test_the_weekly_constant_agrees_with_the_session_rule(self) -> None:
        """The constant is a shortcut through the scan, never a second copy of
        the rule, so it is checked against the rule itself."""

        # A full Sunday-to-Saturday week, walked an hour at a time.
        start = datetime(2026, 5, 24, 0, 0, tzinfo=CHICAGO)
        open_hours = sum(
            1 for step in range(24 * 7) if is_trading_minute(start + timedelta(hours=step))
        )

        assert open_hours == TRADING_HOURS_PER_WEEK

    def test_a_weekend_holds_no_trading_hours(self) -> None:
        saturday = int(datetime(2026, 5, 30, 0, 0, tzinfo=CHICAGO).timestamp() * 1000)

        assert trading_hours_between(saturday, saturday + 12 * HOUR_MS) == 0.0

    def test_a_reversed_window_holds_nothing(self) -> None:
        assert trading_hours_between(2_000, 1_000) == 0.0


class TestSizingARequestHonestly:
    """The guard that refused 90 days of 5-minute bars during the review.

    It was counting weekends and the daily maintenance halt as tradeable, so
    the window was rejected over thousands of bars that never existed.
    """

    @staticmethod
    def _window(days: int) -> TimeRange:
        end = at("2026-09-05T00:00:00")
        return TimeRange(end - days * 24 * HOUR_MS, end)

    def test_ninety_days_of_five_minute_bars_fits_under_the_cap(self) -> None:
        # 20,000 is the configured ceiling; the real bar count is well under.
        assert estimate_bar_count(self._window(90), "5m") < 20_000

    def test_the_estimate_is_far_below_the_wall_clock_count(self) -> None:
        """The market is open about 115 hours in a 168-hour week, so a naive
        count overstates an intraday window by roughly 45%."""

        naive = self._window(90).length // 300_000

        assert estimate_bar_count(self._window(90), "5m") < naive * 0.75

    def test_a_genuinely_oversized_window_is_still_counted_as_oversized(self) -> None:
        # Honesty cuts both ways: the cap has to keep meaning something.
        assert estimate_bar_count(self._window(365), "5m") > 20_000

    def test_an_empty_window_holds_no_bars(self) -> None:
        assert estimate_bar_count(TimeRange(5_000, 5_000), "5m") == 0

class TestWhatGetsStored:
    def test_daily_bars_are_built_from_hours_rather_than_fetched(self) -> None:
        """Otherwise the session anchoring above never runs for ``1d``.

        A vendor's daily bar is stamped at calendar midnight. Persisting that
        verbatim put the daily candle's open six hours into the session --
        20:00 New York on a day that began at 18:00 -- and no bucketing code
        ever touched it, because a natively stored interval is never
        aggregated.
        """

        assert storage_interval("1d") == "1h"

    def test_the_long_intervals_share_one_stored_series(self) -> None:
        # Which is why building dailies from hours costs no extra fetching.
        assert {storage_interval(interval) for interval in ("1h", "4h", "6h", "1d")} == {"1h"}

    @pytest.mark.parametrize("interval", ["5m", "15m"])
    def test_short_intervals_are_stored_as_themselves(self, interval: str) -> None:
        assert storage_interval(interval) == interval
