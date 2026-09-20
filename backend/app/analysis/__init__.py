"""Deterministic ICT / price-action detectors.

Everything in this package is rule-based arithmetic over completed candles.
Nothing is trained or fitted, and no detector may look at a candle to the
right of the one it is labelling unless that lookahead is explicitly part of
the definition (swing points need ``strength`` bars of confirmation, and that
confirmation delay is reported so the caller can respect it).

Running the same detector over the same candles always produces the same
result.  The machine-learning layer discussed for phase two consumes these
outputs as features; it does not replace them.
"""

from app.analysis.bias import BiasState, bias_allows, bias_at, find_bias_states
from app.analysis.entries import FibZone, fib_zone_at
from app.analysis.fair_value_gap import FairValueGap, find_fair_value_gaps
from app.analysis.liquidity import (
    LiquidityPool,
    find_liquidity_pools,
    maximal_pools,
    nearest_unswept_pool,
    pools_swept_before,
)
from app.analysis.reaction import Reaction, measure_reaction, reaction_at
from app.analysis.sessions import SESSIONS, SessionWindow, session_at, windows_for
from app.analysis.smt import SmtDivergence, find_smt_divergences
from app.analysis.structure import SwingPoint, find_swing_points

__all__ = [
    "BiasState",
    "FairValueGap",
    "FibZone",
    "LiquidityPool",
    "Reaction",
    "SESSIONS",
    "SessionWindow",
    "SmtDivergence",
    "SwingPoint",
    "bias_allows",
    "bias_at",
    "fib_zone_at",
    "find_bias_states",
    "find_fair_value_gaps",
    "find_liquidity_pools",
    "find_smt_divergences",
    "find_swing_points",
    "maximal_pools",
    "measure_reaction",
    "nearest_unswept_pool",
    "pools_swept_before",
    "reaction_at",
    "session_at",
    "windows_for",
]
