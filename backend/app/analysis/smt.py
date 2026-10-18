"""SMT divergence detection across correlated instruments.

Two correlated markets normally take out the same levels together.  When one
of them makes a higher high and the other fails to, that disagreement is an
*SMT divergence*, and it tends to precede a move against the market that ran:

* divergence **at a high** -> bearish (the high was a liquidity grab);
* divergence **at a low**  -> bullish.

The detector walks consecutive swing points on the primary symbol, looks up
the *same bar times* on a reference symbol, and reports the pairs where
exactly one of the two took the level.  Both symbols must have a candle at
both timestamps -- an unmatched bar is skipped rather than interpolated,
because a fabricated bar would fabricate a divergence.

**Validity.**  Not every disagreement counts.  A divergence is drawn between
two points, and those points have to be meaningful on *both* charts:

``swing_pair``   both reference anchors are swing points too -- the strongest
                 case, and the one to trade;
``fvg_edge``     a reference anchor is not a swing point but sits exactly on
                 the high or low of a fair value gap, which the rules still
                 accept;
``unconfirmed``  neither holds; reported for inspection but marked invalid.

``inside_fair_value_gap`` flags the higher-confluence case where the pivot
itself lands inside a fair value gap on the primary chart.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from app.analysis.fair_value_gap import FairValueGap, gap_containing
from app.analysis.structure import SwingPoint, swing_points_by_kind
from app.models.domain import Candle

SmtKind = Literal["high", "low"]
SmtBias = Literal["bearish", "bullish"]
SmtValidity = Literal["swing_pair", "fvg_edge", "unconfirmed"]

#: Two swing points further apart than this are not read as the same leg.
DEFAULT_MAX_SEPARATION_BARS = 120


@dataclass(frozen=True)
class SmtDivergence:
    """One disagreement between two correlated symbols at the same two bars."""

    kind: SmtKind
    bias: SmtBias
    primary_symbol: str
    reference_symbol: str
    #: The earlier anchor -- the level that was being tested.
    start_time: int
    #: The later anchor -- the pivot where the two charts disagreed.
    end_time: int
    primary_start_price: float
    primary_end_price: float
    reference_start_price: float
    reference_end_price: float
    #: The symbol that took the level, and the one that failed to.
    leading_symbol: str
    lagging_symbol: str
    validity: SmtValidity
    valid: bool
    #: Earliest time the divergence could actually have been acted on, once
    #: both swing points had been confirmed.
    confirmed_time: int
    inside_fair_value_gap: bool
    fair_value_gap_time: int | None
    #: Size of the disagreement in percentage points.
    strength: float
    separation_bars: int


def find_smt_divergences(
    primary_candles: list[Candle],
    primary_swings: list[SwingPoint],
    reference_candles: list[Candle],
    reference_swings: list[SwingPoint],
    *,
    primary_gaps: list[FairValueGap] | None = None,
    reference_gaps: list[FairValueGap] | None = None,
    max_separation_bars: int = DEFAULT_MAX_SEPARATION_BARS,
    include_invalid: bool = False,
) -> list[SmtDivergence]:
    """Compare ``primary`` against ``reference`` and return the divergences.

    Set ``include_invalid`` to keep the ``unconfirmed`` cases, which is useful
    when tuning ``strength`` but should stay off for trading rules.
    """

    if not primary_candles or not reference_candles:
        return []

    primary_symbol = primary_candles[0].symbol
    reference_symbol = reference_candles[0].symbol
    reference_by_time = {candle.time: candle for candle in reference_candles}
    reference_index = {candle.time: index for index, candle in enumerate(reference_candles)}
    reference_swing_at = {(point.time, point.kind): point for point in reference_swings}

    primary_gaps = primary_gaps or []
    reference_gaps = reference_gaps or []

    divergences: list[SmtDivergence] = []

    for kind in ("high", "low"):
        points = swing_points_by_kind(primary_swings, kind)  # type: ignore[arg-type]

        for previous, current in zip(points, points[1:]):
            separation = current.index - previous.index
            if separation <= 0 or separation > max_separation_bars:
                continue

            reference_previous = reference_by_time.get(previous.time)
            reference_current = reference_by_time.get(current.time)
            if reference_previous is None or reference_current is None:
                continue

            if kind == "high":
                primary_start, primary_end = previous.price, current.price
                reference_start = reference_previous.high
                reference_end = reference_current.high
                primary_took = primary_end > primary_start
                reference_took = reference_end > reference_start
                bias: SmtBias = "bearish"
            else:
                primary_start, primary_end = previous.price, current.price
                reference_start = reference_previous.low
                reference_end = reference_current.low
                primary_took = primary_end < primary_start
                reference_took = reference_end < reference_start
                bias = "bullish"

            # Agreement is the normal case and carries no signal; a divergence
            # is exactly one of the two taking the level.
            if primary_took == reference_took:
                continue

            validity, reference_known = _classify(
                kind,
                reference_previous,
                reference_current,
                reference_swing_at,
                reference_gaps,
                reference_index,
            )
            valid = validity != "unconfirmed"
            if not valid and not include_invalid:
                continue

            gap = gap_containing(primary_gaps, primary_end, current.time)

            divergences.append(
                SmtDivergence(
                    kind=kind,  # type: ignore[arg-type]
                    bias=bias,
                    primary_symbol=primary_symbol,
                    reference_symbol=reference_symbol,
                    start_time=previous.time,
                    end_time=current.time,
                    primary_start_price=primary_start,
                    primary_end_price=primary_end,
                    reference_start_price=reference_start,
                    reference_end_price=reference_end,
                    leading_symbol=primary_symbol if primary_took else reference_symbol,
                    lagging_symbol=reference_symbol if primary_took else primary_symbol,
                    validity=validity,
                    valid=valid,
                    # The reference's pivots are confirmed on the reference's
                    # own bars. Where it is missing one the primary has --
                    # an hour nobody traded YM -- its swing confirms later,
                    # and the validity it lends is not known before then.
                    confirmed_time=max(current.confirmed_time, current.time, reference_known),
                    inside_fair_value_gap=gap is not None,
                    fair_value_gap_time=gap.time if gap else None,
                    strength=_strength(
                        primary_start, primary_end, reference_start, reference_end
                    ),
                    separation_bars=separation,
                )
            )

    divergences.sort(key=lambda item: (item.end_time, item.kind))
    return divergences


def _classify(
    kind: SmtKind,
    reference_previous: Candle,
    reference_current: Candle,
    reference_swing_at: dict[tuple[int, str], SwingPoint],
    reference_gaps: list[FairValueGap],
    reference_index: dict[int, int],
) -> tuple[SmtValidity, int]:
    """Decide whether the reference anchors make this divergence tradable.

    Returns the validity and the time it became knowable: the latest
    confirmation among the reference swing points it rests on. A gap edge
    adds nothing, since only gaps revealed by the anchor's own bar count.
    """

    anchors = (reference_previous, reference_current)
    swings = [reference_swing_at.get((candle.time, kind)) for candle in anchors]
    known = max((swing.confirmed_time for swing in swings if swing is not None), default=0)
    if all(swing is not None for swing in swings):
        return "swing_pair", known

    # A non-swing anchor is still accepted when it sits on a gap edge.
    for candle, swing in zip(anchors, swings):
        if swing is not None:
            continue
        price = candle.high if kind == "high" else candle.low
        if not _on_gap_edge(price, candle.time, reference_gaps, reference_index):
            return "unconfirmed", known
    return "fvg_edge", known


def _on_gap_edge(
    price: float,
    time: int,
    gaps: list[FairValueGap],
    index_by_time: dict[int, int],
) -> bool:
    """True when ``price`` is the high or low of a gap that existed at ``time``."""

    position = index_by_time.get(time)
    for gap in gaps:
        if gap.time > time:
            continue
        if position is not None and gap.index > position:
            continue
        if math.isclose(price, gap.top, rel_tol=1e-9, abs_tol=1e-9):
            return True
        if math.isclose(price, gap.bottom, rel_tol=1e-9, abs_tol=1e-9):
            return True
    return False


def _strength(
    primary_start: float,
    primary_end: float,
    reference_start: float,
    reference_end: float,
) -> float:
    """Divergence size in percentage points.

    Each symbol's move is expressed against its own price first, so an index
    trading at 20,000 does not automatically outweigh one trading at 5,000.
    """

    primary_delta = _percent_change(primary_start, primary_end)
    reference_delta = _percent_change(reference_start, reference_end)
    return abs(primary_delta - reference_delta)


def _percent_change(start: float, end: float) -> float:
    if not start:
        return 0.0
    return (end - start) / abs(start) * 100.0
