"""Candle normalisation.

Every provider funnels its raw payload through :func:`normalize_candles` so the
rest of the system can assume a single, clean contract:

* ascending chronological order
* no duplicate timestamps
* finite, positive prices
* ``high`` >= max(open, close, low) and ``low`` <= min(open, close, high)
* non-negative volume, defaulting to ``0``
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from app.models.domain import Candle

logger = logging.getLogger(__name__)


@dataclass
class NormalizationReport:
    """Diagnostics about what normalisation had to fix."""

    received: int = 0
    kept: int = 0
    dropped_malformed: int = 0
    dropped_duplicate: int = 0
    reordered: bool = False
    repaired_bounds: int = 0
    missing_volume: int = 0
    notes: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"received={self.received} kept={self.kept} "
            f"malformed={self.dropped_malformed} duplicates={self.dropped_duplicate} "
            f"repaired={self.repaired_bounds}"
        )


RawCandle = Mapping[str, Any] | Sequence[Any]


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _extract(raw: RawCandle) -> tuple[Any, Any, Any, Any, Any, Any] | None:
    """Pull (time, open, high, low, close, volume) out of a raw record."""

    if isinstance(raw, Mapping):
        time_value = (
            raw.get("time")
            if "time" in raw
            else raw.get("timestamp", raw.get("t", raw.get("date")))
        )
        return (
            time_value,
            raw.get("open", raw.get("o")),
            raw.get("high", raw.get("h")),
            raw.get("low", raw.get("l")),
            raw.get("close", raw.get("c")),
            raw.get("volume", raw.get("v")),
        )
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)):
        items = list(raw)
        if len(items) < 5:
            return None
        if len(items) == 5:
            items.append(0.0)
        return (items[0], items[1], items[2], items[3], items[4], items[5])
    return None


def _normalise_timestamp(value: Any) -> int | None:
    number = _coerce_float(value)
    if number is None:
        return None
    # Seconds arrive from some vendors; anything below 1e11 cannot be ms.
    if abs(number) < 1e11:
        number *= 1000
    return int(round(number))


def normalize_candles(
    symbol: str,
    raw_candles: Iterable[RawCandle],
    *,
    report: NormalizationReport | None = None,
) -> list[Candle]:
    """Convert arbitrary provider payloads into clean :class:`Candle` objects."""

    report = report or NormalizationReport()
    by_time: dict[int, Candle] = {}
    previous_time: int | None = None

    for raw in raw_candles:
        report.received += 1
        extracted = _extract(raw)
        if extracted is None:
            report.dropped_malformed += 1
            continue

        raw_time, raw_open, raw_high, raw_low, raw_close, raw_volume = extracted
        timestamp = _normalise_timestamp(raw_time)
        open_ = _coerce_float(raw_open)
        high = _coerce_float(raw_high)
        low = _coerce_float(raw_low)
        close = _coerce_float(raw_close)
        volume = _coerce_float(raw_volume)

        if timestamp is None or None in (open_, high, low, close):
            report.dropped_malformed += 1
            continue
        assert open_ is not None and high is not None and low is not None and close is not None

        if min(open_, high, low, close) <= 0:
            report.dropped_malformed += 1
            continue

        if volume is None:
            report.missing_volume += 1
            volume = 0.0
        volume = max(volume, 0.0)

        # Repair inconsistent extremes rather than discarding the bar: vendors
        # occasionally round high/low inside the open/close range.
        corrected_high = max(high, open_, close, low)
        corrected_low = min(low, open_, close, high)
        if corrected_high != high or corrected_low != low:
            report.repaired_bounds += 1
        high, low = corrected_high, corrected_low

        if previous_time is not None and timestamp < previous_time:
            report.reordered = True
        previous_time = timestamp

        if timestamp in by_time:
            report.dropped_duplicate += 1
        by_time[timestamp] = Candle(
            symbol=symbol,
            time=timestamp,
            open=open_,
            high=high,
            low=low,
            close=close,
            volume=volume,
        )

    candles = [by_time[key] for key in sorted(by_time)]
    report.kept = len(candles)
    if report.dropped_malformed or report.dropped_duplicate:
        logger.debug("Normalised %s: %s", symbol, report.summary())
    return candles


def clip_to_range(candles: list[Candle], start_ms: int, end_ms: int) -> list[Candle]:
    return [candle for candle in candles if start_ms <= candle.time <= end_ms]


def merge_candles(existing: list[Candle], incoming: list[Candle]) -> list[Candle]:
    """Merge two ascending candle lists, letting ``incoming`` win on conflict."""

    merged: dict[int, Candle] = {candle.time: candle for candle in existing}
    for candle in incoming:
        merged[candle.time] = candle
    return [merged[key] for key in sorted(merged)]
