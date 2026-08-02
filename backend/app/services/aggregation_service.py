"""Candle aggregation.

Used whenever a provider cannot serve an interval natively (4h and 6h bars are
the common case).  Aggregation rules:

* open   -> first open in the bucket
* high   -> maximum high
* low    -> minimum low
* close  -> final close
* volume -> sum of volume

Bucketing conventions (documented in the UI under "Assumptions"):

* Intraday buckets are anchored to the UTC epoch, so a 6h bar starts at
  00:00 / 06:00 / 12:00 / 18:00 UTC.
* Daily buckets are anchored to local midnight in the instrument's exchange
  timezone (``America/Chicago`` for CME index futures).
"""

from __future__ import annotations

import logging
from collections import OrderedDict

from app.models.domain import Candle
from app.utils.intervals import DAY_MS, get_interval
from app.utils.timeutils import local_day_start_ms

logger = logging.getLogger(__name__)


def bucket_start(timestamp_ms: int, interval: str, timezone: str = "America/Chicago") -> int:
    spec = get_interval(interval)
    if spec.milliseconds >= DAY_MS:
        return local_day_start_ms(timestamp_ms, timezone)
    return timestamp_ms - (timestamp_ms % spec.milliseconds)


def aggregate_candles(
    candles: list[Candle],
    target_interval: str,
    *,
    timezone: str = "America/Chicago",
    drop_incomplete: bool = False,
    source_interval: str | None = None,
) -> list[Candle]:
    """Combine ``candles`` into ``target_interval`` buckets.

    ``candles`` must already be normalised (ascending, de-duplicated).
    """

    if not candles:
        return []

    buckets: "OrderedDict[int, Candle]" = OrderedDict()
    counts: dict[int, int] = {}

    for candle in candles:
        key = bucket_start(candle.time, target_interval, timezone)
        current = buckets.get(key)
        if current is None:
            buckets[key] = Candle(
                symbol=candle.symbol,
                time=key,
                open=candle.open,
                high=candle.high,
                low=candle.low,
                close=candle.close,
                volume=candle.volume,
            )
            counts[key] = 1
            continue
        current.high = max(current.high, candle.high)
        current.low = min(current.low, candle.low)
        current.close = candle.close
        current.volume += candle.volume
        counts[key] += 1

    aggregated = [buckets[key] for key in sorted(buckets)]

    if drop_incomplete and source_interval and aggregated:
        expected = max(
            1,
            get_interval(target_interval).milliseconds
            // get_interval(source_interval).milliseconds,
        )
        last_key = aggregated[-1].time
        if counts.get(last_key, 0) < expected:
            aggregated.pop()

    return aggregated


def needs_aggregation(requested: str, native: str) -> bool:
    return requested != native
