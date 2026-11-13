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
from app.api.deps import backtest_jobs, backtest_service, candle_service, ict_service, session_id
from app.backtesting.attempts import describe_configuration
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
    BacktestJobResponse,
    BacktestListItem,
    BacktestListResponse,
    BacktestRequest,
    BacktestResponse,
    BarsResponse,
    CacheStatsResponse,
    CacheSymbolStat,
    FallbackEvent,
    HealthResponse,
    IctAnalysisResponse,
    MessageResponse,
    ProviderStatusResponse,
    SymbolsResponse,
    TradesResponse,
)
from app.providers.base import ProviderRateLimitError
from app.providers.health import get_health_registry
from app.providers.instruments import UnknownSymbolError, get_instrument, list_instruments
from app.services.backtest_jobs import BacktestJob, BacktestJobs
from app.services.backtest_service import (
    BacktestBusyError,
    BacktestService,
    BacktestValidationError,
)
from app.services.candle_service import CandleService, RequestTooLargeError
from app.services.ict_service import IctService
from app.utils.intervals import (
    INTERVAL_ORDER,
    UnsupportedIntervalError,
    normalise_resolution,
)
from app.utils.timeutils import TimestampOutOfRangeError, parse_time_param

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
            notes = (
                "Bundled synthetic data, never real market prices. Reachable only by "
                "setting DATA_PROVIDER=demo; it is not an automatic fallback."
            )
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
                rate_limited=bool(entry and entry.rate_limited),
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
    except ProviderRateLimitError as exc:
        # 429 rather than 503: the difference is "wait" versus "something is
        # broken", and only one of those tells the user what to do.
        retry_after = int(exc.retry_after_seconds or 60)
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"{exc} No market data was served, because generated bars are not "
            f"substituted for real prices. Try again in about {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Bar request failed for %s %s", symbol, interval)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Market data is temporarily unavailable. Please try again.",
        ) from exc

    return BarsResponse(**result.model_dump())


# --------------------------------------------------------------------------
# ICT analysis
# --------------------------------------------------------------------------
@api_router.get("/ict", response_model=IctAnalysisResponse, tags=["analysis"])
async def ict_analysis(
    service: Annotated[IctService, Depends(ict_service)],
    symbol: str = Query(..., description="Chart being analysed: ES, NQ or YM"),
    interval: str = Query("1h", description="One of 5m, 15m, 1h, 4h, 6h, 1d"),
    from_: str = Query(..., alias="from", description="Start time (Unix ms, s, or ISO-8601)"),
    to: str = Query(..., description="End time (Unix ms, s, or ISO-8601)"),
    reference: str | None = Query(
        None,
        description=(
            "Comma-separated correlated symbols to check for SMT divergence, "
            "for example 'ES,YM'. Omit to skip divergence detection."
        ),
    ),
    swing_strength: int = Query(
        2, ge=1, le=20, description="Candles either side that must not exceed a pivot"
    ),
    min_gap_percent: float = Query(
        0.0, ge=0.0, le=10.0, description="Drop fair value gaps smaller than this % of price"
    ),
    include_filled_gaps: bool = Query(True, description="Keep gaps price has fully traded through"),
    include_invalid_smt: bool = Query(
        False, description="Keep divergences whose anchors are neither swings nor gap edges"
    ),
    liquidity_tolerance_percent: float = Query(
        0.03,
        ge=0.0,
        le=5.0,
        description="How far apart two pivots may sit and still read as one level, as a % of price",
    ),
    liquidity_min_touches: int = Query(
        2, ge=2, le=10, description="Pivots needed before a level counts as a liquidity pool"
    ),
    include_swept_pools: bool = Query(
        True, description="Keep pools price has already traded through"
    ),
) -> IctAnalysisResponse:
    try:
        resolved_interval = normalise_resolution(interval)
        start = parse_time_param(from_)
        end = parse_time_param(to)
    except (UnsupportedIntervalError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    if end <= start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "'to' must be greater than 'from'")

    references = [part.strip() for part in (reference or "").split(",") if part.strip()]

    try:
        return await service.analyse(
            symbol,
            resolved_interval,
            start,
            end,
            reference_symbols=references,
            swing_strength=swing_strength,
            min_gap_percent=min_gap_percent,
            include_filled_gaps=include_filled_gaps,
            include_invalid_smt=include_invalid_smt,
            liquidity_tolerance_percent=liquidity_tolerance_percent,
            liquidity_min_touches=liquidity_min_touches,
            include_swept_pools=include_swept_pools,
        )
    except UnknownSymbolError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except RequestTooLargeError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except ProviderRateLimitError as exc:
        retry_after = int(exc.retry_after_seconds or 60)
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"{exc} Try again in about {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("ICT analysis failed for %s %s", symbol, interval)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The analysis could not be completed. Please try again.",
        ) from exc


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
    except Exception as exc:  # noqa: BLE001
        code, message = _translate_backtest_error(exc)
        if code >= 500:
            logger.exception("Backtest failed")
        raise HTTPException(code, message) from exc


def _translate_backtest_error(exc: Exception) -> tuple[int, str]:
    """The status and the sentence a failed run is reported with.

    Shared by the synchronous endpoint and background jobs, so a run reads the
    same whichever way it was started.
    """

    if isinstance(exc, BacktestBusyError):
        return status.HTTP_409_CONFLICT, str(exc)
    if isinstance(
        exc,
        (BacktestValidationError, RequestTooLargeError, UnknownSymbolError, TimestampOutOfRangeError),
    ):
        return status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)
    if isinstance(exc, UnsupportedIntervalError):
        return status.HTTP_400_BAD_REQUEST, str(exc)
    if isinstance(exc, ProviderRateLimitError):
        return status.HTTP_429_TOO_MANY_REQUESTS, (
            f"{exc} The market-data provider's quota ran out part-way through. "
            "Wait a minute and run it again; candles already fetched are cached."
        )
    return (
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "The backtest could not be completed. Check the server log for details.",
    )


def _job_out(job: BacktestJob) -> BacktestJobResponse:
    p = job.progress
    return BacktestJobResponse(
        id=job.id, status=job.status, strategy=job.strategy,
        stage=p.stage, detail=p.detail, done=p.done, total=p.total,
        started_at=job.started_at, updated_at=p.updated_at, finished_at=job.finished_at,
        waiting_until=p.waiting_until, backtest_id=job.backtest_id,
        error=job.error, error_status=job.error_status,
    )


@api_router.post(
    "/backtests/jobs",
    response_model=BacktestJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    tags=["backtesting"],
)
async def start_backtest_job(
    request: BacktestRequest,
    service: Annotated[BacktestService, Depends(backtest_service)],
    jobs: Annotated[BacktestJobs, Depends(backtest_jobs)],
    caller: Annotated[str, Depends(session_id)],
) -> BacktestJobResponse:
    """Start a backtest and answer at once; poll the job for its progress."""

    running = jobs.current(caller)
    if running is not None and running.status == "running":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "A backtest is already running for this session. Wait for it to finish before starting another.",
        )
    return _job_out(jobs.start(request, caller, service, _translate_backtest_error))


@api_router.get("/backtests/jobs/current", response_model=BacktestJobResponse, tags=["backtesting"])
async def current_backtest_job(
    jobs: Annotated[BacktestJobs, Depends(backtest_jobs)],
    caller: Annotated[str, Depends(session_id)],
) -> BacktestJobResponse:
    """This tab's running job, else its latest one -- how a refreshed page finds its run."""

    job = jobs.current(caller)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No backtest has been started in this tab.")
    return _job_out(job)


@api_router.get("/backtests/jobs/{job_id}", response_model=BacktestJobResponse, tags=["backtesting"])
async def get_backtest_job(
    job_id: str,
    jobs: Annotated[BacktestJobs, Depends(backtest_jobs)],
    caller: Annotated[str, Depends(session_id)],
) -> BacktestJobResponse:
    job = jobs.get(job_id, caller)
    if job is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "That backtest job is no longer known to the server (it may have restarted). Run it again.",
        )
    return _job_out(job)


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
                    selection_start=row.selection_start,
                    selection_end=row.selection_end,
                    label=describe_configuration(row.configuration_json or {}),
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
    if symbol is not None:
        try:
            symbol = get_instrument(symbol).symbol
        except ValueError as error:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error
    with session_scope() as session:
        removed = clear_cache(session, symbol)
    target = symbol or "all symbols"
    return MessageResponse(
        message=f"Cleared {removed:,} cached candles for {target}.",
        detail="Charts will refetch from the active provider on the next request.",
    )
