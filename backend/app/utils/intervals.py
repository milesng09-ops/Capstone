"""Interval helpers.

The application speaks a small, fixed vocabulary of intervals.  Everything
else in the codebase refers to intervals through the helpers in this module so
that adding a new interval is a single-file change.

**Why the monthly key is ``1mo`` and not ``1M``.**  Interval keys travel
through query strings, ``localStorage`` and a SQLite column, and more than one
of those is compared case-insensitively somewhere along the way.  ``1M`` and
``1m`` differing only in case is a bug waiting for a collation, so the month
is spelled out.  The UI is free to label it ``1M``; the wire never does.
"""

from __future__ import annotations

from dataclasses import dataclass

MINUTE_MS = 60_000
HOUR_MS = 60 * MINUTE_MS
DAY_MS = 24 * HOUR_MS
WEEK_MS = 7 * DAY_MS

#: Nominal length of a month, for range arithmetic only.  Never used to place
#: a bucket boundary -- see :data:`IntervalSpec.calendar`.
MONTH_MS = 30 * DAY_MS


@dataclass(frozen=True)
class IntervalSpec:
    """Description of one supported interval."""

    key: str
    label: str
    #: Nominal length.  Exact for everything except ``1mo``, where it is an
    #: estimate used for bar counts and range limits and nothing else.
    milliseconds: int
    #: Interval we aggregate *from* when a provider cannot serve this one
    #: natively.  ``None`` means the interval is always requested directly.
    aggregate_from: str | None
    #: Whether bucket boundaries are counted from the exchange's session open
    #: rather than from the UTC epoch.  A 4h bar has to start when the trading
    #: day starts -- 17:00 exchange-local, 18:00 New York -- and that boundary
    #: is a wall-clock time that moves against UTC twice a year, so it cannot
    #: be expressed as a constant offset.  Intervals shorter than an hour
    #: divide the session evenly from either origin, so they stay on the plain
    #: UTC grid, which is cheaper and needs no timezone.
    session_anchored: bool
    #: Equivalent TradingView resolution string.  The frontend uses
    #: Lightweight Charts and speaks the canonical keys, so this is only kept
    #: so that clients sending resolutions such as ``60`` or ``1D`` are still
    #: understood.
    tradingview_resolution: str
    #: ``"week"`` or ``"month"`` for buckets whose boundaries come from the
    #: calendar rather than from arithmetic.  A month is not a fixed number of
    #: milliseconds, and a week measured as 7 x 24h from an arbitrary origin
    #: does not start on Sunday -- both need the exchange calendar, so both
    #: take a different path through :func:`app.services.aggregation_service.
    #: bucket_start`.  ``None`` for every fixed-length interval.
    calendar: str | None = None


SUPPORTED_INTERVALS: dict[str, IntervalSpec] = {
    "1m": IntervalSpec("1m", "1 minute", MINUTE_MS, None, False, "1"),
    "2m": IntervalSpec("2m", "2 minutes", 2 * MINUTE_MS, "1m", False, "2"),
    "3m": IntervalSpec("3m", "3 minutes", 3 * MINUTE_MS, "1m", False, "3"),
    "5m": IntervalSpec("5m", "5 minutes", 5 * MINUTE_MS, None, False, "5"),
    "15m": IntervalSpec("15m", "15 minutes", 15 * MINUTE_MS, "5m", False, "15"),
    "30m": IntervalSpec("30m", "30 minutes", 30 * MINUTE_MS, "15m", False, "30"),
    "1h": IntervalSpec("1h", "1 hour", HOUR_MS, "5m", False, "60"),
    # 90 minutes does not divide the 23-hour session, so it is anchored to the
    # session open the way 4h is: a bar may be short once a day, but no bar
    # starts at a time the session does not recognise.
    "90m": IntervalSpec("90m", "90 minutes", 90 * MINUTE_MS, "30m", True, "90"),
    "4h": IntervalSpec("4h", "4 hours", 4 * HOUR_MS, "1h", True, "240"),
    "6h": IntervalSpec("6h", "6 hours", 6 * HOUR_MS, "1h", True, "360"),
    "1d": IntervalSpec("1d", "1 day", DAY_MS, "1h", True, "1D"),
    "1w": IntervalSpec("1w", "1 week", WEEK_MS, "1d", True, "1W", calendar="week"),
    "1mo": IntervalSpec("1mo", "1 month", MONTH_MS, "1d", True, "1M", calendar="month"),
}

INTERVAL_ORDER: list[str] = [
    "1m",
    "2m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "90m",
    "4h",
    "6h",
    "1d",
    "1w",
    "1mo",
]

#: Alternative resolution spellings a client may send, mapped onto our
#: canonical interval keys.
TRADINGVIEW_RESOLUTION_MAP: dict[str, str] = {
    "1": "1m",
    "2": "2m",
    "3": "3m",
    "5": "5m",
    "15": "15m",
    "30": "30m",
    "60": "1h",
    "90": "90m",
    "240": "4h",
    "360": "6h",
    "1D": "1d",
    "D": "1d",
    "1d": "1d",
    "1W": "1w",
    "W": "1w",
    "1M": "1mo",
    "M": "1mo",
}


class UnsupportedIntervalError(ValueError):
    """Raised when an interval outside :data:`SUPPORTED_INTERVALS` is used."""


def get_interval(interval: str) -> IntervalSpec:
    spec = SUPPORTED_INTERVALS.get(interval)
    if spec is None:
        raise UnsupportedIntervalError(
            f"Unsupported interval '{interval}'. Supported: {', '.join(INTERVAL_ORDER)}"
        )
    return spec


def interval_ms(interval: str) -> int:
    """Nominal length of one bar.

    Exact for every interval but ``1mo``.  Callers doing bucket arithmetic
    must check :func:`is_calendar_anchored` first; callers estimating a bar
    count or a window size can use this directly.
    """

    return get_interval(interval).milliseconds


def is_session_anchored(interval: str) -> bool:
    return get_interval(interval).session_anchored


def is_calendar_anchored(interval: str) -> bool:
    """Whether bucket boundaries come from the calendar, not from arithmetic."""

    return get_interval(interval).calendar is not None


def normalise_resolution(resolution: str) -> str:
    """Translate a TradingView resolution into a canonical interval key."""

    if resolution in SUPPORTED_INTERVALS:
        return resolution
    mapped = TRADINGVIEW_RESOLUTION_MAP.get(resolution)
    if mapped is None:
        raise UnsupportedIntervalError(f"Unsupported resolution '{resolution}'")
    return mapped


def is_intraday(interval: str) -> bool:
    return get_interval(interval).milliseconds < DAY_MS


def base_interval_for(interval: str) -> str:
    """Return the interval that should be *fetched* to build ``interval``.

    Providers advertise which intervals they serve natively; this only gives
    the preferred aggregation source when they do not.
    """

    spec = get_interval(interval)
    return spec.aggregate_from or spec.key


def resolve_fetch_interval(interval: str, native_intervals: set[str]) -> str:
    """Pick the interval to request from a provider.

    Walks down the aggregation chain until it finds something the provider
    supports natively.  Raises when nothing in the chain is available.
    """

    seen: set[str] = set()
    current = interval
    while current not in native_intervals:
        if current in seen:  # pragma: no cover - defensive, chain is acyclic
            break
        seen.add(current)
        nxt = SUPPORTED_INTERVALS[current].aggregate_from
        if nxt is None:
            break
        current = nxt
    if current not in native_intervals:
        raise UnsupportedIntervalError(
            f"Provider cannot serve '{interval}' natively or by aggregation"
        )
    return current
