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
``LiquidityPool``   ``swept_time`` for this purpose.  The pool
                    exists from ``formed_time``, but the condition
                    is about the sweep, and that is the later of
                    the two
``BiasState``       ``known_from``, the **close** of the higher-
                    timeframe bar that set the frame -- hours after
                    the ``time`` that bar is stamped with
``Reaction``        the bar at the level, which is the entry bar
                    only when that bar has finished
``FibZone``         both ends of the leg must be confirmed, so the
                    later of the two ``confirmed_time``s
==================  ==============================================

Using ``SwingPoint.time`` instead of ``confirmed_time`` is the subtle version
of the mistake: the pivot is real at that bar, but nobody could have known it
was a pivot until the confirmation window closed.  Filtering on it would
build a strategy that trades on hindsight and backtests beautifully.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.analysis.bias import BiasState, bias_allows, bias_at
from app.analysis.entries import EntryModel, FibZone, fib_zone_at
from app.analysis.fair_value_gap import FairValueGap, gap_containing
from app.analysis.liquidity import LiquidityPool, pools_swept_before
from app.analysis.reaction import Reaction, reaction_at
from app.analysis.sessions import SessionWindow, session_at
from app.analysis.smt import SmtDivergence
from app.analysis.structure import SwingPoint
from app.models.domain import Candle

Direction = Literal["long", "short"]


@dataclass(frozen=True)
class DetectorState:
    """Which detectors stood at one entry bar.

    ``None`` means the detector did not stand, either because nothing was
    there or because what was there pointed the other way.

    The last four are not detectors in the drawn-on-the-chart sense, but they
    answer the same kind of question at the same moment and fail the same
    way if asked a bar too late, so they live here with the rest.
    """

    fair_value_gap: FairValueGap | None = None
    smt_divergence: SmtDivergence | None = None
    swing_point: SwingPoint | None = None
    liquidity_pool: LiquidityPool | None = None
    #: The higher-timeframe frame in force, gated on the close of the bar
    #: that set it. ``None`` when nothing had been established yet.
    bias: BiasState | None = None
    #: Whether that frame agrees with the trade. Kept separate from ``bias``
    #: because "no frame" and "the wrong frame" are different refusals.
    bias_agrees: bool = False
    #: What the bar at the level did. ``None`` for a flat bar, or when there
    #: was no prior bar to read for a next-open entry.
    reaction: Reaction | None = None
    #: The retracement band of the last confirmed leg, and whether the entry
    #: sat inside it.
    fib_zone: FibZone | None = None
    fib_contains_entry: bool = False
    #: The named window the entry fell in. ``None`` both when no filter was
    #: asked for and when the entry fell outside every window, which is why
    #: the caller is told which of those it is rather than inferring it.
    session: SessionWindow | None = None


def detectors_at_entry(
    *,
    entry_price: float,
    entry_time: int,
    direction: Direction,
    gaps: list[FairValueGap],
    swings: list[SwingPoint],
    divergences: list[SmtDivergence],
    pools: list[LiquidityPool] | None = None,
    within_ms: int,
    align_with_direction: bool,
    gap_past_midpoint: bool = False,
    entry_bar_known: bool = True,
    bias_states: list[BiasState] | None = None,
    candles: list[Candle] | None = None,
    entry_index: int | None = None,
    sessions: list[SessionWindow] | None = None,
    fib_low: float | None = None,
    fib_high: float | None = None,
) -> DetectorState:
    """Everything that was knowably true at ``entry_time``, and no more.

    ``align_with_direction`` requires each detector to point the same way as
    the trade: a long wants a bullish gap, a bullish divergence, a swing low
    and a shelf of *lows* taken out.  Switched off, presence alone is enough
    -- useful for asking whether a detector marks a turning point at all,
    rather than a directional one.

    ``entry_bar_known`` says whether the entry bar has finished when the trade
    fills, and it is the difference between the two entry types:

    * ``selection_close`` fills at that bar's **close**, so the bar is over
      and its high, low and close are all knowable.
    * ``next_open`` fills at that bar's **open**, so nothing about the bar has
      happened yet.

    Reading the entry bar in the second case is the version of lookahead this
    module warns about that is easiest to miss and hardest to spot in a
    result.  It bites the liquidity sweep hardest: a sweep *is* that bar's
    low, so admitting the bar would let a trade be qualified by the very
    candle it is filled on -- entering at the open of the one bar known to
    dip and recover, which is the single most favourable fill in the setup.
    """

    # Timestamps are whole milliseconds, so stepping back one is exactly
    # "everything strictly before this bar" without a second comparison
    # operator in four different helpers.
    cutoff = entry_time if entry_bar_known else entry_time - 1

    bias = bias_at(bias_states or [], cutoff)

    reaction = None
    if candles is not None and entry_index is not None:
        reaction = reaction_at(
            candles, entry_index, direction, entry_bar_known=entry_bar_known
        )

    zone = None
    if fib_low is not None and fib_high is not None:
        zone = fib_zone_at(
            swings, cutoff, direction, low_ratio=fib_low, high_ratio=fib_high
        )

    return DetectorState(
        fair_value_gap=_gap_at(
            entry_price,
            cutoff,
            direction,
            gaps,
            align_with_direction,
            gap_past_midpoint,
        ),
        smt_divergence=_divergence_at(
            cutoff, direction, divergences, within_ms, align_with_direction
        ),
        swing_point=_swing_at(
            cutoff, direction, swings, within_ms, align_with_direction
        ),
        liquidity_pool=_sweep_at(
            cutoff, direction, pools or [], within_ms, align_with_direction
        ),
        bias=bias,
        bias_agrees=bias_allows(bias, direction),
        reaction=reaction,
        fib_zone=zone,
        fib_contains_entry=zone is not None and zone.contains(entry_price),
        # The entry time itself, not the cutoff: what hour a trade was filled
        # in is knowable the moment it fills, and stepping back a millisecond
        # would drop a next-open entry out of a window it opened exactly on.
        session=session_at(entry_time, sessions or []),
    )


def _gap_at(
    entry_price: float,
    entry_time: int,
    direction: Direction,
    gaps: list[FairValueGap],
    align: bool,
    past_midpoint: bool = False,
) -> FairValueGap | None:
    """An unfilled gap whose zone contained the entry price.

    Containment rather than mere existence: a gap somewhere on the chart says
    nothing about this entry.  The setup being described is price trading back
    into an imbalance, so the entry has to be *in* it.

    ``past_midpoint`` asks for the deeper half instead of the whole zone --
    consequent encroachment, the second of the two entries a gap offers.

    No recency window applies. A gap stays live until it is filled, however
    long that takes, and its own ``filled_time`` already ends it.
    """

    wanted = "bullish" if direction == "long" else "bearish"
    candidates = [gap for gap in gaps if not align or gap.direction == wanted]
    # `gap_containing` does the time work: a gap revealed after `entry_time`
    # is skipped, and so is one already filled by then.
    return gap_containing(
        candidates, entry_price, entry_time, past_midpoint=past_midpoint
    )


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


def _sweep_at(
    entry_time: int,
    direction: Direction,
    pools: list[LiquidityPool],
    within_ms: int,
    align: bool,
) -> LiquidityPool | None:
    """The most recently swept shelf at or before the entry.

    A long wants the *lows* taken: the setup is price dipping under a shelf of
    equal lows, clearing the stops resting there, and turning back up.  Asking
    for the highs instead would describe a breakout, which is the opposite
    trade.

    Gated on ``swept_time``, not ``formed_time``.  The shelf existing is not
    the event -- it can stand untouched for weeks -- and the reason to be in
    the trade is that it was taken out just now.
    """

    wanted = "low" if direction == "long" else "high"
    kinds: tuple[str, ...] = (wanted,) if align else ("low", "high")

    best: LiquidityPool | None = None
    for kind in kinds:
        for pool in pools_swept_before(pools, kind, entry_time, within_ms=within_ms):
            if best is None or (pool.swept_time or 0) > (best.swept_time or 0):
                best = pool
            break  # `pools_swept_before` is sorted, so the first is the latest.
    return best


def unmet_condition(
    state: DetectorState,
    *,
    require_fair_value_gap: bool,
    require_smt_divergence: bool,
    require_swing_point: bool,
    require_liquidity_sweep: bool = False,
    gap_past_midpoint: bool = False,
    require_higher_timeframe_bias: bool = False,
    require_reaction: bool = False,
    min_wick_ratio: float = 0.0,
    min_reaction_percent: float = 0.0,
    entry_model: EntryModel = "any",
    require_session: bool = False,
) -> str | None:
    """Why this entry does not qualify, or ``None`` if it does.

    A sentence rather than a boolean, because a match dropped without a reason
    is indistinguishable from one that was never found -- and the difference
    matters when a run reports three trades instead of twenty-five.
    """

    if require_fair_value_gap and state.fair_value_gap is None:
        # The two settings fail for different reasons, and "no gap contained
        # the entry" would be wrong for a trade that was inside a gap and
        # simply had not traded deep enough into it.
        if gap_past_midpoint:
            return (
                "No unfilled fair value gap had been traded past its midpoint "
                "by the entry price."
            )
        return "No unfilled fair value gap contained the entry price."
    if require_smt_divergence and state.smt_divergence is None:
        return "No confirmed SMT divergence stood within the window before entry."
    if require_swing_point and state.swing_point is None:
        return "No confirmed swing point stood within the window before entry."
    if require_liquidity_sweep and state.liquidity_pool is None:
        return "No liquidity pool was swept within the window before entry."
    if require_higher_timeframe_bias and not state.bias_agrees:
        # The two refusals are different facts about the run and want
        # different responses: no frame at all usually means the higher
        # timeframe has too little history behind the selection, which is
        # fixed by widening it. The wrong frame is the filter working.
        if state.bias is None:
            return (
                "The higher timeframe had not established a direction by the entry "
                "bar, so there was no bias to trade with."
            )
        return (
            f"The higher timeframe was {state.bias.direction} at the entry bar, "
            "which is against this trade."
        )
    if require_reaction:
        if state.reaction is None:
            return "The bar at the level had no range to measure a reaction from."
        if not state.reaction.closed_through_open:
            return "The bar at the level did not close back through its own open."
        if state.reaction.wick_ratio < min_wick_ratio:
            return (
                f"The rejection wick was {state.reaction.wick_ratio:.0%} of the bar's "
                f"range, short of the {min_wick_ratio:.0%} asked for."
            )
        if state.reaction.displacement_percent < min_reaction_percent:
            return (
                f"Price came back {state.reaction.displacement_percent:.2f}% off the "
                f"extreme, short of the {min_reaction_percent:g}% asked for."
            )
    if entry_model == "fib_retrace" and not state.fib_contains_entry:
        if state.fib_zone is None:
            return (
                "No confirmed swing leg stood before the entry, so there was no "
                "retracement to measure it against."
            )
        return (
            f"The entry was outside the {state.fib_zone.low_ratio:g}-"
            f"{state.fib_zone.high_ratio:g} retracement of the last leg "
            f"({state.fib_zone.low:g} to {state.fib_zone.high:g})."
        )
    if require_session and state.session is None:
        return "The entry fell outside every session that was asked for."
    return None
