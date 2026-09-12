"""Cache policy helpers.

Two decisions live here:

*Storage interval* -- which interval we physically persist for a requested
interval.  ``4h`` and ``6h`` are never stored; they are aggregated from ``1h``
on read.  This keeps the cache small and means changing the aggregation rules
does not invalidate stored data.

*Freshness* -- the tail of the requested window is deliberately left outside
recorded coverage so the most recent (still forming) bars are re-fetched
instead of being served stale from cache forever.
"""

from __future__ import annotations

from app.database.repository import TimeRange
from app.providers.futures_calendar import EXCHANGE_TIMEZONE
from app.providers.trading_hours import trading_hours_between
from app.utils.intervals import (
    DAY_MS,
    HOUR_MS,
    get_interval,
    interval_ms,
    is_calendar_anchored,
)
from app.utils.timeutils import now_ms

#: Requested interval -> interval actually persisted.
#:
#: ``1d`` is built from hourly bars rather than fetched as dailies. A vendor's
#: daily bar is stamped at *calendar* midnight, which for an instrument whose
#: day opens at 17:00 the previous evening cuts the session in half and puts
#: the open six hours into the bar. Aggregating from hours is what lets the
#: daily candle start where the trading day starts -- and it costs nothing,
#: because 1h, 4h and 6h already share that same stored series.
#: Weekly and monthly are built from the same hourly series as everything
#: from 1h up, which bounds how much history they can show: 20,000 stored bars
#: is about 1,200 calendar days of trading hours, and the intraday history cap
#: cuts that to 730. So a monthly chart reaches about two years, not ten.
#: Storing a daily series of its own would lift that, and would mean deciding
#: how a vendor's calendar-midnight daily bar is reconciled with a session
#: that opens at 17:00 -- the question `1d` is aggregated from hours to avoid.
STORAGE_INTERVAL: dict[str, str] = {
    "1m": "1m",
    "2m": "1m",
    "3m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "15m",
    "90m": "15m",
    "1h": "1h",
    "4h": "1h",
    "6h": "1h",
    "1d": "1h",
    "1w": "1h",
    "1mo": "1h",
}

#: Number of trailing bars that are always considered stale.
FRESH_TAIL_BARS = 2


def storage_interval(interval: str) -> str:
    get_interval(interval)  # validation
    return STORAGE_INTERVAL[interval]


def edge_padding_ms(interval: str) -> int:
    """How far either side of a window to fetch, so edge buckets are whole.

    Sized by the **longest** interval that shares this stored series, not by
    the one being viewed. That difference is the whole point: padding by the
    viewed interval makes 1h ask for a window an hour wider and 4h one four
    hours wider, so two views of the same range are two different fetches and
    the shared window never lands on the cache. One padding for the family
    means switching between 1h, 4h, 6h and 1d is answered from what is already
    stored -- which, against a quota of five calls a minute, is the difference
    between changing timeframe being free and it costing most of a minute.
    """

    store = storage_interval(interval)
    return max(
        interval_ms(candidate)
        for candidate, target in STORAGE_INTERVAL.items()
        # Calendar intervals are excluded on purpose. Padding a request by a
        # whole month so that a monthly bucket is never partial would make
        # every 1h view of the same range fetch a different window, losing the
        # shared-window property this function exists to protect -- and against
        # a five-a-minute quota that property is worth far more than a whole
        # bucket at the left edge, which every charting platform shows partial
        # anyway.
        if target == store and not is_calendar_anchored(candidate)
    )


def align_down(timestamp_ms: int, interval: str) -> int:
    step = interval_ms(interval)
    return timestamp_ms - (timestamp_ms % step)


def align_up(timestamp_ms: int, interval: str) -> int:
    step = interval_ms(interval)
    remainder = timestamp_ms % step
    return timestamp_ms if remainder == 0 else timestamp_ms + (step - remainder)


def align_range(requested: TimeRange, interval: str) -> TimeRange:
    """Expand a range outwards to whole-bucket boundaries.

    Without this, aggregating 1h bars into 6h buckets at the edge of a fetch
    window would produce a partial first bucket that later looks complete.
    """

    return TimeRange(align_down(requested.start, interval), align_up(requested.end, interval))


def fresh_horizon(interval: str) -> int:
    """Where the settled past ends and the forming tail begins.

    Everything after this is deliberately never recorded as covered, so it is
    asked for again on the next request -- which is what keeps the bar
    currently forming up to date.  Naming it makes the other half of that
    policy expressible: a gap lying entirely beyond this point is not missing
    history, it is the tail, and refetching it twice in the same breath buys
    nothing.
    """

    return now_ms() - FRESH_TAIL_BARS * interval_ms(interval)


def cacheable_end(requested_end: int, interval: str) -> int:
    """The latest timestamp we are willing to record as permanently covered."""

    return min(requested_end, fresh_horizon(interval))


def estimate_bar_count(
    range_: TimeRange, interval: str, *, tz_name: str = EXCHANGE_TIMEZONE
) -> int:
    """How many bars ``range_`` can actually hold.

    Counted against the trading calendar rather than the wall clock.  Dividing
    the span by the bar length treats weekends and the daily maintenance halt
    as tradeable, which overstates 90 days of 5-minute bars by about 45% --
    and since this number is what a request is refused on, that difference is
    the difference between "90 days is too much" and 90 days working.
    """

    if range_.length <= 0:
        return 0

    step = interval_ms(interval)
    if step >= DAY_MS:
        # A daily bar exists for each session, and sessions are what the hour
        # count is made of; dividing it by a 24-hour day would undercount.
        return int(trading_hours_between(range_.start, range_.end, tz_name=tz_name) // 23)

    open_ms = int(trading_hours_between(range_.start, range_.end, tz_name=tz_name) * HOUR_MS)
    return max(0, open_ms // step)


def merge_adjacent(ranges: list[TimeRange], interval: str, max_gap_bars: int = 4) -> list[TimeRange]:
    """Coalesce near-adjacent gaps so we issue fewer provider requests."""

    if not ranges:
        return []
    tolerance = max_gap_bars * interval_ms(interval)
    ordered = sorted(ranges, key=lambda item: item.start)
    merged = [ordered[0]]
    for current in ordered[1:]:
        last = merged[-1]
        if current.start - last.end <= tolerance:
            merged[-1] = TimeRange(last.start, max(last.end, current.end))
        else:
            merged.append(current)
    return merged
