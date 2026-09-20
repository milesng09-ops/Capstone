"""The trade logic Miles described: bias, reaction, retracement, session.

Every one of these can be wrong in the way that looks like success. A bias
read from a 4-hour bar that has not closed, a reaction measured on the entry
bar of a next-open fill, a Fibonacci leg drawn to a swing high the entry bar
itself set -- each produces a backtest that improves and a strategy that does
not exist. So the bulk of what is asserted here is *when* a thing became
knowable, not what it says.
"""

from __future__ import annotations

import pytest

from app.analysis.bias import bias_allows, bias_at, find_bias_states
from app.analysis.conditions import detectors_at_entry, unmet_condition
from app.analysis.entries import fib_zone_at
from app.analysis.reaction import measure_reaction, reaction_at
from app.analysis.sessions import SESSIONS, local_minute, session_at, windows_for
from app.analysis.structure import SwingPoint, find_swing_points
from app.models.domain import Candle

MINUTE = 60_000
HOUR = 3_600_000
FOUR_HOUR = 4 * HOUR
#: A Wednesday, well clear of a daylight-saving boundary.
T0 = 1_780_000_000_000


def bar(time: int, o: float, h: float, low: float, c: float, symbol: str = "ES") -> Candle:
    return Candle(symbol=symbol, time=time, open=o, high=h, low=low, close=c, volume=1.0)


def swing(kind: str, time: int, price: float, confirmed: int) -> SwingPoint:
    return SwingPoint(
        symbol="ES",
        kind=kind,
        index=0,
        time=time,
        price=price,
        confirmed_time=confirmed,
        strength=2,
    )


# --------------------------------------------------------------------------
# Higher-timeframe bias
# --------------------------------------------------------------------------
def rising_then_falling() -> list[Candle]:
    """A leg up that breaks a high, then a leg down that breaks a low."""

    prices = [100, 104, 102, 101, 103, 108, 106, 104, 100, 96, 94]
    return [
        bar(T0 + index * FOUR_HOUR, price - 1, price + 1, price - 2, price)
        for index, price in enumerate(prices)
    ]


class TestBias:
    def test_records_a_change_of_frame_rather_than_every_bar(self):
        candles = rising_then_falling()
        swings = find_swing_points(candles, strength=1)

        states = find_bias_states(candles, swings, interval_ms=FOUR_HOUR)

        assert states, "structure was broken in both directions"
        assert len(states) < len(candles)
        # No two consecutive states repeat a direction: each row is a change.
        directions = [state.direction for state in states]
        assert all(a != b for a, b in zip(directions, directions[1:]))

    def test_a_state_is_knowable_only_at_the_close_of_its_bar(self):
        """The whole reason this module exists.

        A 4-hour bar stamped 08:00 is not finished until 12:00. A 5-minute
        entry at 08:05 that reads it has consulted four hours of the future,
        and nothing in the result looks wrong.
        """

        candles = rising_then_falling()
        swings = find_swing_points(candles, strength=1)

        states = find_bias_states(candles, swings, interval_ms=FOUR_HOUR)

        for state in states:
            assert state.known_from == state.time + FOUR_HOUR

    def test_the_frame_is_not_in_force_one_millisecond_before_its_close(self):
        candles = rising_then_falling()
        swings = find_swing_points(candles, strength=1)
        states = find_bias_states(candles, swings, interval_ms=FOUR_HOUR)
        first = states[0]

        assert bias_at(states, first.known_from - 1) is None
        assert bias_at(states, first.known_from) is first

    def test_nothing_is_claimed_before_structure_has_broken(self):
        # Flat bars break nothing in either direction.
        flat = [bar(T0 + index * FOUR_HOUR, 100, 101, 99, 100) for index in range(12)]

        states = find_bias_states(flat, find_swing_points(flat, strength=1), interval_ms=FOUR_HOUR)

        assert states == []
        assert bias_at(states, T0 + 100 * FOUR_HOUR) is None

    def test_a_swing_confirmed_inside_the_bar_is_not_a_level_that_bar_broke(self):
        candles = rising_then_falling()
        # Confirmed one millisecond into the bar that would break it.
        late = swing("high", T0, 104.0, confirmed=T0 + FOUR_HOUR + 1)

        states = find_bias_states(candles, [late], interval_ms=FOUR_HOUR)

        assert all(state.time > T0 + FOUR_HOUR for state in states)

    def test_an_absent_or_neutral_frame_is_behind_nothing(self):
        assert bias_allows(None, "long") is False
        assert bias_allows(None, "short") is False

    def test_a_frame_only_agrees_with_its_own_side(self):
        candles = rising_then_falling()
        swings = find_swing_points(candles, strength=1)
        states = find_bias_states(candles, swings, interval_ms=FOUR_HOUR)
        bullish = next(state for state in states if state.direction == "bullish")

        assert bias_allows(bullish, "long") is True
        assert bias_allows(bullish, "short") is False

    def test_an_empty_series_has_no_frame(self):
        assert find_bias_states([], [], interval_ms=FOUR_HOUR) == []


# --------------------------------------------------------------------------
# Reaction quality
# --------------------------------------------------------------------------
class TestReaction:
    def test_measures_the_rejection_wick_on_the_trade_s_side(self):
        # Range 10, lower wick 6, closes up.
        candle = bar(T0, o=106, h=110, low=100, c=108)

        long = measure_reaction(candle, "long")
        short = measure_reaction(candle, "short")

        assert long is not None and short is not None
        assert long.wick_ratio == pytest.approx(0.6)
        # The same bar read as a short has almost no rejection above it.
        assert short.wick_ratio == pytest.approx(0.2)

    def test_a_bar_closing_against_the_trade_is_not_a_rejection(self):
        # A long lower wick, but it closed below its open.
        candle = bar(T0, o=108, h=110, low=100, c=104)

        reaction = measure_reaction(candle, "long")

        assert reaction is not None
        assert reaction.wick_ratio > 0.3
        assert reaction.closed_through_open is False
        assert reaction.meets(min_wick_ratio=0.3, min_displacement_percent=0) is False

    def test_shape_alone_does_not_carry_a_bar_that_barely_moved(self):
        candle = bar(T0, o=100.0, h=100.2, low=99.8, c=100.1)

        reaction = measure_reaction(candle, "long")

        assert reaction is not None
        assert reaction.meets(min_wick_ratio=0.3, min_displacement_percent=0.0) is True
        # 0.3% is a far bigger move than this bar made.
        assert reaction.meets(min_wick_ratio=0.3, min_displacement_percent=0.3) is False

    def test_a_flat_bar_is_not_a_perfect_rejection(self):
        """A halted market must not come out as the best setup in the run."""

        assert measure_reaction(bar(T0, 100, 100, 100, 100), "long") is None

    def test_a_next_open_entry_reads_the_bar_before_its_own(self):
        candles = [
            bar(T0, o=106, h=110, low=100, c=108),  # the rejection
            bar(T0 + HOUR, o=108, h=112, low=107, c=111),  # the entry bar
        ]

        known = reaction_at(candles, 1, "long", entry_bar_known=True)
        unknown = reaction_at(candles, 1, "long", entry_bar_known=False)

        assert known is not None and unknown is not None
        assert known.time == T0 + HOUR
        assert unknown.time == T0, "a next-open fill cannot see its own bar"

    def test_there_is_no_reaction_before_the_first_bar(self):
        candles = [bar(T0, 100, 101, 99, 100)]

        assert reaction_at(candles, 0, "long", entry_bar_known=False) is None


# --------------------------------------------------------------------------
# Entry models
# --------------------------------------------------------------------------
class TestFibRetrace:
    def leg(self) -> list[SwingPoint]:
        # Up leg: 100 -> 200, both confirmed well before the entry.
        return [
            swing("low", T0, 100.0, confirmed=T0 + HOUR),
            swing("high", T0 + 5 * HOUR, 200.0, confirmed=T0 + 6 * HOUR),
        ]

    def test_the_band_is_measured_down_from_the_impulse_for_a_long(self):
        zone = fib_zone_at(self.leg(), T0 + 10 * HOUR, "long", low_ratio=0.5, high_ratio=0.75)

        assert zone is not None
        # 50% of a 100-point leg down from 200 is 150; 75% is 125.
        assert zone.high == pytest.approx(150.0)
        assert zone.low == pytest.approx(125.0)
        assert zone.contains(140.0) is True
        assert zone.contains(180.0) is False

    def test_a_leg_whose_end_is_not_yet_confirmed_is_not_a_leg(self):
        """The version of this that backtests beautifully.

        Measuring to a swing high the entry bar itself went on to set is a
        retracement of the future, and it fits every time.
        """

        points = [
            swing("low", T0, 100.0, confirmed=T0 + HOUR),
            swing("high", T0 + 5 * HOUR, 200.0, confirmed=T0 + 20 * HOUR),
        ]

        assert fib_zone_at(points, T0 + 10 * HOUR, "long") is None

    def test_a_short_retraces_a_down_leg(self):
        points = [
            swing("high", T0, 200.0, confirmed=T0 + HOUR),
            swing("low", T0 + 5 * HOUR, 100.0, confirmed=T0 + 6 * HOUR),
        ]

        zone = fib_zone_at(points, T0 + 10 * HOUR, "short", low_ratio=0.5, high_ratio=0.75)

        assert zone is not None
        assert zone.low == pytest.approx(150.0)
        assert zone.high == pytest.approx(175.0)

    def test_structure_pointing_the_wrong_way_yields_no_zone(self):
        # Only lows: there is no impulse to retrace.
        points = [
            swing("low", T0, 100.0, confirmed=T0 + HOUR),
            swing("low", T0 + 5 * HOUR, 90.0, confirmed=T0 + 6 * HOUR),
        ]

        assert fib_zone_at(points, T0 + 10 * HOUR, "long") is None

    def test_reports_how_deep_a_price_sits_in_the_leg(self):
        zone = fib_zone_at(self.leg(), T0 + 10 * HOUR, "long")

        assert zone is not None
        assert zone.retracement_of(200.0) == pytest.approx(0.0)
        assert zone.retracement_of(100.0) == pytest.approx(1.0)
        assert zone.retracement_of(150.0) == pytest.approx(0.5)

    def test_a_reversed_band_is_read_in_either_order(self):
        given = fib_zone_at(self.leg(), T0 + 10 * HOUR, "long", low_ratio=0.79, high_ratio=0.62)
        canonical = fib_zone_at(self.leg(), T0 + 10 * HOUR, "long", low_ratio=0.62, high_ratio=0.79)

        assert given is not None and canonical is not None
        assert given.low == pytest.approx(canonical.low)
        assert given.high == pytest.approx(canonical.high)


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------
class TestSessions:
    def test_a_window_is_wall_clock_across_a_daylight_saving_change(self):
        """13:30 UTC is the New York open in summer and an hour early in winter.

        A fixed offset is right for one half of the year, which would move
        the filter off the session halfway through a long backtest.
        """

        # 2026-06-21 13:30 UTC = 09:30 New York (EDT).
        summer = 1_782_048_600_000
        # 2026-12-02 14:30 UTC = 09:30 New York (EST).
        winter = 1_796_221_800_000

        assert local_minute(summer) == 9 * 60 + 30
        assert local_minute(winter) == 9 * 60 + 30

    def test_the_asia_window_runs_through_midnight(self):
        asia = SESSIONS["asia"]

        assert asia.contains_minute(22 * 60) is True
        assert asia.contains_minute(0) is False  # The end is exclusive.
        assert asia.contains_minute(23 * 60 + 59) is True
        assert asia.contains_minute(10 * 60) is False

    def test_no_windows_means_no_filter_rather_than_nothing_qualifies(self):
        assert session_at(T0, []) is None

    def test_unknown_session_names_cost_that_filter_and_not_the_run(self):
        windows = windows_for(["london", "atlantis"])

        assert [window.key for window in windows] == ["london"]

    def test_an_entry_inside_a_window_names_it(self):
        # 2026-06-21 13:30 UTC = 09:30 New York, inside New York AM.
        found = session_at(1_782_048_600_000, windows_for(["new_york_am"]))

        assert found is not None and found.key == "new_york_am"

    def test_an_entry_outside_every_window_names_none(self):
        # 2026-06-21 17:00 UTC = 13:00 New York: after AM, before PM.
        assert session_at(1_782_061_200_000, windows_for(["new_york_am"])) is None


# --------------------------------------------------------------------------
# The conditions, assembled
# --------------------------------------------------------------------------
class TestConditions:
    def state_at(self, **kwargs):
        base = dict(
            entry_price=150.0,
            entry_time=T0 + 10 * HOUR,
            direction="long",
            gaps=[],
            swings=[],
            divergences=[],
            pools=[],
            within_ms=10 * HOUR,
            align_with_direction=True,
        )
        base.update(kwargs)
        return detectors_at_entry(**base)

    def test_a_missing_frame_and_the_wrong_frame_give_different_reasons(self):
        candles = rising_then_falling()
        swings = find_swing_points(candles, strength=1)
        states = find_bias_states(candles, swings, interval_ms=FOUR_HOUR)
        bearish = next(state for state in states if state.direction == "bearish")

        absent = unmet_condition(
            self.state_at(bias_states=[]),
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            require_higher_timeframe_bias=True,
        )
        wrong = unmet_condition(
            self.state_at(
                bias_states=states, entry_time=bearish.known_from + HOUR
            ),
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            require_higher_timeframe_bias=True,
        )

        assert absent is not None and "had not established" in absent
        assert wrong is not None and "against this trade" in wrong
        assert absent != wrong

    def test_the_session_filter_only_bites_when_asked_for(self):
        state = self.state_at(sessions=windows_for(["new_york_am"]))

        silent = unmet_condition(
            state,
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            require_session=False,
        )
        asked = unmet_condition(
            state,
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            require_session=True,
        )

        assert silent is None
        assert asked is not None and "outside every session" in asked

    def test_a_fib_entry_outside_the_band_says_where_the_band_was(self):
        points = [
            swing("low", T0, 100.0, confirmed=T0 + HOUR),
            swing("high", T0 + 5 * HOUR, 200.0, confirmed=T0 + 6 * HOUR),
        ]

        reason = unmet_condition(
            self.state_at(swings=points, entry_price=195.0, fib_low=0.62, fib_high=0.79),
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            entry_model="fib_retrace",
        )

        assert reason is not None and "retracement of the last leg" in reason

    def test_a_fib_entry_inside_the_band_passes(self):
        points = [
            swing("low", T0, 100.0, confirmed=T0 + HOUR),
            swing("high", T0 + 5 * HOUR, 200.0, confirmed=T0 + 6 * HOUR),
        ]

        reason = unmet_condition(
            self.state_at(swings=points, entry_price=130.0, fib_low=0.62, fib_high=0.79),
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            entry_model="fib_retrace",
        )

        assert reason is None

    def test_the_immediate_model_asks_for_no_retracement(self):
        reason = unmet_condition(
            self.state_at(fib_low=0.62, fib_high=0.79),
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            entry_model="immediate",
        )

        assert reason is None

    def test_a_weak_reaction_is_refused_with_its_own_numbers(self):
        candles = [bar(T0 + 10 * HOUR, o=150, h=152, low=149, c=151)]

        reason = unmet_condition(
            self.state_at(candles=candles, entry_index=0),
            require_fair_value_gap=False,
            require_smt_divergence=False,
            require_swing_point=False,
            require_reaction=True,
            min_wick_ratio=0.5,
        )

        assert reason is not None and "rejection wick" in reason


# --------------------------------------------------------------------------
# The request shape
# --------------------------------------------------------------------------
class TestRequestValidation:
    def request(self, **kwargs):
        from app.models.schemas import BacktestRequest

        base = dict(
            primary_symbol="ES",
            interval="1h",
            selection={"start_time": T0, "end_time": T0 + 40 * HOUR},
            search={"lookback_start": T0 - 400 * HOUR, "lookback_end": T0},
        )
        base.update(kwargs)
        return BacktestRequest(**base)

    def test_a_bias_timeframe_must_be_coarser_than_the_entry_one(self):
        """Equal is the error worth naming.

        A "1h bias" on a 1h backtest is not a higher-timeframe rule, it is
        the same structure consulted twice -- and it would pass quietly.
        """

        with pytest.raises(ValueError, match="coarser"):
            self.request(higher_timeframe="1h")
        with pytest.raises(ValueError, match="coarser"):
            self.request(higher_timeframe="15m")

        assert self.request(higher_timeframe="4h").higher_timeframe == "4h"

    def test_requiring_a_bias_without_saying_where_to_read_it_is_refused(self):
        with pytest.raises(ValueError, match="higher_timeframe"):
            self.request(detectors={"require_higher_timeframe_bias": True})

    def test_an_unknown_session_is_refused_rather_than_silently_dropped(self):
        # `windows_for` is lenient because it reads a stored workspace; the
        # request is the boundary where a typo should still be an error.
        with pytest.raises(ValueError, match="unknown sessions"):
            self.request(detectors={"sessions": ["atlantis"]})

        assert self.request(detectors={"sessions": ["london"]}).detectors.sessions == ["london"]

    def test_a_reversed_fib_band_is_refused(self):
        with pytest.raises(ValueError, match="fib_low"):
            self.request(detectors={"fib_low": 0.8, "fib_high": 0.5})

    def test_the_new_settings_leave_a_default_run_asking_for_nothing(self):
        # A request that names no conditions must behave exactly as it did
        # before any of this existed.
        assert self.request().detectors.any_required is False
        assert self.request().higher_timeframe is None


# --------------------------------------------------------------------------
# The service wiring, against generated candles rather than hand-built ones
# --------------------------------------------------------------------------
class TestServiceWiring:
    """The parts of `BacktestService` these conditions run through.

    Called on the class so no database or provider is needed: none of the
    three reads `self`, which is itself worth holding -- they are arithmetic
    over candles that happen to live on a service.
    """

    def hourly(self, count: int = 400) -> list[Candle]:
        """A deterministic random walk on the hour.

        Generated here rather than taken from the demo provider so the test
        owns its own data: the point is a series with enough structure to
        break in both directions, not a realistic one.
        """

        import random

        rng = random.Random(7)
        start = T0 - T0 % HOUR
        price = 100.0
        bars: list[Candle] = []
        for index in range(count):
            step = rng.uniform(-1.5, 1.5)
            close = max(1.0, price + step)
            high = max(price, close) + rng.uniform(0, 0.8)
            low = min(price, close) - rng.uniform(0, 0.8)
            bars.append(bar(start + index * HOUR, price, high, low, close))
            price = close
        return bars

    def request(self, **kwargs):
        from app.models.schemas import BacktestRequest

        base = dict(
            primary_symbol="ES",
            interval="1h",
            selection={"start_time": T0, "end_time": T0 + 40 * HOUR},
            search={"lookback_start": T0, "lookback_end": T0 + 300 * HOUR},
        )
        base.update(kwargs)
        return BacktestRequest(**base)

    def test_the_higher_timeframe_is_built_from_the_bars_already_loaded(self):
        """No second fetch, against a five-a-minute quota.

        It also guarantees the two views cannot disagree: a fetched 4-hour
        series could carry a high that never appears in these hourly bars.
        """

        from app.services.backtest_service import BacktestService

        candles = self.hourly()
        states = BacktestService._bias_states(
            self.request(higher_timeframe="4h"), candles
        )

        assert states, "400 hours of demo data breaks structure somewhere"
        for state in states:
            assert state.known_from == state.time + 4 * HOUR

    def test_no_higher_timeframe_means_no_bias_rather_than_an_error(self):
        from app.services.backtest_service import BacktestService

        assert BacktestService._bias_states(self.request(), self.hourly()) == []

    def test_a_bias_state_is_never_knowable_before_its_own_bar_closes(self):
        """The multi-timeframe lookahead, stated as the property it is.

        Every state must become knowable strictly after the higher-timeframe
        bar it came from opened, by exactly one bar's width.
        """

        from app.services.backtest_service import BacktestService

        states = BacktestService._bias_states(
            self.request(higher_timeframe="1d"), self.hourly(800)
        )

        assert states
        for state in states:
            assert state.known_from > state.time

    def test_the_notes_name_every_condition_that_was_applied(self):
        from app.services.backtest_service import BacktestService

        lines = BacktestService._conditions_applied(
            self.request(
                higher_timeframe="4h",
                detectors={
                    "require_higher_timeframe_bias": True,
                    "require_reaction": True,
                    "min_wick_ratio": 0.6,
                    "entry_model": "fib_retrace",
                    "sessions": ["london"],
                },
            )
        )

        joined = " ".join(lines)
        assert "4h" in joined
        assert "60%" in joined
        assert "retracement" in joined
        assert "London" in joined
        # And the standing promise about how they are read.
        assert "only what had been confirmed" in joined

    def test_a_run_asking_for_nothing_still_says_nothing(self):
        from app.services.backtest_service import BacktestService

        assert BacktestService._conditions_applied(self.request()) == []

    def test_the_session_filter_actually_removes_matches(self):
        """End to end through the service's own condition path.

        The same entry bar, asked for in a session it is in and one it is
        not, has to give opposite answers -- otherwise the filter is wired up
        but inert, which no unit test of `session_at` would catch.
        """

        from app.services.backtest_service import BacktestService

        candles = self.hourly()
        context = {"gaps": [], "swings": [], "divergences": [], "pools": [], "bias": []}
        # Pick a bar and read which session it actually fell in.
        index = 100
        from app.analysis.sessions import SESSIONS, local_minute

        minute = local_minute(candles[index].time)
        inside = next(
            (key for key, window in SESSIONS.items() if window.contains_minute(minute)),
            None,
        )
        outside = next(
            key for key, window in SESSIONS.items() if not window.contains_minute(minute)
        )

        refused = BacktestService._condition_reason(
            BacktestService,
            candles=candles,
            end_index=index,
            request=self.request(detectors={"sessions": [outside]}),
            context=context,
            within_ms=10 * HOUR,
        )
        assert refused is not None and "outside every session" in refused

        if inside is not None:
            allowed = BacktestService._condition_reason(
                BacktestService,
                candles=candles,
                end_index=index,
                request=self.request(detectors={"sessions": [inside]}),
                context=context,
                within_ms=10 * HOUR,
            )
            assert allowed is None
