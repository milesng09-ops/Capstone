"""How the SQLite engine is configured, where it decides whether requests fail."""

from sqlalchemy import text

from app.config import reset_settings_cache
from app.database import session


def test_a_busy_database_is_waited_for_rather_than_failed(tmp_path, monkeypatch):
    # Nine series loading at once write from worker threads. SQLite's default
    # five-second wait was not enough, and the loser answered 503 with its
    # fetched bars thrown away.
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'busy.db').as_posix()}")
    reset_settings_cache()
    session.dispose_database()
    try:
        with session.get_engine().connect() as connection:
            assert connection.execute(text("PRAGMA busy_timeout")).scalar() >= 30_000
    finally:
        session.dispose_database()
        reset_settings_cache()
