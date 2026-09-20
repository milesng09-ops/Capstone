"""Which way the higher timeframe is pointing, and from when.

The longest single thing Miles explained on the 12 September call: before an
entry is even considered, the day or the week has a direction, derived from
the 4-hour or the daily, and entries that disagree with it are not taken.  He
was careful to call it an *assumption* rather than a fact -- it is the frame
you trade inside until price says otherwise, not a prediction.

The reading here is market structure, which is the mechanical half of what he
described.  Price is bullish once it closes above the last swing high that
had been confirmed before that close -- a break of structure upward -- and
bearish once it closes below the last confirmed swing low.  Between the two
it keeps whatever it last had; a range does not erase the frame it is
ranging inside.  The first bars of a series have no frame at all, and say so
rather than guessing.

**The trap this module exists to avoid.**  A higher-timeframe bar is longer
than the bar being entered on -- that is the entire point of consulting it --
so it is knowable much later than its own timestamp suggests.  A 4-hour bar
stamped 08:00 is not finished until 12:00, and a 5-minute entry at 08:05 that
reads it has consulted four hours of the future.  Nothing in the result looks
wrong: the equity curve simply improves, because the trades that disagreed
with a bar that had not happened yet were the losers.

So every state here carries ``known_from``, which is the **close** of the bar
that produced it, and callers must filter on that and never on ``time``.  It
is the one place in this codebase where a bar's open time is the wrong
question, and :func:`bias_at` is the only sanctioned way to ask.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.analysis.structure import SwingPoint
from app.models.domain import Candle

BiasDirection = Literal["bullish", "bearish", "neutral"]


@dataclass(frozen=True)
class BiasState:
    """The frame the higher timeframe was in, and when that became knowable."""

    #: Open time of the higher-timeframe bar whose close set this state.
    time: int
    #: Close of that bar: the first instant a trade may act on this. Compare
    #: entry times against *this*, never against ``time``.
    known_from: int
    direction: BiasDirection
    #: What broke, in words, for the notes beside a trade.
    reason: str
    #: The level that was broken to produce this state. ``None`` while
    #: neutral, when nothing has been broken yet.
    broken_level: float | None = None


def find_bias_states(
    candles: list[Candle],
    swings: list[SwingPoint],
    *,
    interval_ms: int,
) -> list[BiasState]:
    """Walk the higher-timeframe series and record every change of frame.

    One entry per *change*, not per bar: the frame persists until something
    breaks it, and a list with a row for every 4-hour bar of a year would say
    the same thing ten thousand times.

    ``swings`` must be the swing points of ``candles`` -- the same series, at
    the same interval.  Passing the entry timeframe's swings here is the
    mistake that makes this module pointless, since it would then describe
    the timeframe it is supposed to be standing above.
    """

    if not candles or interval_ms <= 0:
        return []

    highs = [point for point in swings if point.kind == "high"]
    lows = [point for point in swings if point.kind == "low"]

    states: list[BiasState] = []
    direction: BiasDirection = "neutral"
    high_cursor = 0
    low_cursor = 0
    last_high: SwingPoint | None = None
    last_low: SwingPoint | None = None

    for candle in candles:
        close_time = candle.time + interval_ms

        # Only swings whose confirmation had *completed* by the time this bar
        # opened are eligible. A pivot confirmed halfway through this bar is
        # not a level this bar can be said to have broken.
        while high_cursor < len(highs) and highs[high_cursor].confirmed_time <= candle.time:
            last_high = highs[high_cursor]
            high_cursor += 1
        while low_cursor < len(lows) and lows[low_cursor].confirmed_time <= candle.time:
            last_low = lows[low_cursor]
            low_cursor += 1

        changed: BiasState | None = None

        # Checked in the order the break happened is impossible to know from
        # a single bar, so a bar that breaks both levels is read as the side
        # it *closed* on -- the same evidence the rest of the rule uses.
        broke_up = last_high is not None and candle.close > last_high.price
        broke_down = last_low is not None and candle.close < last_low.price

        if broke_up and broke_down:
            broke_up = candle.close >= candle.open
            broke_down = not broke_up

        if broke_up and direction != "bullish":
            assert last_high is not None
            changed = BiasState(
                time=candle.time,
                known_from=close_time,
                direction="bullish",
                reason=(
                    f"Closed above the swing high at {last_high.price:g}, "
                    "so the frame is bullish until a low goes."
                ),
                broken_level=last_high.price,
            )
            direction = "bullish"
        elif broke_down and direction != "bearish":
            assert last_low is not None
            changed = BiasState(
                time=candle.time,
                known_from=close_time,
                direction="bearish",
                reason=(
                    f"Closed below the swing low at {last_low.price:g}, "
                    "so the frame is bearish until a high goes."
                ),
                broken_level=last_low.price,
            )
            direction = "bearish"

        if changed is not None:
            states.append(changed)

    return states


def bias_at(states: list[BiasState], time: int) -> BiasState | None:
    """The frame in force at ``time``, or ``None`` if none had been set yet.

    ``None`` is a real answer and not a failure: early in a series nothing has
    broken in either direction, and a rule that required a bias would rightly
    take no trades there.  Reporting "neutral" instead would be a claim the
    data does not support.

    Gated on ``known_from``, which is why this function exists rather than the
    caller scanning the list itself.
    """

    best: BiasState | None = None
    for state in states:
        if state.known_from > time:
            break  # States are in order, so nothing later can qualify.
        best = state
    return best


def bias_allows(state: BiasState | None, direction: Literal["long", "short"]) -> bool:
    """Whether a trade in ``direction`` agrees with the frame.

    An absent or neutral frame allows nothing.  That is the deliberate
    reading: the condition is "the higher timeframe is behind this trade",
    and a timeframe that has not spoken is not behind it.
    """

    if state is None or state.direction == "neutral":
        return False
    wanted = "bullish" if direction == "long" else "bearish"
    return state.direction == wanted
