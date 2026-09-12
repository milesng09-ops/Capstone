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
