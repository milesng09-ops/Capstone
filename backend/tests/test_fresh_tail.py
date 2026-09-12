"""Asking for the forming tail once per view, not once per request.

The tail of a window is deliberately never recorded as covered -- that is the
freshness policy, and it is what keeps the bar currently forming up to date.
The cost is that every request asks the provider for it again, and one view of
one market is several requests: the candles, and the detections, which fetch
the correlated market too so there is something to read SMT against.

Measured on 2026-09-12: a two-chart workspace asked for **six series** on a
single change of timeframe and poked the provider six times for the same
handful of forming bars.  Against a quota of five calls a minute that is more
than a minute's budget for one click, and a 4h request took **150.8 seconds**
end to end because of it.

The one thing these cases have to protect is the distinction the fix rests on:
a gap that is nothing but the tail may be reused, and a gap holding any
missing *history* may never be.
"""

from __future__ import annotations

import time

import pytest

from app.config import get_settings
from app.database.repository import TimeRange
from app.services.cache_service import FRESH_TAIL_BARS, cacheable_end, fresh_horizon
from app.services.candle_service import CandleService
from app.utils.intervals import interval_ms
from app.utils.timeutils import now_ms

HOUR = 3_600_000
SERIES = ("NQ", "1h")


@pytest.fixture()
def service() -> CandleService:
    # No provider call is made: every case here stops at the gap arithmetic.
    return CandleService(provider=object())  # type: ignore[arg-type]


def tail_gap() -> TimeRange:
    """A gap lying entirely inside the forming tail, as a real one does."""

    return TimeRange(fresh_horizon("1h") + 1, now_ms() + 24 * HOUR)


def history_gap() -> TimeRange:
    return TimeRange(now_ms() - 30 * 24 * HOUR, now_ms() - 20 * 24 * HOUR)


class TestWhereTheTailBegins:
    def test_the_horizon_is_the_ceiling_on_recorded_coverage(self):
        """The two are the same line seen from either side: nothing past the
        horizon is ever recorded as covered, which is why it comes back as a
        gap on the next request."""

        end = now_ms() + 24 * HOUR
        assert cacheable_end(end, "1h") == fresh_horizon("1h")

    def test_it_sits_a_couple_of_bars_back(self):
        gap = now_ms() - fresh_horizon("1h")
        assert gap == pytest.approx(FRESH_TAIL_BARS * interval_ms("1h"), abs=1_000)

    def test_it_moves_with_the_interval(self):
        assert fresh_horizon("1d") < fresh_horizon("1h") < fresh_horizon("5m")


class TestReusingATailJustFetched:
    def test_nothing_is_reused_before_anything_is_fetched(self, service):
        gaps = [tail_gap()]

        assert service._settled_gaps_only(*SERIES, gaps) == gaps

    def test_a_tail_only_gap_is_dropped_once_it_has_been_fetched(self, service):
        service._tail_fetched[SERIES] = (time.monotonic(), fresh_horizon("1h"))

        assert service._settled_gaps_only(*SERIES, [tail_gap()]) == []

    def test_it_is_asked_for_again_once_the_window_has_passed(self, service):
        service._tail_fetched[SERIES] = (
            time.monotonic() - get_settings().fresh_tail_min_seconds - 1,
            fresh_horizon("1h"),
        )

        gaps = [tail_gap()]
        assert service._settled_gaps_only(*SERIES, gaps) == gaps

    def test_each_series_is_tracked_on_its_own(self, service):
        # ES being fresh says nothing about NQ, and never should: they are
        # different data from different requests.
        service._tail_fetched[("ES", "1h")] = (time.monotonic(), fresh_horizon("1h"))

        gaps = [tail_gap()]
        assert service._settled_gaps_only("NQ", "1h", gaps) == gaps

    def test_an_interval_stored_separately_is_tracked_separately(self, service):
        service._tail_fetched[("NQ", "1h")] = (time.monotonic(), fresh_horizon("1h"))

        gaps = [TimeRange(fresh_horizon("5m") + 1, now_ms() + 24 * HOUR)]
        assert service._settled_gaps_only("NQ", "5m", gaps) == gaps


class TestTheHorizonMovesWhileYouWatch:
    """The subtlety the first attempt at this fix got wrong.

    The horizon is ``now`` minus a couple of bars, so it walks forward with
    the wall clock. Coverage stops at the horizon in force when it was
    written, which means the next gap begins exactly there -- and by the time
    the next request looks, the *present* horizon has moved past that start,
    so the gap reads as missing history and is fetched again. Six requests,
    six fetches, which is precisely what the memo was added to stop.

    Measured against the horizon the tail was actually fetched at, it is what
    it is. These two cases fail against a present-tense horizon.
    """

    def test_a_gap_starting_where_the_last_fetch_stopped_is_still_the_tail(self, service):
        fetched_at = fresh_horizon("1h") - 30_000  # half a minute ago
        service._tail_fetched[SERIES] = (time.monotonic(), fetched_at)

        # Coverage ended at the old horizon, so this is where the gap begins.
        gaps = [TimeRange(fetched_at, now_ms() + 24 * HOUR)]
        assert service._settled_gaps_only(*SERIES, gaps) == []

    def test_history_older_than_that_fetch_is_still_history(self, service):
        fetched_at = fresh_horizon("1h") - 30_000
        service._tail_fetched[SERIES] = (time.monotonic(), fetched_at)

        gaps = [TimeRange(fetched_at - HOUR, now_ms() + 24 * HOUR)]
        assert service._settled_gaps_only(*SERIES, gaps) == gaps


class TestMissingHistoryIsNeverSkipped:
    """The whole fix rests on this line. Dropping real history because a tail
    was fetched recently would leave a hole in the chart that nothing ever
    goes back for -- the failure the coverage rules exist to prevent."""

    def test_a_historical_gap_survives_a_fresh_tail(self, service):
        service._tail_fetched[SERIES] = (time.monotonic(), fresh_horizon("1h"))

        gaps = [history_gap()]
        assert service._settled_gaps_only(*SERIES, gaps) == gaps

    def test_history_is_kept_and_only_the_tail_is_dropped(self, service):
        service._tail_fetched[SERIES] = (time.monotonic(), fresh_horizon("1h"))

        history = history_gap()
        assert service._settled_gaps_only(*SERIES, [history, tail_gap()]) == [history]

    def test_a_gap_that_reaches_back_before_the_horizon_is_fetched_whole(self, service):
        """However far forward it also runs. A gap starting an hour before the
        horizon holds a settled bar nobody has, so it is missing history."""

        service._tail_fetched[SERIES] = (time.monotonic(), fresh_horizon("1h"))

        gaps = [TimeRange(fresh_horizon("1h") - HOUR, now_ms() + 24 * HOUR)]
        assert service._settled_gaps_only(*SERIES, gaps) == gaps

    def test_an_empty_list_stays_empty(self, service):
        service._tail_fetched[SERIES] = (time.monotonic(), fresh_horizon("1h"))

        assert service._settled_gaps_only(*SERIES, []) == []
