"""The two ways into a trade off one level.

From the call: "you either hit the gap, get a setup, and then move up -- or
you hit the middle line of the gap, then set up, then move up".  The same
shape appears one level up, at the swing leg rather than the gap: price
either turns straight off the level, or it pushes past and comes back into
the retracement before it goes.  Two different trades, two different entries,
and a backtest that mixes them is measuring neither.

``immediate``
    Take the entry where it is.  This is the behaviour the engine has always
    had, named so that choosing it is a decision rather than a default.

``fib_retrace``
    Only take it if the entry price sat inside a Fibonacci retracement of the
    most recent confirmed swing leg.  The default band, 0.62 to 0.79, is the
    ICT "optimal trade entry" -- deep enough that the impulse is genuinely
    being retraced rather than merely paused.

Fibonacci has existed in this app only as something to draw on a chart.  This
is the same arithmetic asked to decide something, which means it now has to
obey the rule the drawing never did: **both ends of the leg must have been
confirmed before the entry**.  A leg measured to a swing high that the entry
bar itself went on to set is a retracement of the future, and it fits
beautifully every time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.analysis.structure import SwingPoint

Direction = Literal["long", "short"]
EntryModel = Literal["any", "immediate", "fib_retrace"]

#: The optimal trade entry band. Deep retracements, where the impulse has
#: given most of itself back without breaking.
DEFAULT_FIB_LOW = 0.62
DEFAULT_FIB_HIGH = 0.79


@dataclass(frozen=True)
class FibZone:
    """A retracement band measured off one confirmed swing leg."""

    direction: Direction
    #: The leg itself, low to high, whichever order it happened in.
    leg_low: float
    leg_high: float
    leg_low_time: int
    leg_high_time: int
    #: The band, always ``low <= high`` in price terms.
    low: float
    high: float
    low_ratio: float
    high_ratio: float

    def contains(self, price: float) -> bool:
        return self.low <= price <= self.high

    def retracement_of(self, price: float) -> float | None:
        """How deep ``price`` sits in the leg, 0.0 at the impulse's end.

        For a long the leg ran up, so 0.0 is the swing high and 1.0 is the
        swing low it came from.  ``None`` for a leg with no height, which
        cannot be retraced.
        """

        span = self.leg_high - self.leg_low
        if span <= 0:
            return None
        if self.direction == "long":
            return (self.leg_high - price) / span
        return (price - self.leg_low) / span


def fib_zone_at(
    swings: list[SwingPoint],
    entry_time: int,
    direction: Direction,
    *,
    low_ratio: float = DEFAULT_FIB_LOW,
    high_ratio: float = DEFAULT_FIB_HIGH,
) -> FibZone | None:
    """The retracement band of the latest leg confirmed before ``entry_time``.

    A long retraces an *up* leg: the swing low it came from, and the swing
    high it reached.  Both must be confirmed by ``entry_time``, and the high
    must come after the low, or it is not a leg that price is currently
    retracing.

    ``None`` when there is no such leg -- not enough structure yet, or the
    last two pivots are the wrong way round for this direction.  A rule
    requiring the zone then correctly declines the trade rather than
    inventing a band.
    """

    if low_ratio > high_ratio:
        low_ratio, high_ratio = high_ratio, low_ratio

    known = [point for point in swings if point.confirmed_time <= entry_time]
    if len(known) < 2:
        return None

    first_kind = "low" if direction == "long" else "high"
    second_kind = "high" if direction == "long" else "low"

    # The most recent pivot of the closing kind, then the most recent opposite
    # pivot *before* it. Taken in that order so the leg is the one price has
    # just made, not an older pair that happens to be the right way round.
    end = _latest(known, second_kind)
    if end is None:
        return None
    start = _latest([point for point in known if point.time < end.time], first_kind)
    if start is None:
        return None

    if direction == "long":
        leg_low, leg_high = start.price, end.price
        leg_low_time, leg_high_time = start.time, end.time
    else:
        leg_low, leg_high = end.price, start.price
        leg_low_time, leg_high_time = end.time, start.time

    span = leg_high - leg_low
    if span <= 0:
        return None

    if direction == "long":
        # Measured down from the high: 0.62 of the leg given back.
        high = leg_high - span * low_ratio
        low = leg_high - span * high_ratio
    else:
        low = leg_low + span * low_ratio
        high = leg_low + span * high_ratio

    return FibZone(
        direction=direction,
        leg_low=leg_low,
        leg_high=leg_high,
        leg_low_time=leg_low_time,
        leg_high_time=leg_high_time,
        low=min(low, high),
        high=max(low, high),
        low_ratio=low_ratio,
        high_ratio=high_ratio,
    )


def _latest(points: list[SwingPoint], kind: str) -> SwingPoint | None:
    best: SwingPoint | None = None
    for point in points:
        if point.kind != kind:
            continue
        if best is None or point.time > best.time:
            best = point
    return best
