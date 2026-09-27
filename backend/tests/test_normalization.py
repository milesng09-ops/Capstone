"""``app/services/normalization.py`` is what makes a provider's raw payload
trustworthy before anything else in the system looks at it: ordering,
de-duplication, finite and positive prices, high/low that actually bound the
bar, non-negative volume.

None of the failure modes here raise. A malformed row is dropped, an
inverted high/low is silently repaired, a second bar at a timestamp already
seen silently replaces the first. That is the point -- normalisation exists
so the rest of the application never has to think about dirty provider data
-- but it also means a regression here produces no traceback, only a chart
that is quietly wrong. "The prices were really off" is a complaint this
project has already had from a real user, on exactly this kind of silent
failure. These tests pin what the module actually does, case by case, so a
change to that behaviour is caught here instead of noticed on a chart.
"""

from __future__ import annotations

import math

from app.services.normalization import (
    NormalizationReport,
    clip_to_range,
    merge_candles,
    normalize_candles,
)

HOUR = 3_600_000
T0 = 1_780_000_000_000


def raw(*, time=T0, o=100.0, h=101.0, low=99.0, c=100.5, v=10.0) -> dict:
    """A well-formed mapping-style raw candle, the shape most providers send."""

    return {"time": time, "open": o, "high": h, "low": low, "close": c, "volume": v}


class TestOrdering:
    def test_candles_come_back_in_ascending_time_order_regardless_of_input_order(self):
        scrambled = [
            raw(time=T0 + 3 * HOUR),
            raw(time=T0),
            raw(time=T0 + 2 * HOUR),
            raw(time=T0 + HOUR),
        ]

        candles = normalize_candles("ES", scrambled)

        assert [candle.time for candle in candles] == [
            T0,
            T0 + HOUR,
            T0 + 2 * HOUR,
            T0 + 3 * HOUR,
        ]

    def test_out_of_order_input_is_flagged_in_the_report(self):
        report = NormalizationReport()
        normalize_candles("ES", [raw(time=T0 + HOUR), raw(time=T0)], report=report)

        assert report.reordered is True

    def test_already_ascending_input_is_not_flagged_as_reordered(self):
        report = NormalizationReport()
        normalize_candles("ES", [raw(time=T0), raw(time=T0 + HOUR)], report=report)

        assert report.reordered is False


class TestDuplicates:
    def test_two_bars_at_the_same_timestamp_collapse_to_one(self):
        candles = normalize_candles("ES", [raw(time=T0, c=100.0), raw(time=T0, c=200.0)])

        assert len(candles) == 1

    def test_the_later_bar_in_the_feed_wins_the_duplicate_not_the_first(self):
        """Easy to get backwards, and silent either way: a de-dup that kept
        the *first* row instead of the last would look identical except for
        the one number a user would actually notice on the chart."""

        candles = normalize_candles("ES", [raw(time=T0, c=100.0), raw(time=T0, c=200.0)])

        assert candles[0].close == 200.0

    def test_the_duplicate_count_is_reported_and_the_survivor_is_kept(self):
        report = NormalizationReport()
        candles = normalize_candles(
            "ES", [raw(time=T0), raw(time=T0), raw(time=T0)], report=report
        )

        assert report.dropped_duplicate == 2
        assert report.kept == 1
        assert len(candles) == 1

    def test_timestamps_that_normalise_to_the_same_millisecond_still_collide(self):
        """One feed in seconds, one in milliseconds, both naming the same
        instant: de-duplication has to key off the *normalised* timestamp,
        not the raw value, or the same bar sails through twice under two
        different-looking times."""

        seconds_form = raw(time=T0 / 1000, c=1.0)
        ms_form = raw(time=T0, c=2.0)

        candles = normalize_candles("ES", [seconds_form, ms_form])

        assert len(candles) == 1
        assert candles[0].close == 2.0


class TestMalformedRowsAreDroppedNotRaised:
    """Every case here is a row that must disappear quietly rather than
    blow up the whole batch or, worse, be kept with a nonsensical value."""

    def test_a_non_numeric_price_is_dropped(self):
        report = NormalizationReport()
        candles = normalize_candles("ES", [raw(c="not-a-number")], report=report)

        assert candles == []
        assert report.dropped_malformed == 1

    def test_a_nan_price_is_dropped(self):
        report = NormalizationReport()
        candles = normalize_candles("ES", [raw(h=math.nan)], report=report)

        assert candles == []
        assert report.dropped_malformed == 1

    def test_an_infinite_price_is_dropped(self):
        report = NormalizationReport()
        candles = normalize_candles("ES", [raw(low=math.inf)], report=report)

        assert candles == []
        assert report.dropped_malformed == 1

    def test_a_zero_price_is_dropped_rather_than_kept_as_a_free_bar(self):
        report = NormalizationReport()
        candles = normalize_candles("ES", [raw(o=0.0)], report=report)

        assert candles == []
        assert report.dropped_malformed == 1

    def test_a_negative_price_is_dropped(self):
        report = NormalizationReport()
        candles = normalize_candles("ES", [raw(c=-5.0)], report=report)

        assert candles == []
        assert report.dropped_malformed == 1

    def test_a_row_missing_a_required_field_is_dropped(self):
        record = raw()
        del record["close"]
        report = NormalizationReport()

        candles = normalize_candles("ES", [record], report=report)

        assert candles == []
        assert report.dropped_malformed == 1

    def test_an_iso_date_string_is_not_a_timestamp_this_function_understands(self):
        """``normalize_candles`` only ever sees raw provider payloads, whose
        timestamps are epoch numbers; ISO-8601 parsing (as used for the
        ``from``/``to`` query parameters elsewhere) is a different code path
        entirely. A provider that ever sent an ISO string here would have
        every one of its bars silently dropped rather than misread, which is
        worth pinning so the two timestamp formats are never assumed
        interchangeable."""

        report = NormalizationReport()
        candles = normalize_candles("ES", [raw(time="2026-05-28T00:00:00Z")], report=report)

        assert candles == []
        assert report.dropped_malformed == 1

    def test_a_sequence_shorter_than_five_fields_is_dropped(self):
        report = NormalizationReport()
        candles = normalize_candles("ES", [(T0, 100.0, 101.0)], report=report)

        assert candles == []
        assert report.dropped_malformed == 1


class TestBoundsAreRepairedNotDiscarded:
    """A high that does not actually bound its own open/close is a vendor
    rounding artefact, not a reason to lose the bar -- but a "repair" that
    silently produces the *wrong* high or low would draw a perfectly
    ordinary-looking, wrong candle, which is the worse of the two bugs."""

    def test_a_high_below_the_open_is_widened_to_include_it(self):
        candles = normalize_candles("ES", [raw(o=105.0, h=101.0, low=99.0, c=100.0)])

        assert candles[0].high == 105.0

    def test_a_low_above_the_close_is_widened_to_include_it(self):
        candles = normalize_candles("ES", [raw(o=100.0, h=101.0, low=99.5, c=95.0)])

        assert candles[0].low == 95.0

    def test_a_repaired_bar_is_counted_but_kept_not_dropped(self):
        report = NormalizationReport()
        candles = normalize_candles(
            "ES", [raw(o=105.0, h=101.0, low=99.0, c=100.0)], report=report
        )

        assert report.repaired_bounds == 1
        assert report.dropped_malformed == 0
        assert len(candles) == 1

    def test_a_bar_already_inside_its_own_bounds_is_left_alone(self):
        report = NormalizationReport()
        normalize_candles("ES", [raw(o=100.0, h=101.0, low=99.0, c=100.5)], report=report)

        assert report.repaired_bounds == 0


class TestVolume:
    def test_missing_volume_defaults_to_zero_and_is_counted(self):
        record = raw()
        del record["volume"]
        report = NormalizationReport()

        candles = normalize_candles("ES", [record], report=report)

        assert candles[0].volume == 0.0
        assert report.missing_volume == 1

    def test_negative_volume_is_clamped_to_zero_rather_than_kept_negative(self):
        candles = normalize_candles("ES", [raw(v=-50.0)])

        assert candles[0].volume == 0.0

    def test_a_five_field_sequence_gets_a_default_volume_of_zero(self):
        candles = normalize_candles("ES", [(T0, 100.0, 101.0, 99.0, 100.5)])

        assert candles[0].volume == 0.0


class TestAcceptsSeveralProviderShapes:
    def test_short_key_mappings_are_understood(self):
        record = {"t": T0, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.5, "v": 5.0}

        candles = normalize_candles("ES", [record])

        assert len(candles) == 1
        assert candles[0].close == 100.5

    def test_a_plain_six_item_sequence_is_understood(self):
        candles = normalize_candles("ES", [(T0, 100.0, 101.0, 99.0, 100.5, 5.0)])

        assert len(candles) == 1
        assert candles[0].volume == 5.0

    def test_seconds_since_epoch_are_upscaled_to_milliseconds(self):
        candles = normalize_candles("ES", [raw(time=1_700_000_000)])

        assert candles[0].time == 1_700_000_000_000

    def test_just_below_the_seconds_cutoff_is_still_upscaled(self):
        # The heuristic in _normalise_timestamp treats anything under 1e11 as
        # seconds. One millisecond short of the cutoff is the case that would
        # break first if that threshold ever moved.
        boundary = 1e11 - 1
        candles = normalize_candles("ES", [raw(time=boundary)])

        assert candles[0].time == round(boundary * 1000)

    def test_the_cutoff_itself_is_already_treated_as_milliseconds(self):
        candles = normalize_candles("ES", [raw(time=1e11)])

        assert candles[0].time == int(1e11)


class TestEdgesOfTheInput:
    def test_empty_input_produces_an_empty_result_and_a_clean_report(self):
        report = NormalizationReport()
        candles = normalize_candles("ES", [], report=report)

        assert candles == []
        assert report.received == 0
        assert report.kept == 0

    def test_a_single_candle_is_returned_as_is(self):
        candles = normalize_candles("ES", [raw(time=T0, c=123.25)])

        assert len(candles) == 1
        assert candles[0].close == 123.25

    def test_every_candle_is_stamped_with_the_requested_symbol_not_the_raw_row(self):
        candles = normalize_candles("NQ", [raw()])

        assert candles[0].symbol == "NQ"

    def test_received_accumulates_across_calls_sharing_one_report(self):
        """The optional ``report`` argument exists so a caller can normalise
        several chunks and read one running total. If it silently started a
        fresh report on every call, ``received`` would always read as just
        the last chunk rather than the whole feed."""

        report = NormalizationReport()
        normalize_candles("ES", [raw(time=T0)], report=report)
        normalize_candles("ES", [raw(time=T0 + HOUR)], report=report)

        assert report.received == 2

    def test_kept_reflects_only_the_most_recent_call_not_a_running_total(self):
        """Unlike ``received``, ``kept`` is assigned from the candles this
        call produced (``report.kept = len(candles)``) rather than
        incremented, so it is *not* a running total across chunks -- worth
        pinning precisely because it sits right next to counters that behave
        the other way, which is exactly the kind of inconsistency a caller
        would get wrong silently rather than notice."""

        report = NormalizationReport()
        normalize_candles("ES", [raw(time=T0), raw(time=T0 + HOUR)], report=report)
        normalize_candles("ES", [raw(time=T0 + 2 * HOUR)], report=report)

        assert report.kept == 1


class TestClipToRange:
    def test_candles_at_the_exact_boundaries_are_kept(self):
        candles = normalize_candles("ES", [raw(time=T0), raw(time=T0 + HOUR)])

        clipped = clip_to_range(candles, T0, T0 + HOUR)

        assert [candle.time for candle in clipped] == [T0, T0 + HOUR]

    def test_candles_one_millisecond_outside_either_edge_are_dropped(self):
        candles = normalize_candles(
            "ES",
            [raw(time=T0 - 1), raw(time=T0), raw(time=T0 + HOUR), raw(time=T0 + HOUR + 1)],
        )

        clipped = clip_to_range(candles, T0, T0 + HOUR)

        assert [candle.time for candle in clipped] == [T0, T0 + HOUR]

    def test_an_empty_list_clips_to_an_empty_list(self):
        assert clip_to_range([], T0, T0 + HOUR) == []


class TestMergeCandles:
    def test_disjoint_series_are_concatenated_in_time_order(self):
        existing = normalize_candles("ES", [raw(time=T0)])
        incoming = normalize_candles("ES", [raw(time=T0 + HOUR)])

        merged = merge_candles(existing, incoming)

        assert [candle.time for candle in merged] == [T0, T0 + HOUR]

    def test_incoming_replaces_existing_at_the_same_timestamp(self):
        """The entire point of a merge rather than a concatenation: a
        corrected bar for a time already held has to overwrite the stale
        one, not sit beside it as a second, contradictory entry."""

        existing = normalize_candles("ES", [raw(time=T0, c=100.0)])
        incoming = normalize_candles("ES", [raw(time=T0, c=999.0)])

        merged = merge_candles(existing, incoming)

        assert len(merged) == 1
        assert merged[0].close == 999.0

    def test_merging_with_an_empty_incoming_list_leaves_existing_untouched(self):
        existing = normalize_candles("ES", [raw(time=T0)])

        merged = merge_candles(existing, [])

        assert merged == existing

    def test_merging_two_empty_lists_is_empty(self):
        assert merge_candles([], []) == []
