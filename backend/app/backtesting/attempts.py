"""How many times this window has been asked, and what that does to a p-value.

The baseline answers *would chance produce a result this good?* for **one**
test.  Nobody runs one test.  A window gets dragged out, a stop widened, a
target moved, a detector switched on, and each of those is another draw at the
same question -- so the twentieth configuration turning up a 1-in-20 result is
not a finding, it is arithmetic.

Left uncounted, that is the most flattering thing a backtesting tool can do to
you, because every individual run looks honest.  This module counts the draws
and says what the run is worth given them:

    p = 0.03 on its own
    p = 0.26 across the 10 configurations tried on this window

Nothing is stored to do it.  A run already records its selection and its full
configuration, so the count is read back out of the runs themselves -- which
means the history already on disk counts too, rather than starting from zero
the day this shipped.

**Two honest limits**, both stated where the number is shown:

The combination is Sidak, ``1 - (1 - p)^k``, which assumes the configurations
are independent.  They are not: they are variations of one idea over one
stretch of data, and positively correlated tests overlap in when they fire.
The true family-wise figure is therefore *below* this one, so the number
errs toward caution rather than comfort.

And it counts only what was run through this tool against an overlapping
window.  Ideas discarded by eye before ever being run were draws too, and
nothing can see those.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from app.models.schemas import BacktestRequest


def configuration_key(request: BacktestRequest) -> str:
    """A stable digest of everything about a run that changes its answer.

    The selection is deliberately *not* part of it: the selection identifies
    the family of attempts, and the key distinguishes attempts within it.

    The lookback is folded in as a span rather than as its absolute bounds.
    The bounds move on their own as new candles arrive -- the same settings
    yield a different pair tomorrow -- and a key that changed overnight would
    quietly reset the count while the user changed nothing.  The span moves
    only when someone widens or narrows the search, which is a real fork.
    """

    search = request.search
    payload: dict[str, Any] = {
        "primary": request.primary_symbol,
        "symbols": sorted(request.symbols),
        "interval": request.interval,
        "trade": request.trade.model_dump(mode="json"),
        "detectors": request.detectors.model_dump(mode="json"),
        "search": {
            "span": max(0, search.lookback_end - search.lookback_start),
            "pattern_length": search.pattern_length,
            "maximum_matches": search.maximum_matches,
            "minimum_similarity": search.minimum_similarity,
            "minimum_separation_bars": search.minimum_separation_bars,
            "search_symbols": sorted(search.search_symbols or []),
        },
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:32]


def family_wise_probability(p_value: float, configurations: int) -> float:
    """Chance that *any* of ``configurations`` draws looks this good.

    Sidak: ``1 - (1 - p)^k``.  One run at p = 0.03 is a 3% result; ten
    independent runs at that threshold carry a 26% chance one of them clears
    it regardless of whether anything is there.

    Correlated configurations -- which these are -- make the real figure
    smaller than this, so the answer is an upper bound and never flatters.
    """

    if configurations <= 1:
        return p_value
    if p_value <= 0.0:
        return 0.0
    if p_value >= 1.0:
        return 1.0
    return 1.0 - (1.0 - p_value) ** configurations


def describe_configuration(payload: dict) -> str:
    """What made this run different, in a few words.

    The machine-readable counterpart is :func:`configuration_key`, which
    answers "is this the same attempt" and is deliberately unreadable.  This
    answers "which attempt was it" for a person reading a list of runs, where
    a dozen entries reading ``ES 1h - 28% win`` are worse than no list at all.

    Only the fields that actually vary between attempts appear, and anything
    left at its default is omitted -- a label that repeats the defaults on
    every row distinguishes nothing, which is the problem being solved.

    Reads the stored payload defensively rather than validating it: a run
    saved under an older shape of the request should still be nameable, and
    failing to parse one is not a reason to show nothing for it.
    """

    trade = payload.get("trade") or {}
    parts: list[str] = []

    direction = trade.get("direction")
    if direction in {"long", "short"}:
        parts.append(direction.capitalize())

    stop = _describe_level(
        trade.get("stop_loss_type"), trade.get("stop_loss_value"), risk_unit=False
    )
    target = _describe_level(
        trade.get("take_profit_type"), trade.get("take_profit_value"), risk_unit=True
    )
    if stop and target:
        parts.append(f"{stop} → {target}")
    elif stop or target:
        parts.append(stop or target)

    detectors = payload.get("detectors") or {}
    flags = [
        name
        for key, name in (
            ("require_fair_value_gap", "FVG"),
            ("require_smt_divergence", "SMT"),
            ("require_swing_point", "swing"),
            ("require_liquidity_sweep", "sweep"),
            ("gap_past_midpoint", "CE"),
        )
        if detectors.get(key)
    ]
    parts.extend(flags)

    learning = payload.get("learning") or {}
    if learning.get("enabled"):
        # Everything that changes what a fitted run *is*. A label is not a
        # settings dump, but these four are exactly what separates one fit
        # from another -- leave the split and the query count out and a row
        # of fitted runs goes back to being indistinguishable, which is the
        # problem this is here to solve.
        shape = "3w" if learning.get("grouped") else "7w"
        objective = "win" if learning.get("objective") == "win_rate" else "exp"
        detail = f"fitted {shape}/{objective}"
        queries = learning.get("query_samples")
        if isinstance(queries, int):
            detail += f" {queries}q"
        split = learning.get("train_fraction")
        if isinstance(split, (int, float)):
            detail += f"/{round(split * 100)}%"
        parts.append(detail)

    return " · ".join(parts) if parts else "default rules"


def _describe_level(kind: object, value: object, *, risk_unit: bool) -> str:
    """One side of the trade, in the unit it was actually expressed in."""

    if not isinstance(value, (int, float)):
        return ""
    number = f"{value:g}"
    if kind == "percentage":
        return f"{number}%"
    if kind == "atr_multiple":
        return f"{number}×ATR"
    if kind == "fixed_price":
        return f"@{number}"
    if kind == "risk_reward":
        return f"{number}R" if risk_unit else number
    if kind == "liquidity":
        # The number is a floor on the reward, not the target, so it reads as
        # a bound. Without this the whole mode rendered as a bare "2" -- and
        # the one job of a label is to tell two attempts apart.
        return f"liq ≥{number}R"
    return number
