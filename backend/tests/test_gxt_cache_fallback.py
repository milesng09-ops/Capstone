import pytest

from app.database.repository import save_candles
from app.models.domain import BarsResult
from app.providers.base import ProviderRateLimitError
from app.providers.quota_policy import cached_massive_on_limit
from app.services.backtest_service import BacktestService, BacktestValidationError
from app.services.candle_service import CandleService
from app.services import gxt_service
from test_gxt import BASE, HOUR_MS, FakeFeed, isolated_db, market, reference, request


@pytest.mark.asyncio
async def test_cache_only_request_does_not_queue_behind_a_waiting_chart():
    import asyncio
    from app.providers.rate_limiter import SlidingWindowRateLimiter, RateLimitExceeded
    limiter = SlidingWindowRateLimiter(1, 60)
    async with limiter._lock:
        with pytest.raises(RateLimitExceeded):
            await asyncio.wait_for(limiter.acquire(0), timeout=0.1)


@pytest.mark.asyncio
async def test_massive_429_has_no_sleep_retry_or_foreign_fetch_for_gxt():
    import httpx
    from app.providers.massive_provider import MassiveProvider
    calls, waits = [], []
    class Budget:
        max_calls = 5
        async def acquire(self, max_wait):
            waits.append(max_wait)
            return 0
    def respond(req):
        calls.append(req.url.path)
        return httpx.Response(429, headers={'Retry-After': '60'})
    provider = MassiveProvider(api_key='offline-test-key', limiter=Budget())
    provider._client = httpx.AsyncClient(transport=httpx.MockTransport(respond), base_url='https://api.massive.com')
    token = cached_massive_on_limit.set(True)
    try:
        with pytest.raises(ProviderRateLimitError):
            await provider._request('/futures/v1/aggs/ESZ6', {})
        assert calls == ['/futures/v1/aggs/ESZ6']
        assert waits == [0]
    finally:
        cached_massive_on_limit.reset(token)
        await provider.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['known_limit', 'new_429', 'partial_limit'])
async def test_quota_runs_real_gxt_from_massive_cache_only(mode, isolated_db, monkeypatch):
    monkeypatch.setattr('app.services.candle_service.session_scope', gxt_service.session_scope)
    with gxt_service.session_scope() as session:
        save_candles(session, '1h', market(), 'massive')
        save_candles(session, '1h', reference(market()), 'massive')
        foreign = market()[0].model_copy(update={'time': BASE-HOUR_MS})
        save_candles(session, '1h', [foreign], 'yahoo')

    class CacheFeed(CandleService):
        live_calls = 0
        def massive_quota_exhausted(self):
            return mode == 'known_limit'
        async def get_series_for_analysis(self, symbol, interval, start, end):
            self.live_calls += 1
            assert cached_massive_on_limit.get()
            if mode == 'known_limit':
                raise AssertionError('Must not attempt any provider request when quota is known full')
            if mode == 'new_429':
                raise ProviderRateLimitError('Massive limit', provider='massive', retry_after_seconds=60)
            return BarsResult(symbol=symbol, interval=interval, provider='massive', cached=True,
                quality='partial', rate_limited=True, fallback_active=True, bars=[])

    feed = CacheFeed()
    cached = await feed.get_cached_series_for_analysis('NQ', '1h', BASE-HOUR_MS, BASE+14*HOUR_MS)
    assert [b.time for b in cached.bars] == [b.time for b in market()]
    service = BacktestService(feed)
    result = await service.run(request(), 'cached-limit')
    assert len(result.trades) == 1  # Real simulator; the fixture has a valid setup.
    assert result.provider == 'massive'
    assert result.summary.gxt.cached_only
    assert any('CACHED-ONLY GXT' in note for note in result.summary.data_quality)
    assert feed.live_calls == (0 if mode == 'known_limit' else 1)
    assert not cached_massive_on_limit.get()  # Other requests keep their normal policy.
    assert (await service.load(result.id)).summary.gxt.cached_only
    await feed.close()


@pytest.mark.asyncio
async def test_missing_cache_is_an_explicit_error_not_a_synthetic_trade(isolated_db, monkeypatch):
    monkeypatch.setattr('app.services.candle_service.session_scope', gxt_service.session_scope)
    feed = CandleService()
    monkeypatch.setattr(feed, 'massive_quota_exhausted', lambda: True)
    with pytest.raises(BacktestValidationError, match='local CME cache lacks candles'):
        await BacktestService(feed).run(request(), 'empty-cache')
    assert not cached_massive_on_limit.get()
    await feed.close()


@pytest.mark.asyncio
async def test_cache_reader_excludes_forming_bar_and_aggregates_without_a_feed(isolated_db, monkeypatch):
    monkeypatch.setattr('app.services.candle_service.session_scope', gxt_service.session_scope)
    with gxt_service.session_scope() as session:
        save_candles(session, '1h', market(), 'massive')
    feed = CandleService()
    # Only complete requested buckets are made available, including 4H aggregation.
    hourly = await feed.get_cached_series_for_analysis('NQ', '1h', BASE, BASE+5*HOUR_MS-1)
    assert len(hourly.bars) == 4
    four_hour = await feed.get_cached_series_for_analysis('NQ', '4h', BASE, BASE+8*HOUR_MS)
    assert len(four_hour.bars) == 2
    assert four_hour.bars[0].high == 140
    await feed.close()
