"""When in the day a trade was taken.

A setup that only works at 09:30 New York and a setup that works all day are
different setups, and a backtest that pools them reports the average of two
things nobody trades.  The windows below are the ones with names -- the
killzones -- plus a free window for anyone who wants their own.

**Wall-clock, not a fixed offset.**  The windows are defined in the
exchange's own timezone and resolved through :mod:`zoneinfo` for each
timestamp, for the same reason :mod:`app.services.aggregation_service` does
it: 09:30 New York is 13:30 UTC in summer and 14:30 UTC in winter.  A
constant offset is right for one half of the year and an hour out for the
other, which moves the London window off London and quietly changes what the
filter selected halfway through the backtest.

A window may wrap past midnight -- Asia does -- so the containment test is
written to handle ``start > end`` rather than assuming a tidy interval.

Nothing here has a lookahead hazard: the entry time is the entry time, and
what hour it fell in was knowable the instant it happened.  This is the one
condition in the package that is free of that worry.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

#: The killzones are quoted in New York time by everyone who quotes them,
#: including the material this app is built from, so they are stored that way
#: rather than converted into the Chicago zone the candles are bucketed in.
SESSION_TIMEZONE = "America/New_York"


@dataclass(frozen=True)
class SessionWindow:
    """One named stretch of the trading day, in ``SESSION_TIMEZONE``."""

    key: str
    label: str
    #: Minutes from local midnight. ``end`` may be smaller than ``start``,
    #: which means the window runs through midnight.
    start_minute: int
    end_minute: int
    note: str

    def contains_minute(self, minute: int) -> bool:
        if self.start_minute <= self.end_minute:
            return self.start_minute <= minute < self.end_minute
        # Wraps midnight: in the window if it is after the start *or* before
        # the end, which are the two halves either side of 00:00.
        return minute >= self.start_minute or minute < self.end_minute

    @property
    def spoken(self) -> str:
        return f"{_clock(self.start_minute)}-{_clock(self.end_minute)} New York"


def _clock(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


SESSIONS: dict[str, SessionWindow] = {
    "asia": SessionWindow(
        key="asia",
        label="Asia",
        start_minute=20 * 60,
        end_minute=0,
        note="The overnight range the London session so often takes out.",
    ),
    "london": SessionWindow(
        key="london",
        label="London",
        start_minute=2 * 60,
        end_minute=5 * 60,
        note="The first of the two sessions that set a daily extreme.",
    ),
    "new_york_am": SessionWindow(
        key="new_york_am",
        label="New York AM",
        start_minute=7 * 60,
        end_minute=10 * 60,
        note="The cash open and the hours either side of it.",
    ),
    "new_york_pm": SessionWindow(
        key="new_york_pm",
        label="New York PM",
        start_minute=13 * 60 + 30,
        end_minute=16 * 60,
        note="The afternoon drive into the close.",
    ),
}


@lru_cache(maxsize=4)
def _zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def local_minute(time_ms: int, tz_name: str = SESSION_TIMEZONE) -> int:
    """Minutes past local midnight for a UTC millisecond timestamp."""

    moment = datetime.fromtimestamp(time_ms / 1000, tz=timezone.utc).astimezone(
        _zone(tz_name)
    )
    return moment.hour * 60 + moment.minute


def windows_for(keys: list[str] | None) -> list[SessionWindow]:
    """The named windows for ``keys``, silently ignoring unknown names.

    Unknown names are dropped rather than raising: the list arrives from a
    stored workspace, and a session renamed in a later version should cost
    the user that one filter, not the whole run.
    """

    if not keys:
        return []
    return [SESSIONS[key] for key in keys if key in SESSIONS]


def session_at(
    time_ms: int, windows: list[SessionWindow], *, tz_name: str = SESSION_TIMEZONE
) -> SessionWindow | None:
    """The first of ``windows`` containing ``time_ms``, or ``None``.

    With no windows this answers ``None``, which callers read as "no session
    filter was asked for" rather than "outside every session" -- the two are
    opposite verdicts and the caller has to know which it is holding.
    """

    if not windows:
        return None
    minute = local_minute(time_ms, tz_name)
    for window in windows:
        if window.contains_minute(minute):
            return window
    return None
