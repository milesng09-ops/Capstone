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

from app.backtesting.engine import ASSUMPTIONS, SimulatedTrade
from app.models.schemas import BacktestSummary, EquityPoint

#: Below this many trades the sample is too small to draw conclusions from.
MINIMUM_SAMPLE_SIZE = 20

STARTING_EQUITY = 100.0


def compute_metrics(
    trades: list[SimulatedTrade],
    *,
    total_matches: int,
    skipped_matches: int,
    data_quality: list[str] | None = None,
    extra_assumptions: list[str] | None = None,
) -> BacktestSummary:
    assumptions = list(ASSUMPTIONS) + list(extra_assumptions or [])

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
            sample_size_warning=(
                "No trades were simulated. Loosen the similarity threshold, widen the "
                "lookback range, or check that the trade rules are valid."
            ),
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
