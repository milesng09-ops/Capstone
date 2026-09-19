"""Tests for liquidity pool detection.

Series are hand-built and small enough that the expected shelf can be read off
the numbers.  The cases that matter most are the ones about *time*: a pool
that is reported before its last pivot confirmed, or a target chosen because
it was about to be swept, are both bugs that make a backtest look better than
the strategy is.
"""

from __future__ import annotations

import pytest

from app.analysis import find_swing_points
from app.analysis.liquidity import (
    find_liquidity_pools,
    maximal_pools,
    nearest_unswept_pool,
    pools_swept_before,
)
from app.models.domain import Candle

HOUR_MS = 3_600_000


def series(highs: list[float], lows: list[float] | None = None) -> list[Candle]:
    lows = lows if lows is not None else [high - 1 for high in highs]
    return [
        Candle(
            symbol="NQ",
            time=index * HOUR_MS,
            open=(high + low) / 2,
            high=high,
            low=low,
            close=(high + low) / 2,
            volume=100.0,
        )
        for index, (high, low) in enumerate(zip(highs, lows))
    ]


def pools(
    highs: list[float],
    lows: list[float] | None = None,
    *,
    strength: int = 1,
    **kwargs,
):
    candles = series(highs, lows)
    swings = find_swing_points(candles, strength=strength)
    return find_liquidity_pools(candles, swings, **kwargs)


# A shelf of two equal highs at 100, price never getting back above it.
# Pivots at index 1 and 5; with strength 1 they confirm at index 2 and 6.
EQUAL_HIGHS = [90, 100, 90, 85, 90, 100, 90, 88]


class TestDetection:
    def test_finds_a_shelf_of_equal_highs(self):
        found = pools(EQUAL_HIGHS)
        highs = [pool for pool in found if pool.kind == "high"]
        assert len(highs) == 1
        assert highs[0].price == 100
        assert highs[0].touch_count == 2

    def test_a_single_pivot_is_not_a_pool(self):
        # One peak, and nothing else near it.
        found = pools([90, 100, 90, 80, 70, 60, 50, 40])
        assert [pool for pool in found if pool.kind == "high"] == []

    def test_finds_a_shelf_of_equal_lows(self):
        # Mirror image: two troughs at 10 with a bounce between them.
        found = pools(
            [30, 20, 30, 35, 30, 20, 30, 32],
            lows=[25, 10, 25, 30, 25, 10, 25, 28],
        )
        lows = [pool for pool in found if pool.kind == "low"]
        assert len(lows) == 1
        assert lows[0].price == 10
        assert lows[0].touch_count == 2

    def test_the_level_is_the_extreme_not_the_average(self):
        # 100 and 100.02 are within the default tolerance, so they are one
        # shelf -- and the shelf sits at the higher of them, because clearing
        # 100.01 would leave the orders above 100.02 untouched.
        found = pools([90, 100.0, 90, 85, 90, 100.02, 90, 88])
        high = next(pool for pool in found if pool.kind == "high")
        assert high.price == 100.02

    def test_pivots_too_far_apart_are_separate_levels(self):
        # 100 and 105 are 5% apart; nothing merges them.
        found = pools([90, 100, 90, 85, 90, 105, 90, 88])
        assert [pool for pool in found if pool.kind == "high"] == []

    def test_tolerance_scales_with_price(self):
        # The same absolute gap of 0.02: a shelf at 100, two levels at 1.
        wide = pools([90, 100.0, 90, 85, 90, 100.02, 90, 88])
        assert len([pool for pool in wide if pool.kind == "high"]) == 1

        tight = pools(
            [0.9, 1.0, 0.9, 0.85, 0.9, 1.02, 0.9, 0.88],
            lows=[0.8, 0.85, 0.8, 0.75, 0.8, 0.85, 0.8, 0.78],
        )
        assert [pool for pool in tight if pool.kind == "high"] == []

    def test_does_not_chain_a_drifting_sequence(self):
        # Each step is inside the tolerance of the one before it, but the ends
        # are not the same level.  Testing against the anchor stops the
        # cluster from creeping.
        found = pools(
            [90, 100.00, 90, 85, 90, 100.02, 90, 85, 90, 100.04, 90, 85, 90, 100.06, 90, 88],
            tolerance_percent=0.021,
        )
        highs = [pool for pool in found if pool.kind == "high"]
        # 100.00 and 100.02 group; 100.04 opens a new cluster and takes 100.06.
        assert [pool.price for pool in highs] == [100.02, 100.06]

    def test_min_touches_must_be_at_least_two(self):
        with pytest.raises(ValueError):
            pools(EQUAL_HIGHS, min_touches=1)

    def test_rejects_a_negative_tolerance(self):
        with pytest.raises(ValueError):
            pools(EQUAL_HIGHS, tolerance_percent=-1)

    def test_empty_input_is_not_an_error(self):
        assert find_liquidity_pools([], []) == []


class TestSweep:
    def test_a_pool_price_trades_through_is_swept(self):
        # Same shelf at 100, then a candle to 105.
        found = pools(EQUAL_HIGHS + [105])
        high = next(pool for pool in found if pool.kind == "high")
        assert high.swept is True
        assert high.swept_time == 8 * HOUR_MS

    def test_touching_the_level_again_is_not_a_sweep(self):
        # Back to exactly 100: another touch, not a clearing of the shelf.
        found = pools(EQUAL_HIGHS + [100])
        high = next(pool for pool in found if pool.kind == "high")
        assert high.swept is False
        assert high.swept_time is None

    def test_a_low_pool_is_swept_downwards(self):
        found = pools(
            [30, 20, 30, 35, 30, 20, 30, 32, 30],
            lows=[25, 10, 25, 30, 25, 10, 25, 28, 5],
        )
        low = next(pool for pool in found if pool.kind == "low")
        assert low.swept is True
        assert low.swept_time == 8 * HOUR_MS

    def test_the_detector_never_filters_swept_shelves_out(self):
        # "Already taken" is a statement about the end of the series, so it is
        # a fact about the future of every entry in it. The detector reports
        # the sweep and its time; deciding what to do with that is the
        # caller's, and a caller that has to answer as of a moment cannot be
        # handed a list already filtered by hindsight.
        found = pools(EQUAL_HIGHS + [105])
        highs = [pool for pool in found if pool.kind == "high"]
        assert len(highs) == 1
        assert highs[0].swept is True


class TestKnowability:
    def test_forms_when_the_last_pivot_confirms(self):
        # Peaks at index 2 and 8.  With strength 2 the second confirms at
        # index 10, and that -- not index 8 -- is when the shelf exists.
        found = pools(
            [80, 85, 100, 85, 80, 75, 80, 85, 100, 85, 80, 75],
            strength=2,
        )
        high = next(pool for pool in found if pool.kind == "high")
        assert high.end_time == 8 * HOUR_MS
        assert high.formed_time == 10 * HOUR_MS

    def test_start_time_is_the_first_pivot(self):
        found = pools(EQUAL_HIGHS)
        high = next(pool for pool in found if pool.kind == "high")
        assert high.start_time == 1 * HOUR_MS
        assert high.end_time == 5 * HOUR_MS


class TestSweptBefore:
    def test_finds_a_sweep_that_has_already_happened(self):
        found = pools(EQUAL_HIGHS + [105, 95])
        swept = pools_swept_before(found, "high", 9 * HOUR_MS)
        assert len(swept) == 1
        assert swept[0].swept_time == 8 * HOUR_MS

    def test_ignores_a_sweep_still_in_the_future(self):
        found = pools(EQUAL_HIGHS + [105, 95])
        assert pools_swept_before(found, "high", 7 * HOUR_MS) == []

    def test_the_window_is_measured_from_the_sweep(self):
        found = pools(EQUAL_HIGHS + [105, 95, 95, 95])
        # Swept at hour 8, asked at hour 11: three hours ago.
        assert pools_swept_before(found, "high", 11 * HOUR_MS, within_ms=4 * HOUR_MS)
        assert pools_swept_before(found, "high", 11 * HOUR_MS, within_ms=2 * HOUR_MS) == []


class TestNearestUnswept:
    def test_picks_the_nearer_of_two_shelves_above(self):
        # Shelf at 120 first (peaks 1 and 5), then price steps down and builds
        # a second at 100 (peaks 9 and 11).  Both still stand: nothing traded
        # above either after it formed.
        found = pools(
            [110, 120, 110, 105, 110, 120, 110, 105, 95, 100, 95, 100, 95, 90],
        )
        assert sorted(pool.price for pool in found if pool.kind == "high") == [100, 120]

        target = nearest_unswept_pool(found, "high", price=95, time=13 * HOUR_MS)
        assert target is not None
        assert target.price == 100

    def test_ignores_a_shelf_behind_the_entry(self):
        found = pools(EQUAL_HIGHS)
        # Entry above the shelf: there is nothing in front of a long here.
        assert nearest_unswept_pool(found, "high", price=105, time=7 * HOUR_MS) is None

    def test_ignores_a_shelf_that_has_not_formed_yet(self):
        found = pools(EQUAL_HIGHS)
        high = next(pool for pool in found if pool.kind == "high")
        before = high.formed_time - 1
        assert nearest_unswept_pool(found, "high", price=95, time=before) is None
        assert nearest_unswept_pool(found, "high", price=95, time=high.formed_time) is not None

    def test_a_shelf_swept_later_is_still_a_target_now(self):
        # This is the hindsight case.  The shelf is taken at hour 8; asked at
        # hour 7 it must still be offered, or the engine would only ever aim
        # at levels it already knows get hit.
        found = pools(EQUAL_HIGHS + [105])
        target = nearest_unswept_pool(found, "high", price=95, time=7 * HOUR_MS)
        assert target is not None
        assert target.price == 100

    def test_a_shelf_already_swept_is_not_a_target(self):
        found = pools(EQUAL_HIGHS + [105, 95])
        assert nearest_unswept_pool(found, "high", price=95, time=9 * HOUR_MS) is None


class TestEverySizeAShelfHasBeen:
    """A level that had held twice on Tuesday was usable on Tuesday.

    Reporting only the size a shelf finished at would hide it from every
    question asked before its last pivot -- so a candle on Friday would decide
    whether Tuesday's trade was taken. The bias ran the safe way, hiding
    levels rather than inventing them, but it was not random: it dropped
    exactly the cases where price came back and re-pivoted at the target.
    """

    # Three peaks at ~100: pivots at index 1, 5 and 9 with strength 1.
    THREE_TOUCHES = [90, 100.0, 90, 85, 90, 100.01, 90, 85, 90, 100.02, 90, 88]

    def test_a_three_touch_shelf_is_also_reported_as_a_two_touch_one(self):
        highs = [pool for pool in pools(self.THREE_TOUCHES) if pool.kind == "high"]
        assert sorted(pool.touch_count for pool in highs) == [2, 3]

    def test_each_size_carries_its_own_moment_and_its_own_level(self):
        highs = [pool for pool in pools(self.THREE_TOUCHES) if pool.kind == "high"]
        two = next(pool for pool in highs if pool.touch_count == 2)
        three = next(pool for pool in highs if pool.touch_count == 3)

        # The smaller shelf was knowable earlier and sat lower: its extreme is
        # taken over the pivots it actually had.
        assert two.formed_time < three.formed_time
        assert two.price < three.price

    def test_the_earlier_size_answers_a_question_asked_before_the_last_pivot(self):
        found = pools(self.THREE_TOUCHES)
        two = next(
            pool for pool in found if pool.kind == "high" and pool.touch_count == 2
        )
        # At this moment the third pivot has not confirmed. The shelf is still
        # a target, and before this fix it was invisible.
        target = nearest_unswept_pool(
            found, "high", price=95, time=two.formed_time
        )
        assert target is not None
        assert target.touch_count == 2

    def test_a_shelf_of_exactly_min_touches_is_reported_once(self):
        highs = [pool for pool in pools(EQUAL_HIGHS) if pool.kind == "high"]
        assert len(highs) == 1


class TestMaximalPools:
    """Display wants one line per level, not one per size it has been."""

    def test_collapses_the_sizes_to_the_largest(self):
        found = pools(TestEverySizeAShelfHasBeen.THREE_TOUCHES)
        shelves = [pool for pool in maximal_pools(found) if pool.kind == "high"]
        assert len(shelves) == 1
        assert shelves[0].touch_count == 3

    def test_keeps_distinct_levels_apart(self):
        found = pools(
            [110, 120, 110, 105, 110, 120, 110, 105, 95, 100, 95, 100, 95, 90],
        )
        shelves = [pool for pool in maximal_pools(found) if pool.kind == "high"]
        assert sorted(pool.price for pool in shelves) == [100, 120]

    def test_an_empty_list_stays_empty(self):
        assert maximal_pools([]) == []
