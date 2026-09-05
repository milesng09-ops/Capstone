"""When the CME equity index market is actually open.

ES, NQ and YM trade on Globex from Sunday 17:00 Chicago time to Friday 16:00,
with an hour's maintenance halt at 16:00 every day.  Everything else is a
closure, and a closure is the whole point of this module: **a provider that
returns nothing for a window with no trading in it has answered correctly.**

Without that distinction an empty response is indistinguishable from a broken
one, so the fallback chain read every weekend as three providers failing in a
row, demoted them all, and stamped a chart of real prices as demo data.

The rule is deliberately conservative. It reports "closed" only for the two
closures that are certain -- the weekend and the daily halt -- and "open" for
everything else, exchange holidays included. Being wrong in that direction
costs nothing new: an unexpected empty response on a holiday is treated the
way every empty response used to be. Being wrong the other way would swallow a
genuine provider failure, which is exactly what must not happen.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.providers.futures_calendar import EXCHANGE_TIMEZONE

#: Granularity of the session scan. The shortest stretch the market is *open*
#: for is the 23 hours between the daily halt and the next one, so quarter-hour
#: steps cannot step over a session.
_SCAN_STEP = timedelta(minutes=15)

#: Longest the market is ever shut: Friday 16:00 to Sunday 17:00, plus an hour
#: of slack for the daylight-saving weekends when that stretch is 50 hours
#: rather than 49. A window longer than this must contain trading, which lets
#: the scan below skip the overwhelming majority of calls.
_LONGEST_CLOSURE = timedelta(hours=51)


def is_trading_minute(local: datetime) -> bool:
    """Whether the market is open at ``local``, an *exchange-local* time.

    CME equity-index session: Sun 17:00 CT to Fri 16:00 CT, 16:00-17:00 halt.
    """

    weekday = local.weekday()  # Monday = 0
    if weekday == 5:  # Saturday
        return False
    if weekday == 6:  # Sunday, only the evening reopen
        return local.hour >= 17
    if weekday == 4 and local.hour >= 16:  # Friday close
        return False
    if local.hour == 16:  # daily maintenance window
        return False
    return True


def has_trading_session(
    start_ms: int,
    end_ms: int,
    *,
    tz_name: str = EXCHANGE_TIMEZONE,
) -> bool:
    """Whether ``[start_ms, end_ms)`` contains any time the market was open.

    ``False`` means a provider returning no bars for that window is right, not
    broken. An empty or reversed window contains no trading by definition.
    """

    if end_ms <= start_ms:
        return False

    span = timedelta(milliseconds=end_ms - start_ms)
    if span > _LONGEST_CLOSURE:
        return True

    tz = ZoneInfo(tz_name)
    start = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
    end = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)

    cursor = start
    while cursor < end:
        if is_trading_minute(cursor.astimezone(tz)):
            return True
        cursor += _SCAN_STEP

    # The scan lands on `end` only by luck, and the last sliver of a window
    # shorter than one step would otherwise never be looked at.
    last = end - timedelta(milliseconds=1)
    return is_trading_minute(last.astimezone(tz))
