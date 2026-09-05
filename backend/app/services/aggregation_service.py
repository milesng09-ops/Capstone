"""Candle aggregation.

Used whenever a provider cannot serve an interval natively (4h and 6h bars are
the common case).  Aggregation rules:

* open   -> first open in the bucket
* high   -> maximum high
* low    -> minimum low
* close  -> final close
* volume -> sum of volume

Bucketing conventions (documented in the UI under "Assumptions"):

* Intervals of an hour and under are anchored to the UTC epoch: they divide
  the session evenly from either origin, so the cheaper arithmetic is also
  the correct one.
* ``4h``, ``6h`` and ``1d`` are anchored to the **session open** -- 17:00 in
  the instrument's exchange timezone, the boundary
  :mod:`app.providers.trading_hours` already draws the trading day on.  So a
  4h bar opens at 17:00 / 21:00 / 01:00 / 05:00 / 09:00 / 13:00 Chicago
  (18:00 / 22:00 / 02:00 / ... New York), a 6h bar at 17:00 / 23:00 / 05:00 /
  11:00, and the daily bar at 17:00 the previous evening.

**Why not a fixed UTC offset.** The session boundary is a *wall-clock* time,
and 17:00 Chicago is 22:00 UTC under daylight time but 23:00 UTC under
standard time.  A constant offset therefore encodes one half of the year and
is silently an hour out for the other -- bars opening mid-session, and the
16:00 bucket starting inside the maintenance halt.  Converting into the
exchange's own zone is what makes the grid track the session across a
daylight-saving change.

**Transition days.** A session day is 23 or 25 hours long across a
daylight-saving change, so the last bucket of that day is short or an extra
partial one appears.  The grid re-anchors at each session open rather than
letting the error accumulate, which is the convention charting platforms
follow: a bar may be an odd length once a year, but no bar ever starts at a
time the session does not recognise.
"""

from __future__ import annotations

import logging
from collections import OrderedDict

from app.models.domain import Candle
from app.providers.trading_hours import SESSION_OPEN_HOUR
from app.utils.intervals import DAY_MS, get_interval
from app.utils.timeutils import session_day_start_ms

logger = logging.getLogger(__name__)


def bucket_start(timestamp_ms: int, interval: str, timezone: str = "America/Chicago") -> int:
    """First millisecond of the bucket ``timestamp_ms`` falls in.

    See the module docstring for why the long intervals count from the session
    open rather than from the epoch.
    """

    spec = get_interval(interval)
    if not spec.session_anchored:
        # Python's modulo floors towards negative infinity, so this is also
        # correct for pre-epoch timestamps.
        return timestamp_ms - (timestamp_ms % spec.milliseconds)

    opening = _session_open_cached(timestamp_ms, timezone)
    elapsed = timestamp_ms - opening
    return opening + (elapsed // spec.milliseconds) * spec.milliseconds


#: The session open last computed, as (timezone, opening, next opening).
#: Aggregation walks bars in ascending order, so consecutive bars almost
#: always share a session and the answer can be reused.
_LAST_SESSION: tuple[str, int, int] | None = None


def _session_open_cached(timestamp_ms: int, timezone: str) -> int:
    """:func:`session_day_start_ms`, memoised across one session day.

    The conversion into the exchange's zone is the expensive part of
    bucketing, and doing it per *bar* meant a two-year daily chart spent most
    of its time in :mod:`zoneinfo` -- on the event loop, since aggregation is
    called directly rather than on a worker. One conversion per session day
    is a couple of hundred instead of tens of thousands.

    The cached span is bounded by the *next* open rather than by a fixed 24
    hours, so the 23- and 25-hour days either side of a daylight-saving change
    are still answered exactly.
    """

    global _LAST_SESSION

    cached = _LAST_SESSION
    if cached is not None:
        zone, opening, next_opening = cached
        if zone == timezone and opening <= timestamp_ms < next_opening:
            return opening

    opening = session_day_start_ms(timestamp_ms, timezone, SESSION_OPEN_HOUR)
    # A day past the open lands inside the following session whatever the
    # transition did, so this finds the next boundary without assuming 24h.
    next_opening = session_day_start_ms(opening + DAY_MS, timezone, SESSION_OPEN_HOUR)
    _LAST_SESSION = (timezone, opening, next_opening)
    return opening


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
