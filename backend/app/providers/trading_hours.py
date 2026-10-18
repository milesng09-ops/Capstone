"""When the CME equity index market is actually open.

ES, NQ and YM trade on Globex from Sunday 17:00 Chicago time to Friday 16:00,
with an hour's maintenance halt at 16:00 every day.  Everything else is a
closure, and a closure is the whole point of this module: **a provider that
returns nothing for a window with no trading in it has answered correctly.**

Without that distinction an empty response is indistinguishable from a broken
one, so the fallback chain read every weekend as three providers failing in a
row, demoted them all, and stamped a chart of real prices as demo data.

The rule is deliberately conservative. It reports "closed" for the closures
that are certain -- the weekend, the daily halt, and the exchange holidays CME
has published, listed in :data:`HOLIDAY_CLOSURES` -- and "open" for everything
else, including any holiday outside that list's span. Being wrong in that
direction costs nothing new: an unexpected empty response on an unlisted
holiday is treated the way every empty response used to be. Being wrong the
other way would swallow a genuine provider failure, which is exactly what must
not happen -- so the list holds only what CME itself published, never a date
worked out from the holiday's name.
"""

from __future__ import annotations

from bisect import bisect_right
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.providers.futures_calendar import EXCHANGE_TIMEZONE
from app.utils.intervals import HOUR_MS, interval_ms
from app.utils.timeutils import now_ms

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

#: Longest the market is ever shut. An ordinary weekend is Friday 16:00 to
#: Sunday 17:00, 49 hours; a Friday holiday stretches it from the Thursday --
#: Christmas 2026 runs from Thursday 12:15 to Sunday 17:00, 76 hours and 45
#: minutes. An hour of slack covers the daylight-saving weekends. A window
#: longer than this must contain trading, which lets the scan below skip the
#: overwhelming majority of calls. Pinned against the holiday list by a test.
_LONGEST_CLOSURE = timedelta(hours=78)

#: Where CME closes the equity index futures beyond the weekly schedule --
#: holiday halts, early closes and whole-day closures -- as exchange-local
#: wall-clock times, from inclusive, until exclusive, with what each one is.
#:
#: Source: CME Group's Globex holiday schedule, read from the trading-hours
#: service behind https://www.cmegroup.com/trading-hours.html
#: (``/services/trading-hours-by-product``, products 133 ES, 146 NQ and 318 YM,
#: which carry one schedule) on 18 October 2026, and kept where it departs
#: from the weekly rule. CME finalises each holiday's hours about two weeks
#: ahead, so the later entries are its published plan rather than history.
#:
#: The service holds nothing before 19 October 2025, so earlier holidays are
#: not listed and read as ordinary days, as every holiday did before this list
#: existed. Two of its records are left out on purpose: the reopen after the
#: Globex outage of 28 November 2025 (an outage, not a holiday), and the
#: administrative "open" it records on the Saturday after a Friday holiday,
#: when no equity future trades. Keep in step with ``CME_HOLIDAY_CLOSURES`` in
#: ``frontend/src/lib/marketHours.ts``; a test reads one against the other.
HOLIDAY_CLOSURES: tuple[tuple[str, str, str], ...] = (
    ("2025-11-27 12:00", "2025-11-27 17:00", "Thanksgiving"),
    ("2025-11-28 12:15", "2025-11-28 17:00", "Day after Thanksgiving, early close"),
    ("2025-12-24 12:15", "2025-12-25 17:00", "Christmas"),
    ("2025-12-31 17:00", "2026-01-01 17:00", "New Year's Day"),
    ("2026-01-19 12:00", "2026-01-19 17:00", "Martin Luther King Jr. Day"),
    ("2026-02-16 12:00", "2026-02-16 17:00", "Presidents' Day"),
    ("2026-04-03 08:15", "2026-04-03 17:00", "Good Friday, abbreviated session"),
    ("2026-05-25 12:00", "2026-05-25 17:00", "Memorial Day"),
    ("2026-06-19 12:00", "2026-06-19 17:00", "Juneteenth"),
    ("2026-07-03 12:00", "2026-07-03 17:00", "Independence Day, observed"),
    ("2026-09-07 12:00", "2026-09-07 17:00", "Labor Day"),
    ("2026-11-26 12:00", "2026-11-26 17:00", "Thanksgiving"),
    ("2026-11-27 12:15", "2026-11-27 17:00", "Day after Thanksgiving, early close"),
    ("2026-12-24 12:15", "2026-12-25 17:00", "Christmas"),
    ("2026-12-31 17:00", "2027-01-01 17:00", "New Year's Day"),
    ("2027-01-18 12:00", "2027-01-18 17:00", "Martin Luther King Jr. Day"),
    ("2027-02-15 12:00", "2027-02-15 17:00", "Presidents' Day"),
    ("2027-03-25 17:00", "2027-03-26 17:00", "Good Friday"),
    ("2027-05-31 12:00", "2027-05-31 17:00", "Memorial Day"),
    ("2027-06-18 12:00", "2027-06-18 17:00", "Juneteenth, observed"),
    ("2027-07-05 12:00", "2027-07-05 17:00", "Independence Day, observed"),
    ("2027-09-06 12:00", "2027-09-06 17:00", "Labor Day"),
    ("2027-11-25 12:00", "2027-11-25 17:00", "Thanksgiving"),
    ("2027-11-26 12:15", "2027-11-26 17:00", "Day after Thanksgiving, early close"),
    ("2027-12-23 17:00", "2027-12-24 17:00", "Christmas, observed"),
)

_CLOSURES = tuple(
    (datetime.fromisoformat(start), datetime.fromisoformat(until))
    for start, until, _ in HOLIDAY_CLOSURES
)
_CLOSURE_STARTS = [start for start, _ in _CLOSURES]


def _in_holiday_closure(local: datetime) -> bool:
    """Whether ``local`` falls in one of CME's published holiday closures."""

    wall = local.replace(tzinfo=None)
    index = bisect_right(_CLOSURE_STARTS, wall) - 1
    return index >= 0 and wall < _CLOSURES[index][1]


def is_trading_minute(local: datetime) -> bool:
    """Whether the market is open at ``local``, an *exchange-local* time.

    CME equity-index session: Sun 17:00 CT to Fri 16:00 CT, 16:00-17:00 halt,
    less the holiday closures CME has published.
    """

    weekday = local.weekday()  # Monday = 0
    if weekday == 5:  # Saturday
        return False
    if weekday == 6:  # Sunday, only the evening reopen
        return local.hour >= 17 and not _in_holiday_closure(local)
    if weekday == 4 and local.hour >= 16:  # Friday close
        return False
    if local.hour == 16:  # daily maintenance window
        return False
    return not _in_holiday_closure(local)


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
#: A week with a holiday in it holds fewer; the shortcut does not subtract
#: them, so a long window is sized a few hours generous, never short.
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

    # The remainder is under a week, walked from one quarter-hour mark on the
    # clock to the next. Every open, close and halt falls on a quarter hour --
    # 16:00, 17:00, a 12:15 early close, Good Friday 2026's 08:15 -- so the
    # market's state cannot change inside one of those segments, and crediting
    # each whole segment by its start counts the open time exactly. Hour-long
    # steps from the window's own start did not: from 12:15 on Christmas Eve to
    # 17:30 the next day they credited 15 of the 30 minutes after the reopen,
    # and an empty answer missing two 15-minute bars passed as no outage. The
    # walk is bounded at 672 segments however long the original window was.
    cursor = end - remainder
    while cursor < end:
        segment_end = min(_next_quarter_hour(cursor), end)
        if is_trading_minute(cursor.astimezone(tz)):
            hours += (segment_end - cursor).total_seconds() / 3600
        cursor = segment_end

    return hours


def _next_quarter_hour(moment: datetime) -> datetime:
    """The first quarter-hour mark after ``moment``.

    Taken on UTC, which serves Chicago too: its offset from UTC is a whole
    number of hours in either season, so the marks are the same instants.
    """

    quarter = 15 * 60
    seconds = moment.timestamp()
    return datetime.fromtimestamp((seconds // quarter + 1) * quarter, tz=timezone.utc)


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

    Only time that has already happened is counted.  The calendar says the
    market is "open" next Tuesday too, and no vendor has a bar for it yet, so
    a window reaching into the future used to read as an outage: one request
    for tomorrow marked Massive unhealthy for two minutes, for every chart.
    """

    end_ms = min(end_ms, now_ms())
    if end_ms <= start_ms:
        return False
    open_hours = trading_hours_between(start_ms, end_ms, tz_name=tz_name)
    return open_hours * HOUR_MS > interval_ms(interval)
