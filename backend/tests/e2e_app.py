"""Offline browser-test server: real HTTP/scanner/simulator/storage, fixture feed.

Launched only by Playwright. Never connects to live providers or the user's DB.
"""
import os
from contextlib import asynccontextmanager
from tempfile import TemporaryDirectory

from fastapi import FastAPI

from app.config import reset_settings_cache
from app.database.session import dispose_database, init_database
from app.api.routes import api_router
from app.api.deps import backtest_service
from app.services.backtest_service import BacktestService
from test_gxt import FakeFeed, market, reference, continuation_market
from app.models.domain import BarsResult


@asynccontextmanager
async def lifespan(app):
    with TemporaryDirectory(prefix="gxt-browser-test-") as directory:
        os.environ["DATABASE_URL"] = f"sqlite:///{directory}/test.db"
        os.environ["DATA_PROVIDER"] = "demo"
        os.environ["MASSIVE_API_KEY"] = ""
        reset_settings_cache()
        dispose_database()
        init_database()
        yield
        dispose_database()


app = FastAPI(lifespan=lifespan)
app.include_router(api_router)
class BrowserFeed(FakeFeed):
    async def get_series_for_analysis(self, symbol, interval, start, end):
        if symbol == 'YM':
            return BarsResult(symbol=symbol, interval=interval, provider='fixture', quality='cached',
                cached=True, fallback_active=False,
                bars=[b.model_copy(update={'symbol': 'YM'}) for b in continuation_market()])
        return await super().get_series_for_analysis(symbol, interval, start, end)


service = BacktestService(BrowserFeed())
app.dependency_overrides[backtest_service] = lambda: service


@app.get("/test/market")
def fixture_market(symbol: str = "NQ"):
    bars = ([b.model_copy(update={'symbol': 'YM'}) for b in continuation_market()] if symbol == 'YM'
            else market() if symbol == "NQ" else reference(market()))
    return [bar.model_dump() for bar in bars]
