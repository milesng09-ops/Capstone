from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.database.repository import retain_provider_cache
from app.models.db_models import Base, CandleRow, CacheCoverageRow, BacktestRow
from app.providers.massive_provider import MASSIVE_INTERVAL_MAP


def test_strict_source_invalidates_foreign_cache_and_preserves_saved_runs():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        for i, provider in enumerate(["massive", "yahoo", "demo"]):
            session.add(CandleRow(symbol="ES", interval="1h", timestamp=i, open=1, high=2,
                                 low=1, close=2, provider=provider, fetched_at=0))
        session.add(CacheCoverageRow(symbol="ES", interval="1h", start_time=0, end_time=3,
                                     provider="massive", fetched_at=0))
        session.add(BacktestRow(id="saved", created_at=0, primary_symbol="ES", symbols=["ES"],
                               interval="1h", selection_start=0, selection_end=1, provider="yahoo"))
        session.flush()
        assert retain_provider_cache(session, "massive") == 2
        assert [r.provider for r in session.scalars(select(CandleRow))] == ["massive"]
        assert not list(session.scalars(select(CacheCoverageRow)))
        assert session.get(BacktestRow, "saved") is not None
        assert retain_provider_cache(session, "massive") == 0
    engine.dispose()


def test_massive_daily_resolution_uses_exchange_session():
    assert MASSIVE_INTERVAL_MAP["1d"] == "1 session"
