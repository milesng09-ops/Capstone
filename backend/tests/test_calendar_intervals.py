"""The intervals whose buckets come from a calendar rather than arithmetic.

Weekly and monthly bars cannot be placed by dividing a timestamp: a month is
not a fixed number of milliseconds, and a "week" measured as seven days from
the epoch starts on a Thursday.  Both are therefore resolved through the
session the instant trades in, and these cases are wall-clock dates read off a
calendar rather than values computed with the helper under test.

The awkward case each of them has is the one worth protecting.  For the week
it is Sunday evening, which is already Monday's trading and must land in the
week Monday belongs to.  For the month it is the same evening at a month
boundary: the session that opens at 17:00 on 31 August is September's first
trading day, and putting it in August would misdate the bar by a month.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.models.domain import Candle
from app.providers.massive_provider import MASSIVE_INTERVAL_MAP
from app.providers.yahoo_provider import YAHOO_INTERVAL_MAP
from app.services.aggregation_service import aggregate_candles, bucket_start
from app.services.cache_service import edge_padding_ms, storage_interval
from app.utils.intervals import (
    INTERVAL_ORDER,
    SUPPORTED_INTERVALS,
    UnsupportedIntervalError,
    get_interval,
    is_calendar_anchored,
    normalise_resolution,
    resolve_fetch_interval,
)

CHICAGO = ZoneInfo("America/Chicago")
HOUR_MS = 3_600_000


def chicago(text: str) -> int:
    """An exchange-local wall-clock time, in Unix milliseconds."""

    return int(datetime.fromisoformat(text).replace(tzinfo=CHICAGO).timestamp() * 1000)


def label(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=CHICAGO).strftime("%Y-%m-%d %H:%M")


def daily(time_text: str, open_=1.0, high=2.0, low=0.5, close=1.5, volume=1.0) -> Candle:
    return Candle(
        symbol="ES",
        time=chicago(time_text),
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
    )


class TestTheWeekStartsOnSundayEvening:
    @pytest.mark.parametrize(
        ("instant", "expected"),
        [
            # The reopen itself opens its own week.
            ("2026-09-06T17:00", "2026-09-06 17:00"),
            # Every session of that week answers with the same Sunday.
            ("2026-09-07T09:00", "2026-09-06 17:00"),
            ("2026-09-09T03:30", "2026-09-06 17:00"),
            ("2026-09-11T15:00", "2026-09-06 17:00"),
            # Saturday is shut; it still belongs to the week that just ended.
            ("2026-09-12T10:00", "2026-09-06 17:00"),
            # One minute before the reopen is still the old week.
            ("2026-09-13T16:59", "2026-09-06 17:00"),
            # And the reopen starts the next one.
            ("2026-09-13T17:00", "2026-09-13 17:00"),
        ],
    )
    def test_every_session_of_a_week_shares_one_bucket(self, instant, expected):
        assert label(bucket_start(chicago(instant), "1w")) == expected

    def test_the_week_opens_at_17_00_local_on_both_sides_of_a_dst_change(self):
        """Clocks go back on Sunday 1 November 2026, inside the reopen day."""

        before = bucket_start(chicago("2026-10-28T10:00"), "1w")
        after = bucket_start(chicago("2026-11-04T10:00"), "1w")

        assert label(before) == "2026-10-25 17:00"
        assert label(after) == "2026-11-01 17:00"
        # Seven days apart on the wall clock, but an hour more than that in
        # real time -- which is the whole reason the anchor is re-resolved on
        # the date instead of being stepped forward by a constant.
        assert after - before == 7 * 24 * HOUR_MS + HOUR_MS


class TestTheMonthStartsTheEveningBeforeItsFirstDay:
    @pytest.mark.parametrize(
        ("instant", "expected"),
        [
            # 15:00 on 31 August is still August's trading day.
            ("2026-08-31T15:00", "2026-07-31 17:00"),
            # Two hours later the session that opens is 1 September's.
            ("2026-08-31T17:00", "2026-08-31 17:00"),
            ("2026-09-01T09:00", "2026-08-31 17:00"),
            ("2026-09-30T15:00", "2026-08-31 17:00"),
            # And the evening of the 30th opens October.
            ("2026-09-30T17:00", "2026-09-30 17:00"),
        ],
    )
    def test_the_evening_open_belongs_to_the_next_days_month(self, instant, expected):
        assert label(bucket_start(chicago(instant), "1mo")) == expected

    def test_december_rolls_into_january(self):
        assert label(bucket_start(chicago("2026-12-31T18:00"), "1mo")) == "2026-12-31 17:00"
        assert label(bucket_start(chicago("2027-01-15T09:00"), "1mo")) == "2026-12-31 17:00"

    def test_february_is_not_assumed_to_be_thirty_days(self):
        """The nominal length of 1mo is 30 days; the bucket ignores it."""

        assert label(bucket_start(chicago("2027-02-15T09:00"), "1mo")) == "2027-01-31 17:00"
        assert label(bucket_start(chicago("2027-03-15T09:00"), "1mo")) == "2027-02-28 17:00"


class TestNinetyMinuteBarsFollowTheSession:
    """90 minutes does not divide the 23-hour session, so it is anchored to
    the open the way 4h is rather than to the UTC epoch."""

    def test_the_first_bucket_opens_with_the_session(self):
        assert label(bucket_start(chicago("2026-09-07T17:00"), "90m")) == "2026-09-07 17:00"

    def test_buckets_step_ninety_minutes_from_the_open(self):
        assert label(bucket_start(chicago("2026-09-08T09:00"), "90m")) == "2026-09-08 08:00"
        assert label(bucket_start(chicago("2026-09-08T09:30"), "90m")) == "2026-09-08 09:30"

    def test_the_grid_re_anchors_each_session_rather_than_drifting(self):
        """A 23-hour day leaves a short final bucket; the next day still
        opens on time, which is the convention charting platforms follow."""

        assert label(bucket_start(chicago("2026-09-08T16:30"), "90m")) == "2026-09-08 15:30"
        assert label(bucket_start(chicago("2026-09-08T17:00"), "90m")) == "2026-09-08 17:00"


class TestAggregationUsesTheCalendarGrid:
    def test_a_trading_week_of_daily_bars_becomes_one_weekly_bar(self):
        candles = [
            daily("2026-09-06T17:00", 100.0, 108.0, 99.0, 105.0),
            daily("2026-09-07T17:00", 105.0, 112.0, 104.0, 110.0),
            daily("2026-09-08T17:00", 110.0, 111.0, 101.0, 102.0),
            daily("2026-09-09T17:00", 102.0, 106.0, 100.0, 104.0),
            daily("2026-09-10T17:00", 104.0, 107.0, 103.0, 106.0),
            # The next week, which must not join the first.
            daily("2026-09-13T17:00", 106.0, 120.0, 106.0, 118.0),
        ]

        weekly = aggregate_candles(candles, "1w")

        assert [label(bar.time) for bar in weekly] == [
            "2026-09-06 17:00",
            "2026-09-13 17:00",
        ]
        first = weekly[0]
        assert (first.open, first.high, first.low, first.close) == (100.0, 112.0, 99.0, 106.0)
        assert first.volume == 5

    def test_a_month_boundary_splits_the_bars_by_trading_day(self):
        candles = [
            daily("2026-08-28T17:00"),
            daily("2026-08-30T17:00"),
            daily("2026-08-31T17:00"),
        ]

        monthly = aggregate_candles(candles, "1mo")

        # The first two are August's trading; the third is September's.
        assert [label(bar.time) for bar in monthly] == [
            "2026-07-31 17:00",
            "2026-08-31 17:00",
        ]
        assert [bar.volume for bar in monthly] == [2, 1]

    def test_a_partial_trailing_bucket_is_returned_rather_than_dropped(self):
        """There is no bar count that means complete: a week is five
        sessions, not seven, and a holiday makes it four."""

        candles = [daily("2026-09-06T17:00"), daily("2026-09-07T17:00")]

        assert len(aggregate_candles(candles, "1w")) == 1


class TestTheVocabularyHangsTogether:
    """Every interval has to reach a provider and a stored series, or it is a
    button in the UI that returns an error."""

    @pytest.mark.parametrize("interval", INTERVAL_ORDER)
    def test_every_interval_resolves_to_a_stored_series(self, interval):
        assert storage_interval(interval) in SUPPORTED_INTERVALS

    @pytest.mark.parametrize("interval", INTERVAL_ORDER)
    def test_every_interval_is_reachable_from_both_real_providers(self, interval):
        store = storage_interval(interval)
        assert resolve_fetch_interval(store, set(MASSIVE_INTERVAL_MAP))
        assert resolve_fetch_interval(store, set(YAHOO_INTERVAL_MAP))

    @pytest.mark.parametrize("interval", INTERVAL_ORDER)
    def test_the_aggregation_chain_terminates_and_always_gets_finer(self, interval):
        seen: set[str] = set()
        current = interval
        while True:
            assert current not in seen, f"cycle through {current}"
            seen.add(current)
            nxt = get_interval(current).aggregate_from
            if nxt is None:
                break
            assert get_interval(nxt).milliseconds < get_interval(current).milliseconds
            current = nxt

    def test_the_order_lists_every_interval_exactly_once(self):
        assert sorted(INTERVAL_ORDER) == sorted(SUPPORTED_INTERVALS)

    def test_the_order_runs_from_finest_to_coarsest(self):
        lengths = [get_interval(key).milliseconds for key in INTERVAL_ORDER]
        assert lengths == sorted(lengths)

    def test_only_the_week_and_the_month_are_calendar_anchored(self):
        calendar = {key for key in INTERVAL_ORDER if is_calendar_anchored(key)}
        assert calendar == {"1w", "1mo"}

    def test_a_calendar_interval_never_widens_the_shared_fetch_window(self):
        """Padding a 1h request by a month so a monthly bucket is whole would
        make every view of one range a different fetch -- and against a
        five-a-minute quota that is what makes changing timeframe expensive."""

        assert edge_padding_ms("1mo") == edge_padding_ms("1h") == 24 * HOUR_MS

    def test_the_month_is_spelled_so_it_cannot_be_confused_with_the_minute(self):
        """1M and 1m differ only in case, and interval keys travel through
        query strings and a SQLite column. The wire spelling is 1mo."""

        assert "1M" not in SUPPORTED_INTERVALS
        assert normalise_resolution("1M") == "1mo"
        assert normalise_resolution("1") == "1m"

    @pytest.mark.parametrize(
        ("resolution", "expected"),
        [("1", "1m"), ("30", "30m"), ("90", "90m"), ("1W", "1w"), ("W", "1w"), ("M", "1mo")],
    )
    def test_tradingview_resolutions_still_map(self, resolution, expected):
        assert normalise_resolution(resolution) == expected

    def test_an_unknown_resolution_is_refused(self):
        with pytest.raises(UnsupportedIntervalError):
            normalise_resolution("7m")
