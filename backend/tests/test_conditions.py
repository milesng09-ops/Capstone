"""Detectors deciding whether a match is tradeable, and only on past evidence.

The failure mode these guard against does not look like a failure. A condition
that consults one bar too far ahead produces a strategy that filters out the
losers, backtests beautifully, and is worthless. Every test here is really the
same test asked of a different detector: was this knowable at the entry bar?
"""

from __future__ import annotations

from app.analysis.conditions import detectors_at_entry, unmet_condition
from app.backtesting.metrics import compute_metrics
from app.analysis.fair_value_gap import FairValueGap
from app.analysis.smt import SmtDivergence
from app.analysis.structure import SwingPoint

HOUR = 3_600_000
T0 = 1_780_000_000_000


def gap(
    *,
    direction="bullish",
    time=T0,
    bottom=99.0,
    top=101.0,
    filled_time=None,
) -> FairValueGap:
    return FairValueGap(
        symbol="ES",
        direction=direction,
        index=0,
        time=time,
        start_time=time - 2 * HOUR,
        end_time=filled_time or time + 50 * HOUR,
        bottom=bottom,
        top=top,
        size=top - bottom,
        size_percent=(top - bottom) / top * 100,
        mitigated=filled_time is not None,
        mitigated_time=filled_time,
        filled=filled_time is not None,
        filled_time=filled_time,
        penetration=1.0 if filled_time else 0.0,
    )


def swing(*, kind="low", time=T0, confirmed_time=None, price=100.0) -> SwingPoint:
    return SwingPoint(
        symbol="ES",
        kind=kind,
        index=0,
        time=time,
        price=price,
        confirmed_time=confirmed_time if confirmed_time is not None else time + 2 * HOUR,
        strength=2,
    )


def divergence(*, bias="bullish", confirmed_time=T0, valid=True) -> SmtDivergence:
    return SmtDivergence(
        kind="low",
        bias=bias,
        primary_symbol="ES",
        reference_symbol="NQ",
        start_time=confirmed_time - 5 * HOUR,
        end_time=confirmed_time - HOUR,
        primary_start_price=100.0,
        primary_end_price=99.0,
        reference_start_price=100.0,
        reference_end_price=101.0,
        leading_symbol="NQ",
        lagging_symbol="ES",
        validity="swing_pair" if valid else "unconfirmed",
        valid=valid,
        confirmed_time=confirmed_time,
        inside_fair_value_gap=False,
        fair_value_gap_time=None,
        strength=1.0,
        separation_bars=4,
    )


def state_at(entry_time, *, price=100.0, direction="long", align=True, within=10, **kw):
    return detectors_at_entry(
        entry_price=price,
        entry_time=entry_time,
        direction=direction,
        gaps=kw.get("gaps", []),
        swings=kw.get("swings", []),
        divergences=kw.get("divergences", []),
        within_ms=within * HOUR,
        align_with_direction=align,
    )


# --------------------------------------------------------------------------
class TestNothingFromTheFutureCounts:
    def test_a_gap_revealed_after_the_entry_does_not_stand(self):
        later = state_at(T0, gaps=[gap(time=T0 + 5 * HOUR)])
        assert later.fair_value_gap is None

    def test_a_gap_already_filled_before_the_entry_does_not_stand(self):
        closed = state_at(
            T0 + 10 * HOUR,
            gaps=[gap(time=T0, filled_time=T0 + 5 * HOUR)],
        )
        assert closed.fair_value_gap is None

    def test_a_swing_is_read_from_its_confirmation_not_its_pivot(self):
        """The subtle one, and the reason this module exists.

        The pivot is real at ``time``; nobody could know it was a pivot until
        ``confirmed_time``. Filtering on the pivot builds a strategy that
        trades on hindsight.
        """

        pivot = swing(time=T0, confirmed_time=T0 + 4 * HOUR)

        # An entry between the pivot and its confirmation must not see it.
        assert state_at(T0 + 2 * HOUR, swings=[pivot]).swing_point is None
        # Once confirmed, it stands.
        assert state_at(T0 + 4 * HOUR, swings=[pivot]).swing_point is pivot

    def test_a_divergence_is_read_from_its_confirmation(self):
        item = divergence(confirmed_time=T0 + 4 * HOUR)
        assert state_at(T0 + 2 * HOUR, divergences=[item]).smt_divergence is None
        assert state_at(T0 + 5 * HOUR, divergences=[item]).smt_divergence is item


class TestAGapHasToContainTheEntry:
    def test_a_gap_elsewhere_on_the_chart_does_not_count(self):
        # Presence is not the condition: price has to be trading in it.
        away = state_at(T0 + HOUR, price=150.0, gaps=[gap(bottom=99.0, top=101.0)])
        assert away.fair_value_gap is None

    def test_a_gap_around_the_entry_price_does(self):
        inside = state_at(T0 + HOUR, price=100.0, gaps=[gap(bottom=99.0, top=101.0)])
        assert inside.fair_value_gap is not None

    def test_a_gap_has_no_recency_window(self):
        # Unlike a swing, a gap stays live until filled however long it takes.
        old = gap(time=T0)
        assert state_at(T0 + 5_000 * HOUR, gaps=[old]).fair_value_gap is old


class TestAlignmentWithTheTradeDirection:
    def test_a_long_wants_a_bullish_gap(self):
        bearish = [gap(direction="bearish")]
        assert state_at(T0 + HOUR, direction="long", gaps=bearish).fair_value_gap is None
        assert (
            state_at(T0 + HOUR, direction="short", gaps=bearish).fair_value_gap
            is not None
        )

    def test_a_long_wants_a_swing_low(self):
        high = [swing(kind="high", time=T0, confirmed_time=T0)]
        assert state_at(T0 + HOUR, direction="long", swings=high).swing_point is None
        assert state_at(T0 + HOUR, direction="short", swings=high).swing_point is not None

    def test_alignment_can_be_switched_off(self):
        bearish = [gap(direction="bearish")]
        either = state_at(T0 + HOUR, direction="long", align=False, gaps=bearish)
        assert either.fair_value_gap is not None


class TestRecency:
    def test_a_divergence_too_long_ago_is_not_this_trades_reason(self):
        stale = divergence(confirmed_time=T0)
        assert state_at(T0 + 50 * HOUR, within=10, divergences=[stale]).smt_divergence is None
        assert state_at(T0 + 5 * HOUR, within=10, divergences=[stale]).smt_divergence is stale

    def test_the_most_recent_one_is_the_one_reported(self):
        older = divergence(confirmed_time=T0)
        newer = divergence(confirmed_time=T0 + 3 * HOUR)
        found = state_at(T0 + 4 * HOUR, within=10, divergences=[older, newer])
        assert found.smt_divergence is newer


class TestInvalidDivergencesNeverQualify:
    def test_an_unconfirmed_divergence_is_not_eligible(self):
        # `smt` keeps these only for tuning; its own docstring says they stay
        # out of trading rules.
        unconfirmed = divergence(confirmed_time=T0, valid=False)
        assert state_at(T0 + HOUR, divergences=[unconfirmed]).smt_divergence is None


class TestWhyAMatchWasDropped:
    def test_a_met_condition_gives_no_reason(self):
        met = state_at(T0 + HOUR, gaps=[gap()])
        assert (
            unmet_condition(
                met,
                require_fair_value_gap=True,
                require_smt_divergence=False,
                require_swing_point=False,
            )
            is None
        )

    def test_an_unmet_condition_says_which_one(self):
        empty = state_at(T0 + HOUR)
        reason = unmet_condition(
            empty,
            require_fair_value_gap=True,
            require_smt_divergence=False,
            require_swing_point=False,
        )
        assert reason is not None
        assert "fair value gap" in reason

    def test_requiring_nothing_drops_nothing(self):
        empty = state_at(T0 + HOUR)
        assert (
            unmet_condition(
                empty,
                require_fair_value_gap=False,
                require_smt_divergence=False,
                require_swing_point=False,
            )
            is None
        )


class TestAnEmptyRunSaysWhatEmptiedIt:
    """Advising a wider lookback when the conditions did it is misdirection."""

    def test_conditions_dropping_everything_is_named_as_the_cause(self):
        summary = compute_metrics(
            [],
            total_matches=13,
            skipped_matches=0,
            condition_filtered_matches=13,
        )
        warning = summary.sample_size_warning or ""
        assert "detector conditions" in warning
        # The advice must point at the conditions, not the search.
        assert "similarity threshold" not in warning
        assert summary.condition_filtered_matches == 13

    def test_a_partial_drop_reports_both_causes(self):
        summary = compute_metrics(
            [], total_matches=13, skipped_matches=5, condition_filtered_matches=8
        )
        warning = summary.sample_size_warning or ""
        assert "8 of 13" in warning

    def test_without_conditions_the_original_advice_stands(self):
        summary = compute_metrics([], total_matches=0, skipped_matches=0)
        warning = summary.sample_size_warning or ""
        assert "similarity threshold" in warning
        assert "detector conditions" not in warning
