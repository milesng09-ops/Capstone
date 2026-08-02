"""Database engine and session management.

Only this module knows that the default backend is SQLite.  Everything else
talks to SQLAlchemy sessions, so pointing ``DATABASE_URL`` at PostgreSQL is
enough to switch engines.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.models.db_models import Base

logger = logging.getLogger(__name__)

_engine: Engine | None = None
_SessionFactory: sessionmaker[Session] | None = None


def _configure_sqlite(engine: Engine) -> None:
    """Apply pragmas that matter for a local read-heavy cache."""

    @event.listens_for(engine, "connect")
    def _set_pragmas(dbapi_connection, _record):  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def get_engine() -> Engine:
    global _engine, _SessionFactory
    if _engine is None:
        settings = get_settings()
        url = settings.resolved_database_url
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(
            url,
            future=True,
            echo=False,
            connect_args=connect_args,
            pool_pre_ping=True,
        )
        if url.startswith("sqlite"):
            _configure_sqlite(_engine)
        _SessionFactory = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
        logger.info("Database engine created (%s)", url.split("///")[0])
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    get_engine()
    assert _SessionFactory is not None
    return _SessionFactory


def init_database() -> None:
    """Create tables if they do not exist yet."""

    engine = get_engine()
    Base.metadata.create_all(engine)
    logger.info("Database schema ready")


def dispose_database() -> None:
    global _engine, _SessionFactory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionFactory = None


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope around a series of operations."""

    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""

    with session_scope() as session:
        yield session


def database_health() -> str:
    try:
        with session_scope() as session:
            session.execute(text("SELECT 1"))
        return "connected"
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Database health check failed: %s", exc)
        return "unavailable"
