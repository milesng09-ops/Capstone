"""Interval helpers.

The application speaks a small, fixed vocabulary of intervals.  Everything
else in the codebase refers to intervals through the helpers in this module so
that adding a new interval is a single-file change.
"""

from __future__ import annotations

from dataclasses import dataclass

MINUTE_MS = 60_000
HOUR_MS = 60 * MINUTE_MS
DAY_MS = 24 * HOUR_MS


@dataclass(frozen=True)
class IntervalSpec:
    """Description of one supported interval."""

    key: str
    label: str
    milliseconds: int
    #: Interval we aggregate *from* when a provider cannot serve this one
    #: natively.  ``None`` means the interval is always requested directly.
    aggregate_from: str | None
    #: Equivalent TradingView resolution string.  The frontend uses
    #: Lightweight Charts and speaks the canonical keys, so this is only kept
    #: so that clients sending resolutions such as ``60`` or ``1D`` are still
    #: understood.
    tradingview_resolution: str


SUPPORTED_INTERVALS: dict[str, IntervalSpec] = {
    "5m": IntervalSpec("5m", "5 minutes", 5 * MINUTE_MS, None, "5"),
    "15m": IntervalSpec("15m", "15 minutes", 15 * MINUTE_MS, "5m", "15"),
    "1h": IntervalSpec("1h", "1 hour", HOUR_MS, "5m", "60"),
    "4h": IntervalSpec("4h", "4 hours", 4 * HOUR_MS, "1h", "240"),
    "6h": IntervalSpec("6h", "6 hours", 6 * HOUR_MS, "1h", "360"),
    "1d": IntervalSpec("1d", "1 day", DAY_MS, "1h", "1D"),
}

INTERVAL_ORDER: list[str] = ["5m", "15m", "1h", "4h", "6h", "1d"]

#: Alternative resolution spellings a client may send, mapped onto our
#: canonical interval keys.
TRADINGVIEW_RESOLUTION_MAP: dict[str, str] = {
    "5": "5m",
    "15": "15m",
    "60": "1h",
    "240": "4h",
    "360": "6h",
    "1D": "1d",
    "D": "1d",
    "1d": "1d",
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
    return get_interval(interval).milliseconds


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
