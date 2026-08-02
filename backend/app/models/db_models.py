"""SQLAlchemy ORM models.

The schema deliberately avoids SQLite-only constructs so that swapping the
engine URL for PostgreSQL is the only change required.  ``JSON`` columns are
portable, integers are used for millisecond timestamps, and every index is
declared explicitly.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


class Base(DeclarativeBase):
    pass


class InstrumentRow(Base):
    __tablename__ = "instruments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(128))
    exchange: Mapped[str] = mapped_column(String(32), default="CME")
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    asset_type: Mapped[str] = mapped_column(String(16), default="future")
    timezone: Mapped[str] = mapped_column(String(64), default="America/Chicago")
    price_precision: Mapped[int] = mapped_column(Integer, default=2)
    tick_size: Mapped[float] = mapped_column(Float, default=0.25)


class CandleRow(Base):
    """Local OHLCV cache.

    ``(symbol, interval, timestamp)`` is unique -- this is what makes cache
    merging idempotent and removes duplicate timestamps at the storage layer.
    """

    __tablename__ = "candles"
    __table_args__ = (
        UniqueConstraint("symbol", "interval", "timestamp", name="uq_candle_key"),
        Index("ix_candle_lookup", "symbol", "interval", "timestamp"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(16))
    interval: Mapped[str] = mapped_column(String(8))
    timestamp: Mapped[int] = mapped_column(Integer)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float, default=0.0)
    provider: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[int] = mapped_column(Integer)


class CacheCoverageRow(Base):
    """Records which time ranges have already been fetched.

    Without this we cannot tell "no data because the market was closed" from
    "no data because we never asked", which would make incremental fetching
    impossible.
    """

    __tablename__ = "cache_coverage"
    __table_args__ = (
        Index("ix_coverage_lookup", "symbol", "interval", "start_time", "end_time"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(16))
    interval: Mapped[str] = mapped_column(String(8))
    start_time: Mapped[int] = mapped_column(Integer)
    end_time: Mapped[int] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[int] = mapped_column(Integer)


class BacktestRow(Base):
    __tablename__ = "backtests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[int] = mapped_column(Integer, index=True)
    primary_symbol: Mapped[str] = mapped_column(String(16))
    symbols: Mapped[list] = mapped_column(JSON, default=list)
    interval: Mapped[str] = mapped_column(String(8))
    selection_start: Mapped[int] = mapped_column(Integer)
    selection_end: Mapped[int] = mapped_column(Integer)
    configuration_json: Mapped[dict] = mapped_column(JSON, default=dict)
    provider: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="pending")
    error_message: Mapped[str | None] = mapped_column(String(512), nullable=True)
    summary_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    matches: Mapped[list["PatternMatchRow"]] = relationship(
        back_populates="backtest", cascade="all, delete-orphan"
    )
    trades: Mapped[list["TradeRow"]] = relationship(
        back_populates="backtest", cascade="all, delete-orphan"
    )


class PatternMatchRow(Base):
    __tablename__ = "pattern_matches"
    __table_args__ = (Index("ix_match_backtest", "backtest_id", "similarity_score"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    backtest_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("backtests.id", ondelete="CASCADE"), index=True
    )
    symbol: Mapped[str] = mapped_column(String(16))
    interval: Mapped[str] = mapped_column(String(8))
    start_time: Mapped[int] = mapped_column(Integer)
    end_time: Mapped[int] = mapped_column(Integer)
    similarity_score: Mapped[float] = mapped_column(Float)
    euclidean_distance: Mapped[float] = mapped_column(Float, default=0.0)
    entry_price: Mapped[float] = mapped_column(Float)
    rank: Mapped[int] = mapped_column(Integer, default=0)
    normalized_series: Mapped[list | None] = mapped_column(JSON, nullable=True)

    backtest: Mapped[BacktestRow] = relationship(back_populates="matches")


class TradeRow(Base):
    __tablename__ = "trades"
    __table_args__ = (Index("ix_trade_backtest", "backtest_id", "entry_time"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    backtest_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("backtests.id", ondelete="CASCADE"), index=True
    )
    pattern_match_id: Mapped[str] = mapped_column(String(36), index=True)
    trade_number: Mapped[int] = mapped_column(Integer, default=0)
    symbol: Mapped[str] = mapped_column(String(16))
    direction: Mapped[str] = mapped_column(String(8))
    entry_time: Mapped[int] = mapped_column(Integer)
    exit_time: Mapped[int] = mapped_column(Integer)
    entry_price: Mapped[float] = mapped_column(Float)
    exit_price: Mapped[float] = mapped_column(Float)
    stop_price: Mapped[float] = mapped_column(Float)
    target_price: Mapped[float] = mapped_column(Float)
    gross_return: Mapped[float] = mapped_column(Float)
    fees: Mapped[float] = mapped_column(Float)
    net_return: Mapped[float] = mapped_column(Float)
    exit_reason: Mapped[str] = mapped_column(String(24))
    holding_bars: Mapped[int] = mapped_column(Integer, default=0)
    similarity_score: Mapped[float] = mapped_column(Float, default=0.0)
    same_bar_ambiguity: Mapped[bool] = mapped_column(default=False)

    backtest: Mapped[BacktestRow] = relationship(back_populates="trades")
