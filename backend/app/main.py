"""FastAPI application entry point.

    uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.api.routes import api_router
from app.config import get_settings
from app.database.repository import (
    repair_mixed_real_series,
    repair_mixed_series,
    retain_provider_cache,
    upsert_instruments,
)
from app.database.session import init_database, session_scope
from app.providers.instruments import list_instruments
from app.services.candle_service import shutdown_candle_service
from app.utils.error_logging import configure_error_log, redact

logger = logging.getLogger(__name__)


def configure_logging() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    )
    configure_error_log(settings.log_file)
    # yfinance is noisy about individual ticker failures we already handle.
    logging.getLogger("yfinance").setLevel(logging.ERROR)
    logging.getLogger("peewee").setLevel(logging.ERROR)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    settings = get_settings()
    init_database()
    if settings.data_provider == "massive":
        with session_scope() as session:
            removed = retain_provider_cache(session, "massive")
        if removed:
            logger.info("Massive-only mode: invalidated %d cached candles from other sources.", removed)

    with session_scope() as session:
        upsert_instruments(
            session,
            [
                {
                    "symbol": instrument.symbol,
                    "display_name": instrument.display_name,
                    "exchange": instrument.exchange,
                    "currency": instrument.currency,
                    "asset_type": instrument.asset_type,
                    "timezone": instrument.timezone,
                    "price_precision": instrument.price_precision,
                    "tick_size": instrument.tick_size,
                }
                for instrument in list_instruments()
            ],
        )

    # A series that holds both real and generated bars draws them as one
    # continuous price line, and its coverage says the range is already
    # fetched, so nothing would ever go back for the real prices. Evicting the
    # generated half at startup is what lets the next request repair it.
    with session_scope() as session:
        repaired = repair_mixed_series(session)
    for (symbol, interval), removed in repaired.items():
        logger.warning(
            "Removed %d generated bars from %s %s, which also held real prices. "
            "That range will be refetched on the next request.",
            removed,
            symbol,
            interval,
        )

    # The same argument for two *real* providers. Their bars are all genuine
    # observations, but of different series: Massive stitches front-month
    # contracts without back-adjusting, Yahoo quotes its own continuous
    # contract, and after a roll the two are hundreds of points apart. One
    # line drawn through both has a cliff in it that belongs to neither.
    with session_scope() as session:
        rebased = repair_mixed_real_series(session)
    for (symbol, interval), removed in rebased.items():
        logger.warning(
            "Removed %d bars from %s %s that came from a second real provider. "
            "A series holds one provider's prices; that range will be refetched.",
            removed,
            symbol,
            interval,
        )

    logger.info(
        "Market Replay Lab backend %s starting (provider=%s, massive_key=%s)",
        __version__,
        settings.data_provider,
        "set" if settings.massive_api_key_configured else "not set",
    )
    if not settings.massive_api_key_configured and settings.data_provider == "massive":
        logger.warning("Massive-only mode requires MASSIVE_API_KEY. No fallback source is enabled.")
    elif not settings.massive_api_key_configured and settings.data_provider == "auto":
        logger.info(
            "MASSIVE_API_KEY is not configured. Falling back to Yahoo Finance, "
            "with no synthetic fallback."
        )

    try:
        yield
    finally:
        await shutdown_candle_service()
        logger.info("Backend shut down")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Market Replay Lab API",
        version=__version__,
        description=(
            "Historical futures data, deterministic pattern comparison and rule-based "
            "backtesting. Educational and research use only."
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware('http')
    async def request_diagnostics(request: Request, call_next):
        request_id = uuid.uuid4().hex
        request.state.request_id = request_id
        try:
            response = await call_next(request)
        except Exception:
            logger.exception('Request failed reference=%s method=%s path=%s',
                             request_id, request.method, request.url.path)
            response = JSONResponse(status_code=500, content={
                'detail': 'Something went wrong on the server. Please try again.',
            })
        else:
            if response.status_code >= 400:
                logger.warning('Request rejected reference=%s method=%s path=%s status=%s',
                               request_id, request.method, request.url.path, response.status_code)
        response.headers['X-Request-ID'] = request_id
        return response

    app.include_router(api_router)

    @app.exception_handler(StarletteHTTPException)
    async def handled_error(request: Request, exc: StarletteHTTPException):
        if isinstance(exc.detail, str):
            exc.detail = redact(exc.detail)
        logger.warning('Request error reference=%s method=%s path=%s status=%s detail=%s',
                       getattr(request.state, 'request_id', 'startup'), request.method,
                       request.url.path, exc.status_code, exc.detail)
        return await http_exception_handler(request, exc)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Keep the rejected input and body out of the diagnostics file.
        details = '; '.join(f'{error["loc"]}: {error["msg"]}' for error in exc.errors())
        logger.warning('Validation error reference=%s method=%s path=%s detail=%s',
                       getattr(request.state, 'request_id', 'startup'), request.method,
                       request.url.path, details)
        return await request_validation_exception_handler(request, exc)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error: %s", exc)
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Something went wrong on the server. Please try again.",
            },
        )

    @app.get("/", tags=["status"])
    async def root() -> dict[str, str]:
        return {
            "name": "Market Replay Lab API",
            "version": __version__,
            "docs": "/docs",
            "disclaimer": (
                "This application is provided for educational and research purposes. "
                "Historical results do not guarantee future performance."
            ),
        }

    return app


app = create_app()
