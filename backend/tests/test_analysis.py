"""Tests for the ICT detectors.

Each case is a hand-built series small enough that the expected answer can be
read off the numbers, so a failure points at the rule that broke rather than
at a statistical drift.
"""

from __future__ import annotations

import pytest

from app.analysis import (
    find_fair_value_gaps,
    find_smt_divergences,
    find_swing_points,
)
from app.models.domain import Candle

HOUR_MS = 3_600_000


def series(symbol: str, highs: list[float], lows: list[float] | None = None) -> list[Candle]:
    """Build candles from highs; lows default to one point below each high."""

    lows = lows if lows is not None else [high - 1 for high in highs]
    return [
        Candle(
            symbol=symbol,
            time=index * HOUR_MS,
            open=(high + low) / 2,
            high=high,
            low=low,
            close=(high + low) / 2,
            volume=100.0,
        )
        for index, (high, low) in enumerate(zip(highs, lows))
    ]


# --------------------------------------------------------------------------
# Swing points
# --------------------------------------------------------------------------
class TestSwingPoints:
    def test_finds_an_isolated_peak(self):
        points = find_swing_points(series("NQ", [1, 2, 5, 2, 1]), strength=2)
        highs = [point for point in points if point.kind == "high"]
        assert len(highs) == 1
        assert highs[0].index == 2
        assert highs[0].price == 5

    def test_reports_the_confirmation_bar(self):
        # A pivot at index 2 with strength 2 is only knowable at index 4.
        points = find_swing_points(series("NQ", [1, 2, 5, 2, 1]), strength=2)
        high = next(point for point in points if point.kind == "high")
        assert high.time == 2 * HOUR_MS
        assert high.confirmed_time == 4 * HOUR_MS

    def test_never_labels_the_unconfirmed_tail(self):
        # The last candle is the highest, but nothing has printed after it, so
        # calling it a swing high would be repainting.
        points = find_swing_points(series("NQ", [1, 2, 3, 4, 9]), strength=2)
        assert all(point.index <= 2 for point in points)

    def test_flat_top_reports_one_point_not_two(self):
        points = find_swing_points(series("NQ", [1, 5, 5, 1, 1]), strength=1)
        highs = [point for point in points if point.kind == "high"]
        assert len(highs) == 1
        assert highs[0].index == 1

    def test_finds_swing_lows(self):
        points = find_swing_points(series("NQ", [5, 4, 1, 4, 5]), strength=2)
        lows = [point for point in points if point.kind == "low"]
        assert len(lows) == 1
        assert lows[0].index == 2

    def test_series_shorter_than_the_window_yields_nothing(self):
        assert find_swing_points(series("NQ", [1, 2, 3]), strength=2) == []

    def test_rejects_a_meaningless_strength(self):
        with pytest.raises(ValueError):
            find_swing_points(series("NQ", [1, 2, 3, 4, 5]), strength=0)


# --------------------------------------------------------------------------
# Fair value gaps
# --------------------------------------------------------------------------
class TestFairValueGaps:
    def test_detects_a_bullish_gap(self):
        # Candle 0 tops at 10, candle 2 bottoms at 12: the 10-12 band was
        # skipped entirely.
        candles = series("NQ", highs=[10, 15, 16], lows=[8, 11, 12])
        gaps = find_fair_value_gaps(candles)
        assert len(gaps) == 1
        gap = gaps[0]
        assert gap.direction == "bullish"
        assert (gap.bottom, gap.top) == (10, 12)
        assert gap.midpoint == 11

    def test_detects_a_bearish_gap(self):
        candles = series("NQ", highs=[16, 15, 10], lows=[12, 9, 8])
        gaps = find_fair_value_gaps(candles)
        assert len(gaps) == 1
        assert gaps[0].direction == "bearish"
        assert (gaps[0].bottom, gaps[0].top) == (10, 12)

    def test_overlapping_candles_are_not_a_gap(self):
        candles = series("NQ", highs=[10, 15, 16], lows=[8, 9, 9])
        assert find_fair_value_gaps(candles) == []

    def test_tracks_mitigation_and_fill(self):
        # Gap 10-12, then price returns to 11 (touch) and later to 9 (fill).
        candles = series(
            "NQ",
            highs=[10, 15, 16, 16, 15],
            lows=[8, 11, 12, 11, 9],
        )
        gap = find_fair_value_gaps(candles)[0]
        assert gap.mitigated is True
        assert gap.mitigated_time == 3 * HOUR_MS
        assert gap.filled is True
        assert gap.filled_time == 4 * HOUR_MS
        assert gap.penetration == pytest.approx(1.0)

    def test_untouched_gap_reports_zero_penetration(self):
        candles = series("NQ", highs=[10, 15, 16, 18], lows=[8, 11, 12, 14])
        gap = find_fair_value_gaps(candles)[0]
        assert gap.mitigated is False
        assert gap.filled is False
        assert gap.penetration == 0.0

    def test_the_creating_candle_cannot_mitigate_its_own_gap(self):
        # Candle 2's low is the top edge; that must not count as a touch.
        candles = series("NQ", highs=[10, 15, 16], lows=[8, 11, 12])
        assert find_fair_value_gaps(candles)[0].mitigated is False

    def test_min_size_filter_drops_small_gaps(self):
        candles = series("NQ", highs=[10, 15, 16], lows=[8, 11, 12])
        # The gap is 2 wide on a midpoint of 11, about 18%.
        assert find_fair_value_gaps(candles, min_size_percent=1.0)
        assert find_fair_value_gaps(candles, min_size_percent=25.0) == []

    def test_include_filled_false_hides_closed_gaps(self):
        candles = series("NQ", highs=[10, 15, 16, 16, 15], lows=[8, 11, 12, 11, 9])
        assert find_fair_value_gaps(candles, include_filled=False) == []


# --------------------------------------------------------------------------
# SMT divergence
# --------------------------------------------------------------------------
class TestSmtDivergence:
    #: NQ makes a higher high (12 -> 14); ES fails to (12 -> 11).
    NQ_HIGHS = [10, 12, 10, 9, 10, 14, 10]
    ES_HIGHS = [10, 12, 10, 9, 10, 11, 10]

    def _detect(self, nq_highs=None, es_highs=None, **kwargs):
        primary = series("NQ", nq_highs or self.NQ_HIGHS)
        reference = series("ES", es_highs or self.ES_HIGHS)
        return find_smt_divergences(
            primary,
            find_swing_points(primary, strength=1),
            reference,
            find_swing_points(reference, strength=1),
            **kwargs,
        )

    def test_detects_a_bearish_divergence_at_a_high(self):
        found = [item for item in self._detect() if item.kind == "high"]
        assert len(found) == 1
        divergence = found[0]
        assert divergence.bias == "bearish"
        assert divergence.leading_symbol == "NQ"
        assert divergence.lagging_symbol == "ES"
        assert divergence.start_time == 1 * HOUR_MS
        assert divergence.end_time == 5 * HOUR_MS

    def test_both_anchors_being_swings_makes_it_valid(self):
        divergence = next(item for item in self._detect() if item.kind == "high")
        assert divergence.validity == "swing_pair"
        assert divergence.valid is True

    def test_agreement_is_not_a_divergence(self):
        # Both take the high, so there is nothing to report.
        found = [
            item
            for item in self._detect(es_highs=[10, 12, 10, 9, 10, 15, 10])
            if item.kind == "high"
        ]
        assert found == []

    def test_the_reference_can_be_the_one_that_leads(self):
        found = [
            item
            for item in self._detect(
                nq_highs=[10, 12, 10, 9, 10, 11, 10],
                es_highs=[10, 12, 10, 9, 10, 14, 10],
            )
            if item.kind == "high"
        ]
        assert len(found) == 1
        assert found[0].leading_symbol == "ES"
        assert found[0].lagging_symbol == "NQ"

    def test_reports_when_the_divergence_could_be_acted_on(self):
        divergence = next(item for item in self._detect() if item.kind == "high")
        # The pivot is at index 5 and confirms one bar later at strength 1.
        assert divergence.confirmed_time == 6 * HOUR_MS
        assert divergence.confirmed_time > divergence.end_time

    def test_strength_is_scaled_per_symbol(self):
        divergence = next(item for item in self._detect() if item.kind == "high")
        # NQ ran +16.7% off its prior high while ES fell -8.3%: about 25 points
        # of disagreement, independent of either instrument's price level.
        assert divergence.strength == pytest.approx(25.0, abs=0.1)

    def test_unaligned_bars_are_skipped_not_interpolated(self):
        primary = series("NQ", self.NQ_HIGHS)
        reference = series("ES", self.ES_HIGHS)
        # Shift the reference so no timestamp lines up.
        for candle in reference:
            candle.time += 60_000
        found = find_smt_divergences(
            primary,
            find_swing_points(primary, strength=1),
            reference,
            find_swing_points(reference, strength=1),
        )
        assert found == []

    def test_far_apart_swings_are_not_paired(self):
        found = self._detect(max_separation_bars=2)
        assert [item for item in found if item.kind == "high"] == []
