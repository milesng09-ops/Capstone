"""What was standing at the bar a trade entered on, and whether it qualifies.

The detectors in this package have until now been drawn on the chart and
listed beside a trade, but never allowed to decide anything.  This module is
what turns one into a condition: *only take the match if an unfilled fair
value gap contained the entry*, *only take it if the two symbols had already
disagreed*.  A match that fails its conditions is not traded, and the summary
says how many fell out that way.

**Everything here is evaluated as of the entry bar, and nothing later may be
consulted.**  That is not a stylistic preference -- it is the one way this
feature can be wrong in a manner that looks like success.  Each detector
carries a moment it became knowable, and only that moment is used:

==================  ==============================================
Detector            Knowable from
==================  ==============================================
``FairValueGap``    ``time``, the close of the third candle, and it
                    stops counting at ``filled_time``
``SwingPoint``      ``confirmed_time``, after ``strength`` bars of
                    confirmation -- *not* ``time``, which is the
                    pivot itself and is only recognisable later
``SmtDivergence``   ``confirmed_time``, once both swings confirmed
==================  ==============================================

Using ``SwingPoint.time`` instead of ``confirmed_time`` is the subtle version
of the mistake: the pivot is real at that bar, but nobody could have known it
was a pivot until the confirmation window closed.  Filtering on it would
build a strategy that trades on hindsight and backtests beautifully.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.analysis.fair_value_gap import FairValueGap, gap_containing
from app.analysis.smt import SmtDivergence
from app.analysis.structure import SwingPoint

Direction = Literal["long", "short"]


@dataclass(frozen=True)
class DetectorState:
    """Which detectors stood at one entry bar.

    ``None`` means the detector did not stand, either because nothing was
    there or because what was there pointed the other way.
    """

    fair_value_gap: FairValueGap | None = None
    smt_divergence: SmtDivergence | None = None
    swing_point: SwingPoint | None = None


def detectors_at_entry(
    *,
    entry_price: float,
    entry_time: int,
    direction: Direction,
    gaps: list[FairValueGap],
    swings: list[SwingPoint],
    divergences: list[SmtDivergence],
    within_ms: int,
    align_with_direction: bool,
) -> DetectorState:
    """Everything that was knowably true at ``entry_time``, and no more.

    ``align_with_direction`` requires each detector to point the same way as
    the trade: a long wants a bullish gap, a bullish divergence and a swing
    low.  Switched off, presence alone is enough -- useful for asking whether
    a detector marks a turning point at all, rather than a directional one.
    """

    return DetectorState(
        fair_value_gap=_gap_at(
            entry_price, entry_time, direction, gaps, align_with_direction
        ),
        smt_divergence=_divergence_at(
            entry_time, direction, divergences, within_ms, align_with_direction
        ),
        swing_point=_swing_at(
            entry_time, direction, swings, within_ms, align_with_direction
        ),
    )


def _gap_at(
    entry_price: float,
    entry_time: int,
    direction: Direction,
    gaps: list[FairValueGap],
    align: bool,
) -> FairValueGap | None:
    """An unfilled gap whose zone contained the entry price.

    Containment rather than mere existence: a gap somewhere on the chart says
    nothing about this entry.  The setup being described is price trading back
    into an imbalance, so the entry has to be *in* it.

    No recency window applies. A gap stays live until it is filled, however
    long that takes, and its own ``filled_time`` already ends it.
    """

    wanted = "bullish" if direction == "long" else "bearish"
    candidates = [gap for gap in gaps if not align or gap.direction == wanted]
    # `gap_containing` does the time work: a gap revealed after `entry_time`
    # is skipped, and so is one already filled by then.
    return gap_containing(candidates, entry_price, entry_time)


def _divergence_at(
    entry_time: int,
    direction: Direction,
    divergences: list[SmtDivergence],
    within_ms: int,
    align: bool,
) -> SmtDivergence | None:
    """The most recent valid divergence confirmed at or before the entry.

    Invalid divergences are never eligible.  ``smt.find_smt_divergences``
    keeps the unconfirmed ones only when asked, for tuning, and its own
    docstring says they should stay out of trading rules.
    """

    wanted = "bullish" if direction == "long" else "bearish"
    best: SmtDivergence | None = None
    for item in divergences:
        if not item.valid:
            continue
        if align and item.bias != wanted:
            continue
        if item.confirmed_time > entry_time:
            continue  # Not yet knowable.
        if entry_time - item.confirmed_time > within_ms:
            continue  # Too long ago to be this trade's reason.
        if best is None or item.confirmed_time > best.confirmed_time:
            best = item
    return best


def _swing_at(
    entry_time: int,
    direction: Direction,
    swings: list[SwingPoint],
    within_ms: int,
    align: bool,
) -> SwingPoint | None:
    """The most recent confirmed swing at or before the entry.

    A long looks for a swing low: the structure it would be buying off.
    """

    wanted = "low" if direction == "long" else "high"
    best: SwingPoint | None = None
    for point in swings:
        if align and point.kind != wanted:
            continue
        if point.confirmed_time > entry_time:
            continue  # The pivot existed; nobody knew it yet.
        if entry_time - point.confirmed_time > within_ms:
            continue
        if best is None or point.confirmed_time > best.confirmed_time:
            best = point
    return best


def unmet_condition(
    state: DetectorState,
    *,
    require_fair_value_gap: bool,
    require_smt_divergence: bool,
    require_swing_point: bool,
) -> str | None:
    """Why this entry does not qualify, or ``None`` if it does.

    A sentence rather than a boolean, because a match dropped without a reason
    is indistinguishable from one that was never found -- and the difference
    matters when a run reports three trades instead of twenty-five.
    """

    if require_fair_value_gap and state.fair_value_gap is None:
        return "No unfilled fair value gap contained the entry price."
    if require_smt_divergence and state.smt_divergence is None:
        return "No confirmed SMT divergence stood within the window before entry."
    if require_swing_point and state.swing_point is None:
        return "No confirmed swing point stood within the window before entry."
    return None
