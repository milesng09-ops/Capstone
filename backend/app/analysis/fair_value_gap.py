"""Fair value gap (FVG) detection.

A fair value gap is the unfilled space left by three consecutive candles when
the middle candle moves far enough that the first and third candles do not
overlap:

* **Bullish** -- ``candle[i-2].high < candle[i].low``.  The gap runs from the
  first candle's high (bottom) to the third candle's low (top).
* **Bearish** -- ``candle[i-2].low > candle[i].high``.  The gap runs from the
  third candle's high (bottom) to the first candle's low (top).

The gap is known as soon as the third candle closes, so -- unlike a swing
point -- there is no confirmation delay.

Each gap then tracks how far price has traded back into it:

``mitigated``   price has touched the gap at all.
``filled``      price has traded through the far edge; the gap is closed.
``penetration`` deepest travel into the gap, 0.0 (untouched) to 1.0 (filled).

Gap edges matter beyond display: a swing that lands on the high or low of a
fair value gap is one of the two anchors that make an SMT divergence valid,
which is why :mod:`app.analysis.smt` consumes this module's output.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from app.models.domain import Candle

GapDirection = Literal["bullish", "bearish"]

#: Gaps narrower than this fraction of price are noise on most instruments.
DEFAULT_MIN_SIZE_PERCENT = 0.0


@dataclass(frozen=True)
class FairValueGap:
    """One three-candle imbalance and its mitigation state."""

    symbol: str
    direction: GapDirection
    #: Index/time of the third candle -- the one that reveals the gap.
    index: int
    time: int
    #: Time of the first candle of the triple; where the zone starts on a chart.
    start_time: int
    #: Where the zone stops being drawn: the fill time, or the last candle.
    end_time: int
    bottom: float
    top: float
    size: float
    size_percent: float
    mitigated: bool
    mitigated_time: int | None
    filled: bool
    filled_time: int | None
    penetration: float

    @property
    def midpoint(self) -> float:
        """The consequent encroachment level -- the middle of the gap."""

        return (self.top + self.bottom) / 2.0


def find_fair_value_gaps(
    candles: list[Candle],
    *,
    min_size_percent: float = DEFAULT_MIN_SIZE_PERCENT,
    include_filled: bool = True,
) -> list[FairValueGap]:
    """Return every fair value gap in ``candles``, oldest first.

    ``min_size_percent`` drops gaps smaller than that percentage of the gap's
    own midpoint price, which filters the one-tick imbalances that appear in
    thin overnight sessions.  ``include_filled`` keeps gaps that price has
    already traded fully through; set it to ``False`` for a chart that should
    only show live zones.
    """

    total = len(candles)
    if total < 3:
        return []

    highs = np.array([candle.high for candle in candles], dtype=np.float64)
    lows = np.array([candle.low for candle in candles], dtype=np.float64)
    times = np.array([candle.time for candle in candles], dtype=np.int64)
    symbol = candles[0].symbol
    last_time = int(times[-1])

    # Index i is the third candle of the triple (i-2, i-1, i).
    third = np.arange(2, total)
    first = third - 2

    bullish = highs[first] < lows[third]
    bearish = lows[first] > highs[third]

    gaps: list[FairValueGap] = []

    for offset in np.flatnonzero(bullish | bearish):
        index = int(third[offset])
        origin = int(first[offset])

        if bullish[offset]:
            direction: GapDirection = "bullish"
            bottom = float(highs[origin])
            top = float(lows[index])
        else:
            direction = "bearish"
            bottom = float(highs[index])
            top = float(lows[origin])

        size = top - bottom
        midpoint = (top + bottom) / 2.0
        size_percent = (size / midpoint * 100.0) if midpoint else 0.0
        if size_percent < min_size_percent:
            continue

        state = _mitigation_state(direction, bottom, top, highs, lows, times, index)
        if state.filled and not include_filled:
            continue

        gaps.append(
            FairValueGap(
                symbol=symbol,
                direction=direction,
                index=index,
                time=int(times[index]),
                start_time=int(times[origin]),
                end_time=state.filled_time or last_time,
                bottom=bottom,
                top=top,
                size=size,
                size_percent=size_percent,
                mitigated=state.mitigated_time is not None,
                mitigated_time=state.mitigated_time,
                filled=state.filled,
                filled_time=state.filled_time,
                penetration=state.penetration,
            )
        )

    return gaps


@dataclass(frozen=True)
class _MitigationState:
    mitigated_time: int | None
    filled: bool
    filled_time: int | None
    penetration: float


def _mitigation_state(
    direction: GapDirection,
    bottom: float,
    top: float,
    highs: np.ndarray,
    lows: np.ndarray,
    times: np.ndarray,
    index: int,
) -> _MitigationState:
    """Walk forward from the gap and measure how far price re-entered it.

    Only candles *after* the third candle of the triple count: the candle that
    creates the gap cannot also mitigate it.
    """

    forward = slice(index + 1, None)
    forward_times = times[forward]
    if forward_times.size == 0:
        return _MitigationState(None, False, None, 0.0)

    span = top - bottom
    if span <= 0:
        return _MitigationState(None, False, None, 0.0)

    if direction == "bullish":
        # Price falls back into a bullish gap, so lows do the work.
        touched = lows[forward] <= top
        closed = lows[forward] <= bottom
        deepest = float(lows[forward].min())
        penetration = (top - deepest) / span
    else:
        touched = highs[forward] >= bottom
        closed = highs[forward] >= top
        deepest = float(highs[forward].max())
        penetration = (deepest - bottom) / span

    touch_hits = np.flatnonzero(touched)
    close_hits = np.flatnonzero(closed)

    return _MitigationState(
        mitigated_time=int(forward_times[touch_hits[0]]) if touch_hits.size else None,
        filled=bool(close_hits.size),
        filled_time=int(forward_times[close_hits[0]]) if close_hits.size else None,
        penetration=float(np.clip(penetration, 0.0, 1.0)),
    )


def gap_containing(gaps: list[FairValueGap], price: float, time: int) -> FairValueGap | None:
    """Find a gap that was open at ``time`` and whose zone contains ``price``.

    Used to answer "is this swing sitting inside a fair value gap?", the
    higher-timeframe confluence Miles described as the actual setup.
    """

    for gap in gaps:
        if gap.time > time:
            continue  # The gap did not exist yet.
        if gap.filled_time is not None and gap.filled_time < time:
            continue  # Already closed before this point.
        if gap.bottom <= price <= gap.top:
            return gap
    return None
