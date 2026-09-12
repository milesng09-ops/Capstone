"""Performance metrics for a completed backtest.

All returns are percentages of the entry price.  The equity curve compounds
them at 1 unit of risk per trade starting from 100, which is what maximum
drawdown is measured against.

**Gross and net are both compounded.**  They are displayed side by side, so
they have to be the same kind of number: if gross were a plain sum and net a
compounded total, the gap between them would read as trading costs when most
of it was really just compounding.  Computing both the same way means the
difference is exactly what the fees did.
"""

from __future__ import annotations

import statistics

from app.backtesting.attempts import family_wise_probability
from app.backtesting.engine import ASSUMPTIONS, SimulatedTrade
from app.backtesting.significance import (
    Baseline,
    binomial_tail_probability,
    wilson_interval,
)
from app.models.schemas import BacktestSummary, BaselineSummary, EquityPoint

#: Below this many trades the sample is too small to draw conclusions from.
MINIMUM_SAMPLE_SIZE = 20

STARTING_EQUITY = 100.0

#: Added whenever a baseline was drawn. The p-value is the narrow answer to
#: "would chance do this well"; these are the two things it cannot answer, and
#: both push a result in the flattering direction.
BASELINE_ASSUMPTIONS: list[str] = [
    "The baseline runs the same rules at windows drawn at random from the same "
    "candidate pool, so the gap between it and the result is what the "
    "similarity search contributed.",
    "Neither the interval nor the p-value corrects for the setup having been "
    "chosen by eye from a chart whose outcome was already visible, nor for "
    "repeated configurations tried against the same selection. Both inflate "
    "any edge found.",
]


def compute_metrics(
    trades: list[SimulatedTrade],
    *,
    total_matches: int,
    skipped_matches: int,
    data_quality: list[str] | None = None,
    extra_assumptions: list[str] | None = None,
    baseline: Baseline | None = None,
    condition_filtered_matches: int = 0,
    conditions_applied: list[str] | None = None,
    configurations_tried: int = 1,
    learned_weights=None,
) -> BacktestSummary:
    assumptions = list(ASSUMPTIONS) + list(extra_assumptions or [])
    assumptions.extend(conditions_applied or [])
    if baseline is not None and baseline.trades_executed:
        assumptions.extend(BASELINE_ASSUMPTIONS)

    if not trades:
        return BacktestSummary(
            total_matches=total_matches,
            trades_executed=0,
            skipped_matches=skipped_matches,
            wins=0,
            losses=0,
            breakeven=0,
            timeouts=0,
            win_rate=0.0,
            gross_return=0.0,
            net_return=0.0,
            average_return=0.0,
            median_return=0.0,
            average_winner=0.0,
            average_loser=0.0,
            risk_reward_achieved=0.0,
            profit_factor=None,
            expectancy=0.0,
            maximum_drawdown=0.0,
            longest_winning_streak=0,
            longest_losing_streak=0,
            average_holding_bars=0.0,
            sample_size_warning=_nothing_traded_reason(
                total_matches, condition_filtered_matches
            ),
            win_rate_low=0.0,
            win_rate_high=0.0,
            baseline=_baseline_out(baseline),
            baseline_p_value=None,
            configurations_tried=configurations_tried,
            family_wise_p_value=None,
            learned_weights=learned_weights,
            condition_filtered_matches=condition_filtered_matches,
            conditions_applied=list(conditions_applied or []),
            same_bar_ambiguity_count=0,
            equity_curve=[],
            assumptions=assumptions,
            data_quality=list(data_quality or []),
        )

    net_returns = [trade.net_return for trade in trades]
    gross_returns = [trade.gross_return for trade in trades]

    winners = [value for value in net_returns if value > 0]
    losers = [value for value in net_returns if value < 0]
    breakeven = len(net_returns) - len(winners) - len(losers)

    equity_curve, maximum_drawdown = _equity_curve(trades)

    gross_profit = sum(winners)
    gross_loss = abs(sum(losers))
    # No losing trades means the ratio is undefined, not enormous. A sentinel
    # like 999 renders as a plausible number and quietly reads as a result.
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None

    win_rate = len(winners) / len(trades) * 100.0
    loss_rate = len(losers) / len(trades)
    average_winner = statistics.fmean(winners) if winners else 0.0
    average_loser = statistics.fmean(losers) if losers else 0.0
    # Weighted by the share of trades that actually lost. Using ``1 - win_rate``
    # swept breakeven trades into the losing bucket and charged each of them an
    # average loss, understating expectancy whenever any trade closed flat.
    expectancy = (win_rate / 100.0) * average_winner + loss_rate * average_loser
    risk_reward = abs(average_winner / average_loser) if average_loser else 0.0

    warning = None
    if len(trades) < MINIMUM_SAMPLE_SIZE:
        warning = (
            f"Only {len(trades)} trades were simulated. Fewer than {MINIMUM_SAMPLE_SIZE} "
            "trades is not a statistically meaningful sample -- treat these metrics as "
            "indicative only."
        )

    low, high = wilson_interval(len(winners), len(trades))
    p_value = None
    if baseline is not None and baseline.trades_executed:
        p_value = round(
            binomial_tail_probability(
                len(winners), len(trades), baseline.win_rate / 100.0
            ),
            6,
        )

    family_wise = (
        round(family_wise_probability(p_value, configurations_tried), 6)
        if p_value is not None
        else None
    )
    if learned_weights is not None:
        assumptions.append(
            "The similarity weights were fitted on the earlier part of the lookback, and "
            "that stretch is excluded from the matches reported here -- so this result is "
            "measured out of sample. A fit that only memorised its training half shows up "
            "as no better than the hand-set weights, which is the point of splitting."
        )
    if configurations_tried > 1:
        assumptions.append(
            f"{configurations_tried} distinct configurations have been run against this "
            "window. The single-test p-value does not account for that; the family-wise "
            "figure beside it does, treating them as independent, which they are not -- "
            "so the real number is lower than shown. Ideas discarded before being run "
            "were attempts too, and nothing can count those."
        )

    return BacktestSummary(
        total_matches=total_matches,
        trades_executed=len(trades),
        skipped_matches=skipped_matches,
        wins=len(winners),
        losses=len(losers),
        breakeven=breakeven,
        timeouts=sum(1 for trade in trades if trade.exit_reason == "timeout"),
        win_rate=round(win_rate, 4),
        gross_return=round(_compound(gross_returns), 4),
        net_return=round(equity_curve[-1].equity - STARTING_EQUITY, 4),
        average_return=round(statistics.fmean(net_returns), 4),
        median_return=round(statistics.median(net_returns), 4),
        average_winner=round(average_winner, 4),
        average_loser=round(average_loser, 4),
        risk_reward_achieved=round(risk_reward, 4),
        expectancy=round(expectancy, 4),
        profit_factor=round(profit_factor, 4) if profit_factor is not None else None,
        maximum_drawdown=round(maximum_drawdown, 4),
        longest_winning_streak=_longest_streak(net_returns, positive=True),
        longest_losing_streak=_longest_streak(net_returns, positive=False),
        average_holding_bars=round(
            statistics.fmean([trade.holding_bars for trade in trades]), 2
        ),
        win_rate_low=low,
        win_rate_high=high,
        baseline=_baseline_out(baseline),
        baseline_p_value=p_value,
        configurations_tried=configurations_tried,
        family_wise_p_value=family_wise,
        learned_weights=learned_weights,
        condition_filtered_matches=condition_filtered_matches,
        conditions_applied=list(conditions_applied or []),
        sample_size_warning=warning,
        same_bar_ambiguity_count=sum(1 for trade in trades if trade.same_bar_ambiguity),
        equity_curve=equity_curve,
        assumptions=assumptions,
        data_quality=list(data_quality or []),
    )


def _compound(returns: list[float]) -> float:
    """Total percent change from compounding ``returns`` one after another.

    The same arithmetic the equity curve uses, so gross and net are directly
    comparable rather than one being a sum and the other a compounded total.
    """

    equity = STARTING_EQUITY
    for value in returns:
        equity *= 1.0 + value / 100.0
    return equity - STARTING_EQUITY


def _equity_curve(trades: list[SimulatedTrade]) -> tuple[list[EquityPoint], float]:
    equity = STARTING_EQUITY
    peak = STARTING_EQUITY
    max_drawdown = 0.0
    points: list[EquityPoint] = []

    for number, trade in enumerate(trades, start=1):
        equity *= 1.0 + trade.net_return / 100.0
        peak = max(peak, equity)
        drawdown = (equity - peak) / peak * 100.0 if peak > 0 else 0.0
        max_drawdown = min(max_drawdown, drawdown)
        points.append(
            EquityPoint(
                trade_number=number,
                time=trade.exit_time,
                equity=round(equity, 6),
                drawdown=round(drawdown, 6),
            )
        )

    return points, abs(max_drawdown)


def _longest_streak(values: list[float], *, positive: bool) -> int:
    longest = 0
    current = 0
    for value in values:
        matches = value > 0 if positive else value < 0
        current = current + 1 if matches else 0
        longest = max(longest, current)
    return longest


def _baseline_out(baseline: Baseline | None) -> BaselineSummary | None:
    if baseline is None or not baseline.trades_executed:
        return None
    return BaselineSummary(
        samples=baseline.samples,
        trades_executed=baseline.trades_executed,
        win_rate=baseline.win_rate,
        average_return=baseline.average_return,
        expectancy=baseline.expectancy,
        seed=baseline.seed,
    )


def _nothing_traded_reason(total_matches: int, condition_filtered: int) -> str:
    """Why the run is empty, in terms of the thing that actually emptied it.

    An empty result has more than one cause and they want opposite responses.
    Advising a wider lookback while every match was in fact found and then
    dropped by a detector condition sends the user to change a setting that
    was never the problem -- the same misdirection as telling someone their
    range holds no candles when a provider quota was draining.
    """

    if condition_filtered and condition_filtered >= total_matches:
        return (
            f"All {total_matches} matching windows were found, then dropped because none "
            "met the detector conditions. This is a statement about the conditions, not "
            "about the setup: relax one, widen the bars they look back over, or turn off "
            "direction alignment."
        )
    if condition_filtered:
        return (
            f"{condition_filtered} of {total_matches} matches were dropped by the detector "
            "conditions, and the rest could not be simulated. Relax a condition, or check "
            "that the trade rules are valid."
        )
    return (
        "No trades were simulated. Loosen the similarity threshold, widen the "
        "lookback range, or check that the trade rules are valid."
    )
