"""One series holds one provider's prices.

Two real providers are not two views of one price.  Massive serves individual
futures contracts stitched into a front-month series that is deliberately not
back-adjusted; Yahoo's ``NQ=F`` is its own continuous contract, rolling on its
own dates.  Between rolls they agree closely.  After one they do not.

This is not hypothetical.  On 2026-09-12 this project's own cache held a
2,965-bar Massive NQ series with two Yahoo bars in it, and the Yahoo close at
2026-09-11 20:00 was 291.50 points below the neighbouring Massive bar, while
the June bar in the same series was out by 10.25.  Drawn as one line that is a
cliff in the middle of the chart -- reported from the review call as a gap
"that is not in the real contract".

The existing provenance rule covered real against generated.  These cases
cover real against real, which is the same defect with no invented data in it.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.database.repository import (
    PROVIDER_PREFERENCE,
    REAL_PROVIDERS,
    drop_provider_candles,
    providers_in_series,
    record_coverage,
    repair_mixed_real_series,
    repair_mixed_series,
    save_candles,
    series_owner,
)
from app.models.db_models import Base, CacheCoverageRow
from app.models.domain import Candle

HOUR_MS = 3_600_000


@pytest.fixture()
def session() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as db:
        yield db


def bars(count: int, *, start: int = 1_700_000_000_000, price: float = 29_000.0):
    return [
        Candle(
            symbol="NQ",
            time=start + index * HOUR_MS,
            open=price,
            high=price + 10,
            low=price - 10,
            close=price,
            volume=100,
        )
        for index in range(count)
    ]


def store(session: Session, provider: str, count: int, *, start: int, price: float) -> None:
    save_candles(session, "1h", bars(count, start=start, price=price), provider)


class TestWhoOwnsASeries:
    def test_nothing_owns_an_empty_series(self, session):
        assert series_owner(session, "NQ", "1h") is None

    def test_the_only_real_provider_owns_it(self, session):
        store(session, "yahoo", 3, start=1_700_000_000_000, price=29_000)

        assert series_owner(session, "NQ", "1h") == "yahoo"

    def test_the_preferred_provider_wins_when_both_are_present(self, session):
        store(session, "yahoo", 3, start=1_700_000_000_000, price=29_000)
        store(session, "massive", 3, start=1_800_000_000_000, price=29_300)

        assert series_owner(session, "NQ", "1h") == "massive"

    def test_generated_bars_do_not_own_anything(self, session):
        # The demo feed is handled by the other rule entirely; it must not
        # come out of this one as an owner that can lock a real provider out.
        store(session, "demo", 5, start=1_700_000_000_000, price=1.5)

        assert series_owner(session, "NQ", "1h") is None

    def test_the_preference_only_names_real_providers(self):
        assert set(PROVIDER_PREFERENCE) <= REAL_PROVIDERS

    def test_the_preference_ranks_every_real_provider(self):
        # A real provider missing from the order falls back to an alphabetical
        # tie-break, which is a silent decision about whose prices win.
        assert set(PROVIDER_PREFERENCE) == REAL_PROVIDERS


class TestRebasingAMixedSeries:
    def test_the_minority_provider_is_evicted(self, session):
        store(session, "massive", 10, start=1_700_000_000_000, price=29_000)
        store(session, "yahoo", 2, start=1_800_000_000_000, price=28_700)

        removed = repair_mixed_real_series(session)

        assert removed == {("NQ", "1h"): 2}
        assert providers_in_series(session, "NQ", "1h") == {"massive"}

    def test_the_owner_is_kept_even_when_it_is_outnumbered(self, session):
        # Bar count is not the question. Which series the chart is *of* is.
        store(session, "massive", 2, start=1_700_000_000_000, price=29_000)
        store(session, "yahoo", 50, start=1_800_000_000_000, price=28_700)

        repair_mixed_real_series(session)

        assert providers_in_series(session, "NQ", "1h") == {"massive"}

    def test_a_series_from_one_provider_is_left_alone(self, session):
        store(session, "yahoo", 10, start=1_700_000_000_000, price=29_000)

        assert repair_mixed_real_series(session) == {}
        assert providers_in_series(session, "NQ", "1h") == {"yahoo"}

    def test_coverage_goes_with_the_evicted_bars(self, session):
        """A coverage row that outlived its candles is worse than none: it
        says "already fetched" about a stretch that is now empty."""

        store(session, "massive", 10, start=1_700_000_000_000, price=29_000)
        store(session, "yahoo", 2, start=1_800_000_000_000, price=28_700)
        record_coverage(
            session, "NQ", "1h", 1_700_000_000_000, 1_900_000_000_000, "massive"
        )

        repair_mixed_real_series(session)

        assert session.query(CacheCoverageRow).count() == 0

    def test_it_leaves_the_generated_repair_something_to_do(self, session):
        """The two rules are separate and both have to run: this one reduces
        a series to one *real* provider and says nothing about demo bars."""

        store(session, "massive", 5, start=1_700_000_000_000, price=29_000)
        store(session, "yahoo", 2, start=1_800_000_000_000, price=28_700)
        store(session, "demo", 5, start=1_900_000_000_000, price=1.5)

        repair_mixed_real_series(session)
        assert providers_in_series(session, "NQ", "1h") == {"massive", "demo"}

        repair_mixed_series(session)
        assert providers_in_series(session, "NQ", "1h") == {"massive"}


class TestDroppingOneProvider:
    def test_it_removes_only_that_provider(self, session):
        store(session, "massive", 4, start=1_700_000_000_000, price=29_000)
        store(session, "yahoo", 3, start=1_800_000_000_000, price=28_700)

        assert drop_provider_candles(session, "NQ", "1h", "yahoo") == 3
        assert providers_in_series(session, "NQ", "1h") == {"massive"}

    def test_removing_nothing_leaves_coverage_intact(self, session):
        store(session, "massive", 4, start=1_700_000_000_000, price=29_000)
        record_coverage(
            session, "NQ", "1h", 1_700_000_000_000, 1_800_000_000_000, "massive"
        )

        assert drop_provider_candles(session, "NQ", "1h", "yahoo") == 0
        assert session.query(CacheCoverageRow).count() == 1
