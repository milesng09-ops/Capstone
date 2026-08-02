"""Public REST API.

Error handling policy: users never see raw exceptions.  Provider, validation
and storage problems are translated into short, actionable messages here; the
full detail goes to the server log.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app import __version__
from app.api.deps import backtest_service, candle_service, session_id
from app.config import get_settings
from app.database.repository import (
    cache_statistics,
    clear_cache,
    last_fetch_time,
    list_backtests,
)
from app.database.session import database_health, session_scope
from app.models.domain import ProviderStatus
from app.models.schemas import (
    BacktestListItem,
    BacktestListResponse,
    BacktestRequest,
    BacktestResponse,
    BarsResponse,
    CacheStatsResponse,
    CacheSymbolStat,
    FallbackEvent,
    HealthResponse,
    MessageResponse,
    ProviderStatusResponse,
    SymbolsResponse,
    TradesResponse,
)
from app.providers.health import get_health_registry
from app.providers.instruments import UnknownSymbolError, list_instruments
from app.services.backtest_service import (
    BacktestBusyError,
    BacktestService,
    BacktestValidationError,
)
from app.services.candle_service import CandleService, RequestTooLargeError
from app.utils.intervals import (
    INTERVAL_ORDER,
    UnsupportedIntervalError,
    normalise_resolution,
)
from app.utils.timeutils import parse_time_param

logger = logging.getLogger(__name__)

api_router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------
# Health and provider status
# --------------------------------------------------------------------------
@api_router.get("/health", response_model=HealthResponse, tags=["status"])
async def health(
    service: Annotated[CandleService, Depends(candle_service)],
) -> HealthResponse:
    settings = get_settings()
    chain = service.provider.chain()
    active = service.provider.last_active_provider or (chain[0] if chain else "demo")
    preferred = chain[0] if chain else "demo"
    return HealthResponse(
        status="ok",
        provider=active,
        fallback_active=active != preferred,
        database=database_health(),
        version=__version__,
        environment=settings.environment,
    )


@api_router.get("/providers/status", response_model=ProviderStatusResponse, tags=["status"])
async def providers_status(
    service: Annotated[CandleService, Depends(candle_service)],
) -> ProviderStatusResponse:
    settings = get_settings()
    registry = get_health_registry()
    snapshot = registry.snapshot()
    chain = service.provider.chain()
    preferred = chain[0] if chain else "demo"
    active = service.provider.last_active_provider or preferred

    statuses: list[ProviderStatus] = []
    for name, provider in service.provider.providers.items():
        entry = snapshot.get(name)
        configured = await provider.is_configured()
        notes = None
        if name == "massive" and not settings.massive_api_key_configured:
            notes = "MASSIVE_API_KEY is not set. Add it to .env to enable this provider."
        elif name == "yahoo" and not configured:
            notes = "The yfinance package is not installed in the backend environment."
        elif name == "demo":
            notes = "Bundled synthetic data. Always available, never real market prices."
        statuses.append(
            ProviderStatus(
                name=name,
                display_name=provider.display_name,
                configured=configured,
                available=name in chain,
                healthy=registry.is_available(name) and configured,
                last_error=entry.last_error if entry else None,
                last_checked_ms=entry.last_checked_ms if entry else None,
                cooldown_until_ms=entry.cooldown_until_ms if entry else None,
                notes=notes,
            )
        )

    return ProviderStatusResponse(
        active_provider=active,
        requested_provider=settings.data_provider,
        fallback_active=active != preferred,
        fallback_reason=service.provider.last_fallback_reason,
        massive_api_key_configured=settings.massive_api_key_configured,
        providers=statuses,
        fallback_history=[
            FallbackEvent(
                timestamp_ms=record.timestamp_ms,
                from_provider=record.from_provider,
                to_provider=record.to_provider,
                reason=record.reason,
            )
            for record in registry.history()
        ],
    )


# --------------------------------------------------------------------------
# Symbols
# --------------------------------------------------------------------------
@api_router.get("/symbols", response_model=SymbolsResponse, tags=["market-data"])
async def symbols(
    service: Annotated[CandleService, Depends(candle_service)],
) -> SymbolsResponse:
    try:
        instruments = await service.provider.get_symbols()
    except Exception:  # noqa: BLE001 - the catalogue is static, always answer
        logger.exception("Provider symbol lookup failed; serving the static catalogue")
        instruments = list_instruments()
    return SymbolsResponse(symbols=instruments)


@api_router.get("/intervals", response_model=list[str], tags=["market-data"])
async def intervals() -> list[str]:
    return INTERVAL_ORDER


# --------------------------------------------------------------------------
# Bars
# --------------------------------------------------------------------------
@api_router.get("/bars", response_model=BarsResponse, tags=["market-data"])
async def bars(
    service: Annotated[CandleService, Depends(candle_service)],
    symbol: str = Query(..., description="Canonical symbol: ES, NQ or YM"),
    interval: str = Query("1h", description="One of 5m, 15m, 1h, 4h, 6h, 1d"),
    from_: str = Query(..., alias="from", description="Start time (Unix ms, s, or ISO-8601)"),
    to: str = Query(..., description="End time (Unix ms, s, or ISO-8601)"),
    refresh: bool = Query(False, description="Bypass the cache for this window"),
) -> BarsResponse:
    try:
        resolved_interval = normalise_resolution(interval)
        start = parse_time_param(from_)
        end = parse_time_param(to)
    except (UnsupportedIntervalError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    try:
        result = await service.get_bars(
            symbol, resolved_interval, start, end, force_refresh=refresh
        )
    except UnknownSymbolError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except RequestTooLargeError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Bar request failed for %s %s", symbol, interval)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Market data is temporarily unavailable. Please try again.",
        ) from exc

    return BarsResponse(**result.model_dump())


# --------------------------------------------------------------------------
# Backtests
# --------------------------------------------------------------------------
@api_router.post(
    "/backtests",
    response_model=BacktestResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["backtesting"],
)
async def create_backtest_run(
    request: BacktestRequest,
    service: Annotated[BacktestService, Depends(backtest_service)],
    caller: Annotated[str, Depends(session_id)],
) -> BacktestResponse:
    try:
        return await service.run(request, caller)
    except BacktestBusyError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except (BacktestValidationError, RequestTooLargeError, UnknownSymbolError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    except UnsupportedIntervalError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Backtest failed")
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "The backtest could not be completed. Check the server log for details.",
        ) from exc


@api_router.get("/backtests", response_model=BacktestListResponse, tags=["backtesting"])
async def list_backtest_runs() -> BacktestListResponse:
    with session_scope() as session:
        rows = list_backtests(session)
        items = []
        for row in rows:
            summary = row.summary_json or {}
            items.append(
                BacktestListItem(
                    id=row.id,
                    created_at=row.created_at,
                    primary_symbol=row.primary_symbol,
                    interval=row.interval,
                    status=row.status,
                    trades_executed=summary.get("trades_executed"),
                    win_rate=summary.get("win_rate"),
                    net_return=summary.get("net_return"),
                )
            )
    return BacktestListResponse(backtests=items)


@api_router.get("/backtests/{backtest_id}", response_model=BacktestResponse, tags=["backtesting"])
async def get_backtest_run(
    backtest_id: str,
    service: Annotated[BacktestService, Depends(backtest_service)],
) -> BacktestResponse:
    result = await service.load(backtest_id)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Backtest not found")
    return result


@api_router.get(
    "/backtests/{backtest_id}/trades", response_model=TradesResponse, tags=["backtesting"]
)
async def get_backtest_trades(
    backtest_id: str,
    service: Annotated[BacktestService, Depends(backtest_service)],
) -> TradesResponse:
    result = await service.load(backtest_id)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Backtest not found")
    return TradesResponse(backtest_id=backtest_id, trades=result.trades)


# --------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------
@api_router.get("/cache", response_model=CacheStatsResponse, tags=["cache"])
async def cache_status() -> CacheStatsResponse:
    settings = get_settings()
    with session_scope() as session:
        stats = cache_statistics(session)
        fetched = last_fetch_time(session)
    return CacheStatsResponse(
        total_candles=sum(item["candles"] for item in stats),
        per_symbol=[CacheSymbolStat(**item) for item in stats],
        database_path=settings.resolved_database_url,
        last_fetch_ms=fetched,
    )


@api_router.delete("/cache", response_model=MessageResponse, tags=["cache"])
async def delete_cache(
    symbol: str | None = Query(None, description="Limit the purge to one symbol"),
) -> MessageResponse:
    settings = get_settings()
    if not settings.is_development:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Cache deletion is only available in development mode.",
        )
    with session_scope() as session:
        removed = clear_cache(session, symbol)
    target = symbol or "all symbols"
    return MessageResponse(
        message=f"Cleared {removed:,} cached candles for {target}.",
        detail="Charts will refetch from the active provider on the next request.",
    )
