"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import Header

from app.services.backtest_service import BacktestService, get_backtest_service
from app.services.candle_service import CandleService, get_candle_service
from app.services.ict_service import IctService, get_ict_service


def candle_service() -> CandleService:
    return get_candle_service()


def backtest_service() -> BacktestService:
    return get_backtest_service()


def ict_service() -> IctService:
    return get_ict_service()


def session_id(x_session_id: str | None = Header(default=None)) -> str:
    """Identify the caller for the one-backtest-at-a-time rule.

    The frontend generates a random id per browser tab.  When the header is
    absent we fall back to a shared bucket, which still prevents an unbounded
    number of concurrent jobs.
    """

    return x_session_id or "anonymous"
