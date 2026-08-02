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
from app.utils.intervals import get_interval, interval_ms
from app.utils.timeutils import now_ms

#: Requested interval -> interval actually persisted.
STORAGE_INTERVAL: dict[str, str] = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "1h",
    "6h": "1h",
    "1d": "1d",
}

#: Number of trailing bars that are always considered stale.
FRESH_TAIL_BARS = 2


def storage_interval(interval: str) -> str:
    get_interval(interval)  # validation
    return STORAGE_INTERVAL[interval]


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


def cacheable_end(requested_end: int, interval: str) -> int:
    """The latest timestamp we are willing to record as permanently covered."""

    horizon = now_ms() - FRESH_TAIL_BARS * interval_ms(interval)
    return min(requested_end, horizon)


def estimate_bar_count(range_: TimeRange, interval: str) -> int:
    return max(0, range_.length // interval_ms(interval))


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
