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
from app.utils.intervals import HOUR_MS, interval_ms

#: Hour, in exchange-local time, at which a new trading day opens.  The CME
#: equity-index session runs Sun 17:00 CT to Fri 16:00 CT, so 17:00 is both the
#: weekly open and the daily boundary every other session rolls over on.  It is
#: exported because bar bucketing has to agree with it: a 4h bar that does not
#: start on a session boundary is a bar no trader recognises.
SESSION_OPEN_HOUR = 17

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


#: Hours the CME equity-index market is open in one full week: Sunday's
#: 17:00-24:00 reopen (7), Monday to Thursday at 23 apiece with the 16:00
#: maintenance hour removed (92), and Friday's 00:00-16:00 close (16).
#: Derived from :func:`is_trading_minute`, and pinned against it by a test --
#: it is a shortcut through the scan below, never a second copy of the rule.
TRADING_HOURS_PER_WEEK = 7 + 4 * 23 + 16

_WEEK = timedelta(days=7)


def trading_hours_between(
    start_ms: int,
    end_ms: int,
    *,
    tz_name: str = EXCHANGE_TIMEZONE,
) -> float:
    """Hours of open market in ``[start_ms, end_ms)``.

    Used to size a request honestly.  Dividing wall-clock span by bar length
    counts weekends and the daily maintenance halt as tradeable, which
    overstates a 90-day window of 5-minute bars by about 45% -- enough to have
    a request refused for thousands of bars that do not exist.

    Whole weeks are counted arithmetically and only the remainder is scanned,
    so a two-year window costs the same handful of steps as a two-day one.
    """

    if end_ms <= start_ms:
        return 0.0

    tz = ZoneInfo(tz_name)
    try:
        start = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
        end = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)
    except (OSError, OverflowError, ValueError):
        # A timestamp the platform cannot represent -- pre-1970 or centuries
        # out. This function only ever sizes a request, so the proportional
        # answer is good enough and a bad date deserves the ordinary "too
        # large" refusal rather than a 500.
        span_hours = (end_ms - start_ms) / 3_600_000
        return span_hours * TRADING_HOURS_PER_WEEK / (24 * 7)

    whole_weeks, remainder = divmod(end - start, _WEEK)
    hours = float(whole_weeks * TRADING_HOURS_PER_WEEK)

    # The remainder is under a week, so this scan is bounded at 168 steps
    # however long the original window was.
    cursor = end - remainder
    step = timedelta(hours=1)
    while cursor < end:
        # An hour is credited whole when its *start* is open, so a step that
        # begins just before the daily halt counts the closed minutes with it.
        # The error is bounded by the sub-week remainder -- under an hour
        # either way -- which is far inside the headroom the bar cap is chosen
        # with, and never enough to move a preset across it.
        if is_trading_minute(cursor.astimezone(tz)):
            hours += 1.0
        cursor += step

    return hours


def empty_response_indicts_provider(
    start_ms: int,
    end_ms: int,
    interval: str,
    *,
    tz_name: str = EXCHANGE_TIMEZONE,
) -> bool:
    """Whether "no bars" over this window is evidence the provider is broken.

    :func:`has_trading_session` answers the first question -- was the market
    open at all -- and a closed window excuses an empty response.  That leaves
    a third case it cannot see: a window the market was open for, but only
    barely.

    A coverage back-fill asks for exactly those slivers.  Having fetched a
    contract's whole stretch, the service re-asks for the few edges that did
    not arrive, and one of them lands on the last open hour of an expiring
    contract -- an hour the vendor has no bar for, and never will.  Treating
    that as an outage marked a provider that had just returned thousands of
    bars unhealthy for two minutes and demoted the symbol to the fallback,
    which is how a chart ends up stuck loading over one absent bar.

    So an empty answer only indicts a provider when the window held more open
    market than a single bar could cover.  At or below that the response is
    excused, the caller leaves the range uncovered, and the chart shows an
    honest gap.  This is deliberately the smallest possible concession: one
    bar is the least an empty response can be wrong by, so a genuine outage --
    which is empty across every bar in the window -- still fails loudly.
    """

    open_hours = trading_hours_between(start_ms, end_ms, tz_name=tz_name)
    return open_hours * HOUR_MS > interval_ms(interval)
