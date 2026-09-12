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
* ``90m``, ``4h``, ``6h`` and ``1d`` are anchored to the **session open** -- 17:00 in
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

* ``1w`` and ``1mo`` are anchored to the **calendar**, because neither has
  a fixed length.  A week starts at the Sunday session open; a month starts
  at the session open of its first trading day, which is the evening of the
  last day of the month before -- the same convention the daily bar already
  uses, where a bar stamped Sunday evening is Monday's trading.

A month whose first day is a Saturday or Sunday anchors on an instant the
market is shut -- November 2026 opens at 17:00 on Saturday 31 October.  That
is a label, not a mis-bucketing: no bar exists between that instant and the
Sunday reopen, so nothing can land in the wrong month because of it.

**No partial bucket is ever dropped.**  The trailing bucket of a series is
returned as it stands, and the caller decides whether a forming bar is
wanted.  Counting bars to decide would need the number a *complete* bucket
holds, and there is no such number here: a daily bar is 23 hours, not 24, a
weekly one is five sessions, not seven, and a holiday shortens both.

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
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

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
    if spec.calendar is not None:
        return _calendar_bucket_start(timestamp_ms, spec.calendar, timezone)

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


#: The calendar bucket last computed, as (kind, timezone, start, next start).
#: Bars arrive in ascending order and a week holds five sessions, a month
#: twenty-odd, so consecutive bars nearly always answer from here.
_LAST_CALENDAR: tuple[str, str, int, int] | None = None


def _calendar_bucket_start(timestamp_ms: int, kind: str, timezone: str) -> int:
    """First millisecond of the week or month ``timestamp_ms`` trades in.

    Both are resolved through the *session* the instant belongs to rather than
    through the calendar directly, so that Sunday evening -- which is already
    Monday's trading -- lands in the week and the month Monday belongs to,
    exactly as it does for the daily bar.
    """

    global _LAST_CALENDAR

    cached = _LAST_CALENDAR
    if cached is not None:
        c_kind, c_zone, start, nxt = cached
        if c_kind == kind and c_zone == timezone and start <= timestamp_ms < nxt:
            return start

    opening = _session_open_cached(timestamp_ms, timezone)
    tz = ZoneInfo(timezone)
    local_open = datetime.fromtimestamp(opening / 1000, tz=tz)

    anchor = _anchor_date(local_open, kind)
    start = _session_open_on(anchor, tz)
    nxt = _session_open_on(_next_anchor_date(anchor, kind), tz)
    _LAST_CALENDAR = (kind, timezone, start, nxt)
    return start


def _anchor_date(local_open: datetime, kind: str) -> date:
    """Exchange-local date whose session open begins this week or month."""

    if kind == "week":
        # Monday is 0 and Sunday is 6, so this counts days back to Sunday --
        # the evening the trading week reopens.
        return local_open.date() - timedelta(days=(local_open.weekday() + 1) % 7)

    # The evening open belongs to the next day's trading, so a session sits in
    # the month of the day it *ends* on. The month therefore begins on the
    # evening before its first day.
    trade_date = local_open.date() + timedelta(days=1)
    return date(trade_date.year, trade_date.month, 1) - timedelta(days=1)


def _next_anchor_date(anchor: date, kind: str) -> date:
    if kind == "week":
        return anchor + timedelta(days=7)
    # `anchor` is the evening before the first of the month, so the day after
    # it is the first; stepping a month on from there and back one evening
    # gives the next month's anchor without any day-count arithmetic.
    first = anchor + timedelta(days=1)
    year, month = (first.year + 1, 1) if first.month == 12 else (first.year, first.month + 1)
    return date(year, month, 1) - timedelta(days=1)


def _session_open_on(local_date: date, tz: ZoneInfo) -> int:
    """UTC milliseconds of the session open on an exchange-local date.

    Resolved on the date itself rather than by adding a number of hours, so a
    week or month spanning a daylight-saving change still opens at 17:00 local
    on both sides of it.
    """

    opening = datetime.combine(local_date, time(hour=SESSION_OPEN_HOUR), tzinfo=tz)
    return int(opening.timestamp() * 1000)


def aggregate_candles(
    candles: list[Candle],
    target_interval: str,
    *,
    timezone: str = "America/Chicago",
) -> list[Candle]:
    """Combine ``candles`` into ``target_interval`` buckets.

    ``candles`` must already be normalised (ascending, de-duplicated).
    """

    if not candles:
        return []

    buckets: "OrderedDict[int, Candle]" = OrderedDict()

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
            continue
        current.high = max(current.high, candle.high)
        current.low = min(current.low, candle.low)
        current.close = candle.close
        current.volume += candle.volume

    return [buckets[key] for key in sorted(buckets)]


def needs_aggregation(requested: str, native: str) -> bool:
    return requested != native
