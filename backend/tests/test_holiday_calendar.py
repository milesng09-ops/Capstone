"""CME's exchange holidays in the session calendar.

Until these were listed, a holiday read as an ordinary trading day: an empty
answer for Thanksgiving afternoon counted against the provider that gave it,
a holiday falling between two cached spans was asked for again on every
request, and the live chart polled Massive every minute for bars that were
never coming. The list is CME's own published schedule, so these check the
calendar against it at the boundaries, and that nothing outside it changed.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from app.providers import trading_hours
from app.providers.trading_hours import (
    HOLIDAY_CLOSURES,
    TRADING_HOURS_PER_WEEK,
    empty_response_indicts_provider,
    has_trading_session,
    is_trading_minute,
    trading_hours_between,
)

CHICAGO = ZoneInfo("America/Chicago")


def local(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=CHICAGO)


def ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


class TestTheHolidaysCmePublished:
    def test_thanksgiving_halts_at_noon_and_reopens_at_five(self):
        assert is_trading_minute(local(2026, 11, 26, 11, 59)) is True
        assert is_trading_minute(local(2026, 11, 26, 12, 0)) is False
        assert is_trading_minute(local(2026, 11, 26, 16, 59)) is False
        assert is_trading_minute(local(2026, 11, 26, 17, 0)) is True

    def test_the_day_after_closes_at_a_quarter_past_noon(self):
        assert is_trading_minute(local(2026, 11, 27, 12, 14)) is True
        assert is_trading_minute(local(2026, 11, 27, 12, 15)) is False

    def test_christmas_runs_from_the_early_close_to_the_next_evening(self):
        # Wednesday 24 December 2025, 12:15, to Thursday 25 December, 17:00.
        assert is_trading_minute(local(2025, 12, 24, 12, 14)) is True
        assert is_trading_minute(local(2025, 12, 24, 12, 15)) is False
        assert is_trading_minute(local(2025, 12, 24, 20, 0)) is False
        assert is_trading_minute(local(2025, 12, 25, 10, 0)) is False
        assert is_trading_minute(local(2025, 12, 25, 17, 0)) is True

    def test_good_friday_2026_is_an_abbreviated_session_not_a_closure(self):
        # A name-based rule would have shut it all day; CME traded until 08:15.
        assert is_trading_minute(local(2026, 4, 3, 8, 14)) is True
        assert is_trading_minute(local(2026, 4, 3, 8, 15)) is False

    def test_a_sunday_reopen_inside_a_closure_stays_shut(self):
        # Juneteenth 2027 falls on a Saturday and is observed on the Friday;
        # the weekend that follows reopens as usual on Sunday at 17:00.
        assert is_trading_minute(local(2027, 6, 18, 12, 0)) is False
        assert is_trading_minute(local(2027, 6, 20, 17, 0)) is True


class TestWhatTheHolidaysChange:
    def test_a_holiday_closure_holds_no_session(self):
        # Asked for on every request while it read as a hole in the history.
        start, end = ms(local(2025, 12, 24, 12, 15)), ms(local(2025, 12, 25, 17, 0))
        assert has_trading_session(start, end) is False

    def test_an_empty_answer_for_a_holiday_afternoon_is_not_an_outage(self):
        start, end = ms(local(2025, 11, 27, 12, 0)), ms(local(2025, 11, 27, 17, 0))
        assert empty_response_indicts_provider(start, end, "1h") is False

    def test_an_empty_answer_while_the_market_was_open_still_is(self):
        start, end = ms(local(2025, 11, 27, 6, 0)), ms(local(2025, 11, 27, 12, 0))
        assert empty_response_indicts_provider(start, end, "1h") is True

    def test_a_holiday_week_holds_fewer_hours(self):
        # Memorial Day 2026: the four hours from the noon halt are gone.
        week = local(2026, 5, 24, 0)
        hours = sum(
            1 for step in range(24 * 7) if is_trading_minute(week + timedelta(hours=step))
        )
        assert hours == TRADING_HOURS_PER_WEEK - 4
        # A Monday holds 23 open hours; the holiday leaves 19.
        assert trading_hours_between(ms(local(2026, 5, 25, 0)), ms(local(2026, 5, 26, 0))) == 19

    def test_a_holiday_outside_the_published_span_reads_as_an_ordinary_day(self):
        # Before 19 October 2025 CME's service holds nothing, and a holiday
        # read as open is the safe mistake: it never excuses a real outage.
        assert is_trading_minute(local(2025, 7, 4, 10, 0)) is True


class TestTheListItself:
    def test_it_is_in_order_and_nothing_overlaps(self):
        # The lookup is a bisection, which needs both.
        windows = [
            (datetime.fromisoformat(start), datetime.fromisoformat(until))
            for start, until, _ in HOLIDAY_CLOSURES
        ]
        for (start, until), (next_start, _) in zip(windows, windows[1:]):
            assert start < until <= next_start

    def test_no_closure_outlasts_the_longest_the_scan_skips(self):
        """A window longer than `_LONGEST_CLOSURE` is assumed to hold trading,
        so every real closure, holiday weekends included, must be shorter."""

        cursor = datetime(2025, 10, 19, tzinfo=CHICAGO)
        end = datetime(2028, 1, 3, tzinfo=CHICAGO)
        longest = timedelta(0)
        shut_since: datetime | None = None
        while cursor < end:
            if is_trading_minute(cursor):
                if shut_since is not None:
                    longest = max(longest, cursor - shut_since)
                shut_since = None
            elif shut_since is None:
                shut_since = cursor
            cursor += timedelta(minutes=15)

        assert longest >= timedelta(hours=76, minutes=45)  # Christmas 2026
        assert longest < trading_hours._LONGEST_CLOSURE

    def test_the_frontend_lists_the_same_closures(self):
        """The live chart decides when to poll from its own copy."""

        source = (
            Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "marketHours.ts"
        ).read_text(encoding="utf-8")
        listed = re.findall(
            r"\['(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', '(\d{4}-\d{2}-\d{2} \d{2}:\d{2})'",
            source,
        )
        assert listed == [(start, until) for start, until, _ in HOLIDAY_CLOSURES]
