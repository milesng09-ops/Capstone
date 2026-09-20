"""How hard price reacted at a level, as a number rather than an impression.

Miles offered the mechanical version of this himself: at a level worth
trading, the candle does not merely touch and drift -- it spikes through,
gets rejected, and closes back the other side of its own open, leaving a long
wick behind.  "It reacted fifty points off that" is the same observation with
a size attached.

Three measurements, because the three fail independently:

``wick_ratio``
    The rejection wick as a share of the bar's whole range.  A long wants a
    long *lower* wick: price went down there and did not stay.  This is the
    shape half of the claim.

``closed_through_open``
    The bar closed back through its own open, which is what separates a
    rejection from a bar that simply opened low and stayed low.  A bar can
    have a respectable wick and still close on its lows.

``displacement_percent``
    How far it came back, from the extreme to the close, in percent.  The
    shape can be right on a bar that moved almost nothing, and "reacted
    fifty points" is a claim about size that the two ratios cannot make.

**Which bar is the reaction.**  The one price reacted *on*, which is the
entry bar for a close entry and the bar before it for a next-open entry --
the same boundary every other condition in this package respects.  Getting
this wrong is not a rounding error: for a next-open entry the entry bar's own
wick is the future, and filtering on it selects exactly the bars that were
about to go the right way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.models.domain import Candle

Direction = Literal["long", "short"]


@dataclass(frozen=True)
class Reaction:
    """What one candle did at a level."""

    time: int
    #: Rejection wick over the whole range, 0.0 .. 1.0. The lower wick for a
    #: long, the upper wick for a short.
    wick_ratio: float
    #: Body over the whole range, 0.0 .. 1.0. Kept because a bar that is all
    #: body is the opposite of a rejection however far it travelled.
    body_ratio: float
    #: Closed back through its own open, in the trade's favour.
    closed_through_open: bool
    #: Distance from the extreme to the close, in price.
    displacement: float
    #: The same, as a percentage of the close.
    displacement_percent: float

    def meets(self, *, min_wick_ratio: float, min_displacement_percent: float) -> bool:
        """Whether this clears both bars of the test.

        ``closed_through_open`` is required unconditionally rather than being
        a third setting. A bar that closed against the trade is not a
        rejection in the trade's favour whatever its wick measures, and a
        switch to say otherwise would only ever be turned on by accident.
        """

        return (
            self.closed_through_open
            and self.wick_ratio >= min_wick_ratio
            and self.displacement_percent >= min_displacement_percent
        )


def measure_reaction(candle: Candle, direction: Direction) -> Reaction | None:
    """Measure ``candle`` as a reaction in favour of ``direction``.

    ``None`` for a bar with no range at all -- a completely flat candle, which
    happens in thin overnight data.  Every ratio would be a division by zero,
    and calling that a perfect rejection is how a halted market becomes the
    best setup in the backtest.
    """

    total = candle.high - candle.low
    if total <= 0:
        return None

    body = abs(candle.close - candle.open)

    if direction == "long":
        wick = min(candle.open, candle.close) - candle.low
        displacement = candle.close - candle.low
        closed_through = candle.close > candle.open
    else:
        wick = candle.high - max(candle.open, candle.close)
        displacement = candle.high - candle.close
        closed_through = candle.close < candle.open

    return Reaction(
        time=candle.time,
        wick_ratio=max(0.0, wick / total),
        body_ratio=body / total,
        closed_through_open=closed_through,
        displacement=displacement,
        displacement_percent=(displacement / candle.close * 100) if candle.close else 0.0,
    )


def reaction_at(
    candles: list[Candle],
    entry_index: int,
    direction: Direction,
    *,
    entry_bar_known: bool,
) -> Reaction | None:
    """The reaction candle for an entry at ``entry_index``.

    ``entry_bar_known`` carries the same meaning it has in
    :mod:`app.analysis.conditions`: a close entry has watched its own bar
    finish, a next-open entry has not.  In the second case the bar before is
    the last thing that actually happened, so that is what is measured.
    """

    index = entry_index if entry_bar_known else entry_index - 1
    if index < 0 or index >= len(candles):
        return None
    return measure_reaction(candles[index], direction)
