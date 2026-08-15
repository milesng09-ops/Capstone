"""Backtesting engine behaviour.

The detectors have their own suite; this one covers the simulation, where a
quiet off-by-one is far more damaging than a wrong pixel -- every number the
UI reports as a "win rate" is downstream of it.
"""

from __future__ import annotations

import pytest

from app.backtesting.engine import BacktestEngine, MatchInput, SimulatedTrade
from app.backtesting.metrics import compute_metrics
from app.models.domain import Candle
from app.models.schemas import TradeRules

HOUR_MS = 60 * 60 * 1000


def flat_series(count: int, price: float = 100.0) -> list[Candle]:
    """Candles that drift nowhere, so no stop or target is ever touched."""

    return [
        Candle(
            symbol="NQ",
            time=index * HOUR_MS,
            open=price,
            high=price + 0.01,
            low=price - 0.01,
            close=price,
            volume=100.0,
        )
        for index in range(count)
    ]


class TestHoldingBars:
    """``holding_bars`` must be measured on the same origin as the cap."""

    def test_selection_close_entry_respects_the_maximum(self):
        candles = flat_series(30)
        rules = TradeRules(
            entry_type="selection_close",
            maximum_holding_bars=3,
            stop_loss_type="percentage",
            stop_loss_value=50.0,
            take_profit_type="percentage",
            take_profit_value=50.0,
            fee_percent=0.0,
            slippage_percent=0.0,
        )
        trades, _ = BacktestEngine(candles, rules).run(
            [MatchInput(id="m1", start_index=0, end_index=4, similarity=1.0)]
        )

        assert len(trades) == 1
        assert trades[0].exit_reason == "timeout"
        # Previously reported 4: the scan started one bar after the entry
        # index, but the count began at the entry index.
        assert trades[0].holding_bars == 3

    def test_next_open_entry_respects_the_maximum(self):
        candles = flat_series(30)
        rules = TradeRules(
            entry_type="next_open",
            maximum_holding_bars=3,
            stop_loss_type="percentage",
            stop_loss_value=50.0,
            take_profit_type="percentage",
            take_profit_value=50.0,
            fee_percent=0.0,
            slippage_percent=0.0,
        )
        trades, _ = BacktestEngine(candles, rules).run(
            [MatchInput(id="m1", start_index=0, end_index=4, similarity=1.0)]
        )

        assert len(trades) == 1
        assert trades[0].holding_bars == 3

    def test_both_entry_types_agree_on_the_cap(self):
        """The reported hold must not depend on which entry style was chosen."""

        candles = flat_series(40)
        holds = []
        for entry_type in ("selection_close", "next_open"):
            rules = TradeRules(
                entry_type=entry_type,
                maximum_holding_bars=10,
                stop_loss_type="percentage",
                stop_loss_value=50.0,
                take_profit_type="percentage",
                take_profit_value=50.0,
                fee_percent=0.0,
                slippage_percent=0.0,
            )
            trades, _ = BacktestEngine(candles, rules).run(
                [MatchInput(id="m1", start_index=0, end_index=4, similarity=1.0)]
            )
            holds.append(trades[0].holding_bars)

        assert holds == [10, 10]


def trade(net: float, *, gross: float | None = None, index: int = 0) -> SimulatedTrade:
    """A trade stub carrying only the fields the metrics actually read."""

    return SimulatedTrade(
        pattern_match_id=f"m{index}",
        symbol="NQ",
        direction="long",
        entry_index=index,
        exit_index=index + 1,
        entry_time=index * HOUR_MS,
        exit_time=(index + 1) * HOUR_MS,
        entry_price=100.0,
        exit_price=100.0 + net,
        stop_price=95.0,
        target_price=110.0,
        gross_return=net if gross is None else gross,
        fees=0.0,
        net_return=net,
        exit_reason="take_profit" if net > 0 else "stop_loss",
        holding_bars=1,
        similarity_score=1.0,
        same_bar_ambiguity=False,
    )


class TestGrossAndNetAreComparable:
    def test_gross_is_compounded_not_summed(self):
        # Summed these are 20.0; compounded they are 21.0. Reporting one as a
        # sum and the other as a compounded total made the gap look like costs.
        trades = [trade(10.0, index=0), trade(10.0, index=1)]
        summary = compute_metrics(trades, total_matches=2, skipped_matches=0)

        assert summary.gross_return == pytest.approx(21.0)
        assert summary.net_return == pytest.approx(21.0)

    def test_the_gap_between_them_is_only_the_fees(self):
        trades = [
            trade(9.0, gross=10.0, index=0),
            trade(9.0, gross=10.0, index=1),
        ]
        summary = compute_metrics(trades, total_matches=2, skipped_matches=0)

        assert summary.gross_return == pytest.approx(21.0)
        assert summary.net_return == pytest.approx(18.81)
        assert summary.gross_return > summary.net_return


class TestExpectancy:
    def test_breakeven_trades_are_not_charged_an_average_loss(self):
        # One win, one loss, two flat. The flat trades must contribute zero,
        # not be swept into the losing side by ``1 - win_rate``.
        trades = [
            trade(10.0, index=0),
            trade(-10.0, index=1),
            trade(0.0, index=2),
            trade(0.0, index=3),
        ]
        summary = compute_metrics(trades, total_matches=4, skipped_matches=0)

        assert summary.breakeven == 2
        assert summary.expectancy == pytest.approx(0.0)

    def test_expectancy_agrees_with_the_average_trade(self):
        """The decomposition must reconcile with the plain mean."""

        trades = [
            trade(7.0, index=0),
            trade(-3.0, index=1),
            trade(0.0, index=2),
            trade(5.0, index=3),
        ]
        summary = compute_metrics(trades, total_matches=4, skipped_matches=0)

        assert summary.expectancy == pytest.approx(summary.average_return)


class TestProfitFactor:
    def test_is_undefined_when_nothing_lost(self):
        trades = [trade(5.0, index=0), trade(7.0, index=1)]
        summary = compute_metrics(trades, total_matches=2, skipped_matches=0)

        # Not 999.0, which rendered as a plausible measured value.
        assert summary.profit_factor is None

    def test_is_a_ratio_when_there_are_losses(self):
        trades = [trade(10.0, index=0), trade(-5.0, index=1)]
        summary = compute_metrics(trades, total_matches=2, skipped_matches=0)

        assert summary.profit_factor == pytest.approx(2.0)

    def test_is_undefined_with_no_trades_at_all(self):
        summary = compute_metrics([], total_matches=0, skipped_matches=0)
        assert summary.profit_factor is None
