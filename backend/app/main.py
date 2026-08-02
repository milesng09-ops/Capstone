"""FastAPI application entry point.

    uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.api.routes import api_router
from app.config import get_settings
from app.database.repository import upsert_instruments
from app.database.session import init_database, session_scope
from app.providers.instruments import list_instruments
from app.services.candle_service import shutdown_candle_service

logger = logging.getLogger(__name__)


def configure_logging() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    )
    # yfinance is noisy about individual ticker failures we already handle.
    logging.getLogger("yfinance").setLevel(logging.ERROR)
    logging.getLogger("peewee").setLevel(logging.ERROR)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    settings = get_settings()
    init_database()

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

    logger.info(
        "Market Replay Lab backend %s starting (provider=%s, massive_key=%s)",
        __version__,
        settings.data_provider,
        "set" if settings.massive_api_key_configured else "not set",
    )
    if not settings.massive_api_key_configured and settings.data_provider in {"auto", "massive"}:
        logger.info(
            "MASSIVE_API_KEY is not configured. Falling back to Yahoo Finance, "
            "then to bundled demo data."
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
    )

    app.include_router(api_router)

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
