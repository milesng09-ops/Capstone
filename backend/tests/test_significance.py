"""What a win rate means once it has an error bar and something to beat.

The distinction under test: a rate quoted alone, versus the same rate quoted
against what the identical rules paid at windows nobody chose.  Sixty percent
is a strong result against a thirty-three percent baseline and an unremarkable
one against a fifty-five percent baseline, and nothing in the number itself
says which.
"""

from __future__ import annotations

import math

import pytest

from app.analysis.liquidity import LiquidityPool
from app.analysis.structure import SwingPoint
from app.backtesting.significance import (
    baseline_inputs,
    baseline_seed,
    binomial_tail_probability,
    random_entry_baseline,
    summarise_baseline,
    wilson_interval,
)
from app.models.domain import Candle
from app.models.schemas import TradeRules

HOUR = 3_600_000
T0 = 1_780_000_000_000


def series(count: int, *, start: float = 100.0, drift: float = 0.0) -> list[Candle]:
    """A flat or gently drifting series with a constant bar range."""

    candles = []
    price = start
    for index in range(count):
        candles.append(
            Candle(
                symbol="ES",
                time=T0 + index * HOUR,
                open=price,
                high=price + 1.0,
                low=price - 1.0,
                close=price,
                volume=1_000,
            )
        )
        price += drift
    return candles


# --------------------------------------------------------------------------
class TestTheIntervalAroundAWinRate:
    def test_it_reports_the_span_a_small_sample_actually_supports(self):
        # The headline case: 60% of 25 is not 60%, it is 41% to 77%.
        low, high = wilson_interval(15, 25)
        assert (round(low), round(high)) == (41, 77)

    def test_it_never_runs_past_the_ends_of_the_scale(self):
        # The textbook Wald interval goes above 100% here; Wilson cannot.
        low, high = wilson_interval(25, 25)
        assert low >= 0.0
        assert high <= 100.0

        low, high = wilson_interval(0, 25)
        assert low >= 0.0
        assert high <= 100.0

    def test_more_trades_narrow_it(self):
        narrow = wilson_interval(120, 200)
        wide = wilson_interval(15, 25)
        assert (narrow[1] - narrow[0]) < (wide[1] - wide[0])

    def test_no_trades_is_not_an_interval(self):
        assert wilson_interval(0, 0) == (0.0, 0.0)


class TestWouldChanceHaveDoneThisWell:
    def test_a_strong_result_against_a_two_to_one_target_is_unlikely(self):
        # A 2:1 target pays about 1 in 3 by geometry alone, so 15 of 25 is a
        # long way from free.
        assert binomial_tail_probability(15, 25, 1 / 3) < 0.01

    def test_a_middling_result_against_the_same_target_is_not(self):
        assert binomial_tail_probability(9, 25, 1 / 3) > 0.4

    def test_it_is_a_probability(self):
        for successes in range(0, 26):
            value = binomial_tail_probability(successes, 25, 1 / 3)
            assert 0.0 <= value <= 1.0

    def test_it_falls_as_the_result_improves(self):
        values = [binomial_tail_probability(k, 25, 1 / 3) for k in range(1, 26)]
        assert values == sorted(values, reverse=True)

    def test_matching_the_baseline_exactly_is_unremarkable(self):
        # Winning at exactly the baseline rate should not look like evidence.
        assert binomial_tail_probability(10, 30, 1 / 3) > 0.4

    def test_the_whole_distribution_sums_to_one(self):
        total = sum(
            math.comb(20, k) * 0.4**k * 0.6 ** (20 - k) for k in range(0, 21)
        )
        assert total == pytest.approx(1.0)


# --------------------------------------------------------------------------
class TestTheBaselineDrawsFromTheSearchsOwnPool:
    RULES = TradeRules(maximum_holding_bars=10)

    def test_every_drawn_window_can_actually_be_simulated(self):
        candles = series(300)
        inputs = baseline_inputs(
            candles,
            window_length=20,
            exclude_ranges=[],
            required_future_bars=12,
            samples=200,
            seed=7,
        )
        assert len(inputs) == 200
        for item in inputs:
            assert item.start_index >= 0
            assert item.end_index == item.start_index + 19
            # Room left for the trade to play out, which is what the search
            # guarantees for a real match.
            assert item.end_index + 12 <= len(candles)

    def test_the_selection_itself_is_kept_out(self):
        candles = series(300)
        # Bars 100..140 by time, the way the search excludes them.
        excluded = (candles[100].time, candles[140].time)
        inputs = baseline_inputs(
            candles,
            window_length=20,
            exclude_ranges=[excluded],
            required_future_bars=12,
            samples=300,
            seed=7,
        )
        for item in inputs:
            window = (candles[item.start_index].time, candles[item.end_index].time)
            overlaps = window[0] <= excluded[1] and window[1] >= excluded[0]
            assert not overlaps

    def test_a_series_too_short_to_draw_from_yields_nothing(self):
        assert (
            baseline_inputs(
                series(10),
                window_length=20,
                exclude_ranges=[],
                required_future_bars=12,
                samples=50,
                seed=1,
            )
            == []
        )

    def test_the_same_query_reproduces_the_same_baseline(self):
        # The property the whole reference point rests on: a baseline that
        # moved between runs would not be one.
        candles = series(300)
        kwargs = dict(
            window_length=20,
            exclude_ranges=[],
            required_future_bars=12,
            samples=100,
            seed=baseline_seed("ES", "1h", 20),
        )
        first = random_entry_baseline(candles, self.RULES, **kwargs)
        second = random_entry_baseline(candles, self.RULES, **kwargs)
        assert first == second

    def test_a_different_query_draws_differently(self):
        candles = series(300)
        base = dict(
            window_length=20,
            exclude_ranges=[],
            required_future_bars=12,
            samples=100,
        )
        one = baseline_inputs(candles, seed=baseline_seed("ES", "1h", 20), **base)
        two = baseline_inputs(candles, seed=baseline_seed("NQ", "1h", 20), **base)
        assert [i.start_index for i in one] != [i.start_index for i in two]

    def test_the_sequencing_rule_does_not_thin_the_draw(self):
        """Random windows overlap heavily; the overlap rule must not apply.

        With it on, most draws would be discarded purely on draw order and
        the baseline's size would be an artefact of the shuffle.
        """

        candles = series(400, drift=0.05)
        strict = TradeRules(maximum_holding_bars=10, allow_overlapping_trades=False)
        baseline = random_entry_baseline(
            candles,
            strict,
            window_length=20,
            exclude_ranges=[],
            required_future_bars=12,
            samples=200,
            seed=3,
        )
        # Nearly all of them survive, rather than the handful a serialised
        # walk through 200 overlapping windows would leave.
        assert baseline.trades_executed > 150


class TestWhatTheBaselineReports:
    def test_an_empty_draw_reports_nothing_rather_than_zero_percent(self):
        baseline = summarise_baseline([], samples=500, seed=11)
        assert baseline.trades_executed == 0
        assert baseline.win_rate == 0.0
        assert baseline.seed == 11

    def test_a_rising_market_pays_a_long_more_than_a_flat_one(self):
        # Sanity that the baseline is measuring the series and not a constant.
        flat = random_entry_baseline(
            series(400),
            TradeRules(maximum_holding_bars=10),
            window_length=20,
            exclude_ranges=[],
            required_future_bars=12,
            samples=200,
            seed=5,
        )
        rising = random_entry_baseline(
            series(400, drift=0.4),
            TradeRules(maximum_holding_bars=10),
            window_length=20,
            exclude_ranges=[],
            required_future_bars=12,
            samples=200,
            seed=5,
        )
        assert rising.win_rate > flat.win_rate


class TestTheBaselineGetsTheSameTargets:
    """A baseline that cannot fail to be beaten is not a baseline.

    With a liquidity target the engine needs the shelves to aim at. Withhold
    them from the baseline and every random window is skipped for want of a
    target, which is reported as a win rate of zero -- the most flattering
    possible number to print beside a real result, and it silently removes
    the p-value the whole module exists to produce.
    """

    RULES = TradeRules(
        direction="long",
        entry_type="selection_close",
        stop_loss_type="percentage",
        stop_loss_value=2.0,
        take_profit_type="liquidity",
        take_profit_value=1.0,
        maximum_holding_bars=30,
        fee_percent=0.0,
        slippage_percent=0.0,
    )

    def series(self, count: int = 200) -> list[Candle]:
        # A steady climb, so an upside target is reachable from anywhere.
        return [
            Candle(
                symbol="NQ",
                time=T0 + index * HOUR,
                open=100.0 + index,
                high=100.5 + index,
                low=99.5 + index,
                close=100.0 + index,
                volume=100.0,
            )
            for index in range(count)
        ]

    def shelf(self, price: float) -> LiquidityPool:
        touch = SwingPoint(
            symbol="NQ",
            kind="high",
            index=0,
            time=T0,
            price=price,
            confirmed_time=T0,
            strength=2,
        )
        return LiquidityPool(
            symbol="NQ",
            kind="high",
            price=price,
            start_time=T0,
            end_time=T0,
            formed_time=T0,
            touches=(touch, touch),
            spread=0.0,
            spread_percent=0.0,
            swept=False,
            swept_time=None,
        )

    def run(self, pools):
        return random_entry_baseline(
            self.series(),
            self.RULES,
            window_length=5,
            exclude_ranges=[],
            required_future_bars=32,
            samples=40,
            seed=7,
            pools=pools,
        )

    def test_without_pools_the_baseline_is_empty(self):
        # Documents the failure rather than the fix: this is what the caller
        # gets if it forgets, and it does not look like an error.
        empty = self.run(None)
        assert empty.trades_executed == 0
        assert empty.win_rate == 0.0
        assert empty.samples > 0

    def test_with_pools_the_baseline_actually_trades(self):
        shelves = [self.shelf(price) for price in (150.0, 200.0, 260.0)]
        real = self.run(shelves)
        assert real.trades_executed > 0

    def test_the_two_are_not_the_same_answer(self):
        # The point of the regression: a forgotten argument changes the
        # reported baseline from a real rate to zero.
        shelves = [self.shelf(price) for price in (150.0, 200.0, 260.0)]
        assert self.run(shelves).trades_executed != self.run(None).trades_executed
