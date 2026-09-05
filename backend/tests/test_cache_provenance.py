"""Keeping generated bars out of a series of real prices.

A chart draws every candle the same way. Nothing on screen says which ones a
provider sent and which ones a seeded generator invented while that provider
was down, so a series holding both is a series that cannot be read honestly --
and a backtest across the join reports a win rate that is neither measured nor
simulated.

These tests pin the invariant: a series is either real or generated, and the
label it is served under describes what it holds rather than who wrote to it
last.
"""

from __future__ import annotations

from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.database.repository import (
    DEMO_PROVIDER,
    TimeRange,
    drop_demo_candles,
    has_real_candles,
    load_coverage,
    providers_in_range,
    record_coverage,
    repair_mixed_series,
    save_candles,
)
from app.models.db_models import Base
from app.models.domain import Candle

HOUR = 3_600_000
T0 = 1_780_000_000_000

#: Saturday 2026-05-30 00:00 America/Chicago, plus twelve hours. Read off a
#: calendar rather than computed, so a failure means the session rule moved.
CLOSED_WEEKEND = TimeRange(1_780_117_200_000, 1_780_117_200_000 + 12 * 3_600_000)


@pytest.fixture
def session() -> Session:
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    with Session(bind=engine, expire_on_commit=False) as session:
        yield session


def candles(symbol: str, count: int, *, start: int = T0) -> list[Candle]:
    return [
        Candle(
            symbol=symbol,
            time=start + index * HOUR,
            open=100.0,
            high=101.0,
            low=99.0,
            close=100.5,
            volume=1_000,
        )
        for index in range(count)
    ]


# --------------------------------------------------------------------------
class TestProvenanceQueries:
    def test_a_fresh_series_holds_nothing_real(self, session):
        assert has_real_candles(session, "ES", "1h") is False

    def test_a_demo_only_series_still_holds_nothing_real(self, session):
        save_candles(session, "1h", candles("ES", 3), DEMO_PROVIDER)
        assert has_real_candles(session, "ES", "1h") is False

    def test_one_fetched_bar_makes_the_series_real(self, session):
        save_candles(session, "1h", candles("ES", 1), "massive")
        assert has_real_candles(session, "ES", "1h") is True

    def test_provenance_is_reported_per_window(self, session):
        save_candles(session, "1h", candles("ES", 3), DEMO_PROVIDER)
        save_candles(session, "1h", candles("ES", 3, start=T0 + 10 * HOUR), "massive")

        early = providers_in_range(session, "ES", "1h", T0, T0 + 2 * HOUR)
        late = providers_in_range(session, "ES", "1h", T0 + 10 * HOUR, T0 + 12 * HOUR)
        whole = providers_in_range(session, "ES", "1h", T0, T0 + 12 * HOUR)

        assert early == {DEMO_PROVIDER}
        assert late == {"massive"}
        # The window a chart would request spans both, and says so.
        assert whole == {DEMO_PROVIDER, "massive"}

    def test_another_symbol_is_not_counted(self, session):
        save_candles(session, "1h", candles("NQ", 2), DEMO_PROVIDER)
        assert providers_in_range(session, "ES", "1h", T0, T0 + 5 * HOUR) == set()


# --------------------------------------------------------------------------
class TestDroppingGeneratedBars:
    def test_it_removes_only_the_generated_bars(self, session):
        save_candles(session, "1h", candles("ES", 3), DEMO_PROVIDER)
        save_candles(session, "1h", candles("ES", 2, start=T0 + 10 * HOUR), "massive")

        removed = drop_demo_candles(session, "ES", "1h")

        assert removed == 3
        assert providers_in_range(session, "ES", "1h", T0, T0 + 20 * HOUR) == {"massive"}

    def test_it_drops_the_coverage_that_vouched_for_them(self, session):
        # Coverage rows are merged as they are recorded, so one can vouch for
        # bars from a provider it is not named after. Left behind, it would
        # report the now-empty range as already fetched.
        save_candles(session, "1h", candles("ES", 3), DEMO_PROVIDER)
        record_coverage(session, "ES", "1h", T0, T0 + 3 * HOUR, DEMO_PROVIDER)
        assert load_coverage(session, "ES", "1h") == [TimeRange(T0, T0 + 3 * HOUR)]

        drop_demo_candles(session, "ES", "1h")

        assert load_coverage(session, "ES", "1h") == []

    def test_it_leaves_coverage_alone_when_there_was_nothing_to_drop(self, session):
        save_candles(session, "1h", candles("ES", 2), "massive")
        record_coverage(session, "ES", "1h", T0, T0 + 2 * HOUR, "massive")

        assert drop_demo_candles(session, "ES", "1h") == 0
        assert load_coverage(session, "ES", "1h") == [TimeRange(T0, T0 + 2 * HOUR)]


# --------------------------------------------------------------------------
class TestRepairingMixedSeries:
    def test_a_mixed_series_loses_its_generated_half(self, session):
        save_candles(session, "1h", candles("ES", 4), DEMO_PROVIDER)
        save_candles(session, "1h", candles("ES", 2, start=T0 + 10 * HOUR), "yahoo")

        removed = repair_mixed_series(session)

        assert removed == {("ES", "1h"): 4}
        assert providers_in_range(session, "ES", "1h", T0, T0 + 20 * HOUR) == {"yahoo"}

    def test_an_all_demo_series_is_left_alone(self, session):
        # The no-API-key path. Nothing is being passed off as real, so there is
        # nothing to repair.
        save_candles(session, "1h", candles("YM", 5), DEMO_PROVIDER)

        assert repair_mixed_series(session) == {}
        assert providers_in_range(session, "YM", "1h", T0, T0 + 5 * HOUR) == {
            DEMO_PROVIDER
        }

    def test_an_all_real_series_is_left_alone(self, session):
        save_candles(session, "1h", candles("NQ", 5), "massive")
        record_coverage(session, "NQ", "1h", T0, T0 + 5 * HOUR, "massive")

        assert repair_mixed_series(session) == {}
        assert load_coverage(session, "NQ", "1h") == [TimeRange(T0, T0 + 5 * HOUR)]

    def test_each_series_is_judged_on_its_own(self, session):
        save_candles(session, "1h", candles("ES", 2), DEMO_PROVIDER)
        save_candles(session, "1h", candles("ES", 2, start=T0 + 5 * HOUR), "massive")
        save_candles(session, "1h", candles("YM", 3), DEMO_PROVIDER)

        removed = repair_mixed_series(session)

        assert set(removed) == {("ES", "1h")}
        assert providers_in_range(session, "YM", "1h", T0, T0 + 3 * HOUR) == {
            DEMO_PROVIDER
        }

    def test_it_is_safe_to_run_again(self, session):
        save_candles(session, "1h", candles("ES", 2), DEMO_PROVIDER)
        save_candles(session, "1h", candles("ES", 2, start=T0 + 5 * HOUR), "massive")

        repair_mixed_series(session)
        assert repair_mixed_series(session) == {}


# --------------------------------------------------------------------------
class TestWhatTheServiceStores:
    """The invariant as the candle service applies it, one fetched range at a time."""

    @pytest.fixture(autouse=True)
    def _redirect_sessions(self, session, monkeypatch):
        from app.services import candle_service as module

        @contextmanager
        def scope():
            yield session

        monkeypatch.setattr(module, "session_scope", scope)

    @staticmethod
    def _persist(
        symbol: str, bars: list[Candle], provider: str, span: TimeRange | None = None
    ) -> bool:
        from app.services.candle_service import CandleService

        return CandleService._persist(
            symbol, "1h", bars, provider, span or TimeRange(T0, T0 + 100 * HOUR)
        )

    def test_generated_bars_are_declined_for_a_series_of_real_prices(self, session):
        save_candles(session, "1h", candles("ES", 2), "massive")

        stored = self._persist("ES", candles("ES", 3, start=T0 + 50 * HOUR), DEMO_PROVIDER)

        assert stored is False
        # Nothing written, and no coverage claiming the range was filled --
        # the caller reports it as a range it could not fetch instead.
        assert providers_in_range(session, "ES", "1h", T0, T0 + 100 * HOUR) == {"massive"}
        assert load_coverage(session, "ES", "1h") == []

    def test_generated_bars_are_stored_for_a_series_that_has_no_real_prices(self, session):
        # The no-API-key path has to keep working.
        stored = self._persist("YM", candles("YM", 3), DEMO_PROVIDER)

        assert stored is True
        assert providers_in_range(session, "YM", "1h", T0, T0 + 3 * HOUR) == {
            DEMO_PROVIDER
        }

    def test_real_bars_evict_the_generated_ones_they_replace(self, session):
        save_candles(session, "1h", candles("NQ", 4), DEMO_PROVIDER)

        stored = self._persist("NQ", candles("NQ", 2, start=T0 + 50 * HOUR), "massive")

        assert stored is True
        assert providers_in_range(session, "NQ", "1h", T0, T0 + 100 * HOUR) == {"massive"}

    def test_an_empty_range_over_a_closed_market_is_recorded_as_covered(self, session):
        # Saturday, read off a calendar: the market is shut all day, so an
        # empty answer is the right one. The range is settled and must not be
        # refetched on every request.
        assert self._persist("ES", [], "massive", CLOSED_WEEKEND) is True
        assert load_coverage(session, "ES", "1h") != []

    def test_an_empty_range_over_an_open_market_is_not_recorded_as_covered(self, session):
        # Thursday afternoon to Monday evening -- four trading days. Nothing
        # came back, so we were not served; covering it would make the hole
        # permanent, because `missing_ranges` would never ask again.
        assert self._persist("ES", [], "massive") is False
        assert load_coverage(session, "ES", "1h") == []

    def test_coverage_stops_where_the_bars_stop(self, session):
        # A provider that trims the window to its own retention limit answers
        # for part of the range. Covering the whole of it would record data we
        # never received as permanently present.
        span = TimeRange(T0, T0 + 100 * HOUR)
        assert self._persist("ES", candles("ES", 3), "yahoo", span) is True

        covered = load_coverage(session, "ES", "1h")
        assert covered != []
        # Three hourly bars from T0, so coverage ends one bar after the last.
        assert max(entry.end for entry in covered) == T0 + 3 * HOUR
