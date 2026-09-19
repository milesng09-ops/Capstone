"""Is a win rate distinguishable from the same rules applied at random?

A backtest here reports something like "60% of 25 trades won".  On its own
that number cannot be acted on, for two reasons this module addresses.

**It has no error bar.**  Fifteen wins in twenty-five is 60%, but the 95%
interval around it runs from 41% to 77%.  Quoting the midpoint alone implies
a precision twenty-five trades cannot carry.

**It has no reference point.**  A win rate is meaningless without knowing what
the same rules would have produced anyway.  Take profit at twice the risk and
a driftless market pays out roughly one time in three, purely from the
geometry of which level is touched first -- so 60% and 33% are both "normal"
depending on the target, and neither number says which it is.

The reference point used here is empirical rather than theoretical: the same
trade rules, on the same candles, at windows drawn **uniformly at random from
the candidate pool the similarity search itself ranked**.  Same data, same
costs, same stop and target, same opportunity set -- the single difference is
that windows are chosen by chance instead of by resemblance.  Whatever is left
between the two is what the resemblance was worth.

The baseline is seeded from the query, so re-running a backtest reproduces its
baseline exactly.  That matters as much here as it does in the pattern search:
a reference point that moves on every run is not a reference point.

What this does **not** do, and what the assumptions list says out loud: it
cannot correct for the setup having been chosen by eye from a chart whose
future was already visible, and it cannot correct for the tenth configuration
tried on the same window.  Both inflate any edge that is found.  The p-value
here answers one narrow question -- *would chance alone produce a result this
good?* -- and that is all it should be read as answering.
"""

from __future__ import annotations

import hashlib
import logging
import math
from dataclasses import dataclass

import numpy as np

from app.analysis.liquidity import LiquidityPool
from app.backtesting.engine import BacktestEngine, MatchInput, SimulatedTrade
from app.models.domain import Candle
from app.models.schemas import TradeRules

logger = logging.getLogger(__name__)

#: Two-sided 95% normal quantile, the conventional interval width.
Z_95 = 1.959963984540054

#: Random windows drawn per backtest.  Large enough that the baseline's own
#: sampling error is small beside the observed sample's -- at 500 draws the
#: baseline rate is pinned to about +/-4 points, against +/-18 for twenty-five
#: observed trades -- and small enough to stay well inside one request.
DEFAULT_BASELINE_SAMPLES = 500

#: How many extra windows to draw when detector conditions are in force.
#: Conditions reject most windows by design -- an unfilled gap containing the
#: entry is uncommon -- so drawing the nominal number and filtering would
#: leave a baseline of a handful of trades, too noisy to read anything
#: against. Drawing wide and keeping the first `samples` that qualify holds
#: the baseline's precision roughly where it is without conditions.
BASELINE_OVERSAMPLE = 12


@dataclass(frozen=True)
class Baseline:
    """What the same rules did at windows nobody chose."""

    samples: int
    trades_executed: int
    wins: int
    win_rate: float
    average_return: float
    expectancy: float
    seed: int


def wilson_interval(
    successes: int, trials: int, *, z: float = Z_95
) -> tuple[float, float]:
    """A 95% confidence interval for a proportion, as percentages.

    Wilson rather than the textbook ``p +/- z*sqrt(p(1-p)/n)``.  That formula
    is the one most people reach for and it fails in exactly the conditions
    this tool operates in: at twenty-odd trades, or at a win rate near 0% or
    100%, it produces intervals that run past the ends of the scale and cover
    the true value far less often than it claims.  Wilson stays inside [0, 1]
    and holds its coverage at small samples, which is the whole regime here.
    """

    if trials <= 0:
        return (0.0, 0.0)

    proportion = successes / trials
    denominator = 1.0 + z * z / trials
    centre = (proportion + z * z / (2 * trials)) / denominator
    spread = (
        z
        * math.sqrt(proportion * (1 - proportion) / trials + z * z / (4 * trials * trials))
        / denominator
    )
    low = max(0.0, centre - spread)
    high = min(1.0, centre + spread)
    return (round(low * 100, 2), round(high * 100, 2))


def binomial_tail_probability(successes: int, trials: int, probability: float) -> float:
    """``P(X >= successes)`` for ``trials`` independent wins at ``probability``.

    Computed exactly with :func:`math.comb` rather than approximated.  The
    trial count is bounded by the match limit -- a few hundred at most -- so
    the exact sum is cheap, and a normal approximation is least reliable at
    precisely the small samples this tool reports.
    """

    if trials <= 0:
        return 1.0
    if successes <= 0:
        return 1.0
    if successes > trials:
        return 0.0
    if probability <= 0.0:
        return 0.0
    if probability >= 1.0:
        return 1.0

    total = 0.0
    for count in range(successes, trials + 1):
        total += (
            math.comb(trials, count)
            * probability**count
            * (1.0 - probability) ** (trials - count)
        )
    return min(1.0, max(0.0, total))


def baseline_seed(*parts: object) -> int:
    """A stable seed derived from the query, so a rerun reproduces the draw."""

    payload = "|".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


def random_entry_baseline(
    candles: list[Candle],
    rules: TradeRules,
    *,
    window_length: int,
    exclude_ranges: list[tuple[int, int]],
    required_future_bars: int,
    samples: int,
    seed: int,
    pools: list[LiquidityPool] | None = None,
) -> Baseline:
    """Run ``rules`` at ``samples`` windows drawn at random from the same pool.

    The pool is every window the similarity search was allowed to rank: any
    start index with a full window behind it and enough bars ahead to simulate
    the trade, minus the selection itself.  Drawing from a different pool --
    the whole series, say, or only recent history -- would make the comparison
    measure the pool difference rather than the resemblance.

    ``exclude_ranges`` are **timestamps**, the same units and the same overlap
    test :func:`~app.services.pattern_service.find_similar_windows` applies, so
    the two pools cannot drift apart through a unit mismatch at the call site.

    Overlap between draws is deliberately allowed, and the rules are copied
    with ``allow_overlapping_trades`` forced on to guarantee it.  The engine's
    sequencing rule drops any trade opening before the previous one closed,
    which is right for a portfolio walked forward through selected matches and
    wrong here: five hundred windows drawn at random from one series overlap
    heavily, so the rule would discard most of them purely on draw order and
    leave a baseline whose size and value were an artefact of the shuffle.

    The baseline is a per-entry estimate -- what an arbitrary entry pays --
    and win rate is a per-entry statistic on both sides of the comparison, so
    forcing the rule off keeps the two measuring the same thing.
    """

    trades = run_baseline(
        candles,
        rules,
        baseline_inputs(
            candles,
            window_length=window_length,
            exclude_ranges=exclude_ranges,
            required_future_bars=required_future_bars,
            samples=samples,
            seed=seed,
        ),
        pools=pools,
    )
    return summarise_baseline(trades, samples=samples, seed=seed)


def baseline_inputs(
    candles: list[Candle],
    *,
    window_length: int,
    exclude_ranges: list[tuple[int, int]],
    required_future_bars: int,
    samples: int,
    seed: int,
) -> list[MatchInput]:
    """Draw ``samples`` window positions uniformly from the eligible pool.

    Eligibility is spelled the way the search spells it: a full window behind
    the start, ``required_future_bars`` ahead of the end, and no overlap with
    an excluded time range.
    """

    total = len(candles)
    last_start = total - window_length - required_future_bars
    if total <= 0 or window_length <= 0 or last_start < 0 or samples <= 0:
        return []

    blocked = _blocked_starts(candles, exclude_ranges, window_length, last_start)
    allowed = [start for start in range(last_start + 1) if start not in blocked]
    if not allowed:
        return []

    rng = np.random.default_rng(seed)
    draws = rng.integers(0, len(allowed), size=samples)

    return [
        MatchInput(
            id=f"baseline-{index}",
            start_index=allowed[int(draw)],
            end_index=allowed[int(draw)] + window_length - 1,
            # Nothing was matched, so there is no similarity to report. Zero
            # says that honestly; a made-up score would flow into any metric
            # that weights by it.
            similarity=0.0,
        )
        for index, draw in enumerate(draws)
    ]


def run_baseline(
    candles: list[Candle],
    rules: TradeRules,
    inputs: list[MatchInput],
    pools: list[LiquidityPool] | None = None,
) -> list[SimulatedTrade]:
    """Simulate drawn windows with the sequencing rule forced off.

    ``pools`` must be the same shelves the real run was given whenever the
    rules use a liquidity target.  Withholding them does not make the
    comparison stricter, it empties it: every random window is skipped for
    want of a target, and a baseline of nothing is reported as a win rate of
    zero -- which reads as "random entries never work here" beside a real
    result, and is the most flattering possible thing to print next to a
    strategy.  A baseline that cannot fail to be beaten is not a baseline.
    """

    engine = BacktestEngine(
        candles,
        rules.model_copy(update={"allow_overlapping_trades": True}),
        pools=pools,
    )
    trades, skipped = engine.run(inputs)
    if skipped:
        logger.debug("Baseline skipped %d of %d random windows", len(skipped), len(inputs))
    return trades


def summarise_baseline(
    trades: list[SimulatedTrade], *, samples: int, seed: int
) -> Baseline:
    """Reduce baseline trades to the figures the summary reports.

    Kept separate from the drawing so trades from several symbols can be
    pooled before being reduced: the real matches are ranked across every
    searched symbol, so a baseline drawn from only one of them would not be
    the same opportunity set.
    """

    if not trades:
        return Baseline(samples, 0, 0, 0.0, 0.0, 0.0, seed)

    wins = sum(1 for trade in trades if trade.net_return > 0)
    returns = [trade.net_return for trade in trades]
    losers = [value for value in returns if value < 0]
    winners = [value for value in returns if value > 0]

    loss_rate = len(losers) / len(trades)
    average_winner = sum(winners) / len(winners) if winners else 0.0
    average_loser = sum(losers) / len(losers) if losers else 0.0

    return Baseline(
        samples=samples,
        trades_executed=len(trades),
        wins=wins,
        win_rate=round(wins / len(trades) * 100.0, 4),
        average_return=round(sum(returns) / len(returns), 4),
        # Same shape as the observed expectancy in `metrics`, so the two are
        # read off the same scale.
        expectancy=round(
            (wins / len(trades)) * average_winner + loss_rate * average_loser, 4
        ),
        seed=seed,
    )


def _blocked_starts(
    candles: list[Candle],
    exclude_ranges: list[tuple[int, int]],
    window_length: int,
    last_start: int,
) -> set[int]:
    """Start indices whose window overlaps an excluded time range.

    The selection is excluded from the baseline for the same reason the search
    excludes it: a window containing the bars the setup was drawn from is not
    an independent sample of anything.

    The predicate is the search's, spelled the same way -- a window overlaps
    when it starts at or before the range ends and ends at or after the range
    begins.
    """

    blocked: set[int] = set()
    if not exclude_ranges:
        return blocked

    for start_index in range(last_start + 1):
        window_start = candles[start_index].time
        window_end = candles[start_index + window_length - 1].time
        for range_start, range_end in exclude_ranges:
            if window_start <= range_end and window_end >= range_start:
                blocked.add(start_index)
                break
    return blocked
