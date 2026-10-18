"""Data-layer defects from the October bug hunt, pinned with offline fakes.

Each case reproduced against the code before its fix: a seam between two
fetches asked for on every request, a weekly bar built from one day, a
preferred provider locked out of a series its fallback filled, a forming-tail
memo that never applied after a refusal or over a weekend, a quota reported as
advice to clear the cache, analysis windows with no overall limit, a future
window read as an outage, timestamps that failed deep inside SQLite, a NaN in
a request body answered with a 500, and a five-candle selection refused as
too short to test.

No network: providers here are in-process fakes, and every database is a
scratch file under ``tmp_path``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.config import reset_settings_cache
from app.database import session as db
from app.database.repository import TimeRange, providers_in_series
from app.database.session import session_scope
from app.models.domain import Candle, ProviderFetchResult
from app.providers.base import MarketDataProvider, ProviderRateLimitError
from app.providers.trading_hours import empty_response_indicts_provider, is_trading_minute
from app.services.aggregation_service import aggregate_candles
from app.services.candle_service import CandleService, RequestTooLargeError
from app.utils.intervals import interval_ms
from app.utils.timeutils import now_ms, parse_time_param

CHICAGO = ZoneInfo("America/Chicago")
HOUR = 3_600_000
DAY = 24 * HOUR
EPOCH_2025 = 1_735_689_600_000  # 2025-01-01T00:00:00Z


def ms(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp() * 1000)


def open_slots(start: int, end: int, step: int) -> list[int]:
    """Every bar open the CME calendar allows in ``[start, end]``."""

    first = -(-start // step) * step
    return [
        moment
        for moment in range(first, end + 1, step)
        if is_trading_minute(
            datetime.fromtimestamp(moment / 1000, tz=timezone.utc).astimezone(CHICAGO)
        )
    ]


def bar(symbol: str, moment: int, price: float = 0.0) -> Candle:
    price = price or 5_000.0 + (moment - EPOCH_2025) / HOUR
    return Candle(symbol=symbol, time=moment, open=price, high=price + 1,
                  low=price - 1, close=price + 0.5, volume=10)


class Vendor:
    """Stands in for the whole provider chain: a bar for every open slot."""

    def __init__(self, name: str = "massive", *, until: int | None = None) -> None:
        self.name = name
        self.until = until
        self.refuse: Exception | None = None
        self.calls: list[tuple[int, int]] = []

    def chain(self) -> list[str]:
        return [self.name]

    def bars(self, symbol: str, start: int, end: int, step: int = HOUR) -> list[Candle]:
        last = min(end, self.until if self.until is not None else now_ms())
        return [bar(symbol, moment) for moment in open_slots(start, last, step)]

    async def fetch(self, symbol, interval, start, end) -> ProviderFetchResult:
        start_ms, end_ms = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
        self.calls.append((start_ms, end_ms))
        if self.refuse is not None:
            raise self.refuse
        return ProviderFetchResult(
            provider=self.name,
            interval=interval,
            bars=self.bars(symbol, start_ms, end_ms, interval_ms(interval)),
            quality="live",
        )


class StubProvider(MarketDataProvider):
    """One link of a real `AutomaticFallbackProvider` chain."""

    native_intervals = {"1m", "5m", "15m", "1h"}
    quality = "live"

    def __init__(self, name: str) -> None:
        self.name = name
        self.display_name = name.title()
        self.refuse: Exception | None = None
        self.calls = 0

    async def is_configured(self) -> bool:
        return True

    async def get_symbols(self):
        return []

    async def get_bars(self, symbol, interval, start_time, end_time):
        self.calls += 1
        if self.refuse is not None:
            raise self.refuse
        start, end = int(start_time.timestamp() * 1000), int(end_time.timestamp() * 1000)
        return [bar(symbol, moment) for moment in open_slots(start, min(end, now_ms()), HOUR)]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def database(tmp_path):
    """A scratch cache, so nothing here touches a developer's own database."""

    patch = pytest.MonkeyPatch()
    patch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'cache.db').as_posix()}")
    patch.setenv("DATA_PROVIDER", "massive")
    reset_settings_cache()
    db.dispose_database()
    db.init_database()
    yield
    db.dispose_database()
    patch.undo()
    reset_settings_cache()


def next_hour() -> int:
    """The end of the window the chart asks for."""

    return (now_ms() // HOUR + 1) * HOUR


# --------------------------------------------------------------------------
# D-01: the seam left where two fetches meet
# --------------------------------------------------------------------------
class TestASeamBetweenTwoFetches:
    @pytest.mark.anyio
    @pytest.mark.parametrize(
        "end",
        [
            # The earlier fetch ends on a mid-week bar boundary: Monday 08:00.
            "2026-03-19T10:00:00-05:00",
            # It ends on the Friday close, so the seam is the weekend.
            "2026-03-18T12:00:00-05:00",
        ],
    )
    async def test_it_is_not_asked_for_again_on_every_request(self, database, end):
        vendor = Vendor()
        service = CandleService(provider=vendor)
        end_ms = ms(end)

        await service.get_bars("ES", "1h", end_ms - 30 * DAY, end_ms)
        # The History preset widened: the new stretch meets the old at a bar.
        await service.get_bars("ES", "1h", end_ms - 60 * DAY, end_ms)
        settled = len(vendor.calls)

        for interval in ("1h", "4h", "1d", "1h"):
            result = await service.get_bars("ES", interval, end_ms - 60 * DAY, end_ms)
            assert result.quality == "cached"
        assert len(vendor.calls) == settled

    def test_settled_history_where_no_bar_can_be_is_covered(self):
        # The gap the seam came back as, aligned: one bar, and nothing after it.
        last = ms("2026-02-16T08:00:00-06:00")
        gap = TimeRange(last, last + HOUR - 1)

        assert CandleService._served_span("ES", "1h", [bar("ES", last)], gap) == (
            gap.start,
            gap.end,
        )

    def test_open_market_after_the_last_bar_is_still_owed(self):
        last = ms("2026-02-16T08:00:00-06:00")
        gap = TimeRange(last, last + 5 * HOUR - 1)

        assert CandleService._served_span("ES", "1h", [bar("ES", last)], gap) == (last, last)

    def test_the_forming_tail_is_never_claimed(self):
        last = (now_ms() // HOUR - 3) * HOUR
        gap = TimeRange(last, now_ms() + DAY)

        start, end = CandleService._served_span("ES", "1h", [bar("ES", last)], gap)
        assert end == last


# --------------------------------------------------------------------------
# D-02 and BR-02: calendar buckets at the right edge of a window
# --------------------------------------------------------------------------
class TestTheLastCalendarBarOfAHistoricalWindow:
    @pytest.mark.anyio
    @pytest.mark.parametrize("interval", ["1w", "1mo"])
    async def test_a_selection_ends_on_a_whole_bar(self, database, interval):
        vendor = Vendor()
        service = CandleService(provider=vendor)
        chart = await service.get_bars(
            "ES", interval, ms("2025-06-04T00:00:00-05:00"), ms("2026-04-30T00:00:00-05:00")
        )
        on_chart = {candle.time: candle for candle in chart.bars}
        # The chart's selection runs from the open of its first bar to the
        # open of its last.
        selection = chart.bars[1:6]

        result = await service.get_series_for_analysis(
            "ES", interval, selection[0].time, selection[-1].time
        )

        last = result.bars[-1]
        whole = on_chart[last.time]
        assert last.time == selection[-1].time
        assert (last.high, last.low, last.close, last.volume) == (
            whole.high,
            whole.low,
            whole.close,
            whole.volume,
        )

    @pytest.mark.anyio
    async def test_a_week_straddling_an_analysis_slice_is_whole(self, database, monkeypatch):
        from app.config import get_settings
        from app.services import candle_service as module

        # A hundred hourly bars per slice puts a boundary inside most weeks.
        settings = get_settings().model_copy(update={"max_bars_per_request": 100})
        monkeypatch.setattr(module, "get_settings", lambda: settings)
        vendor = Vendor()
        service = CandleService(provider=vendor)
        start, end = ms("2026-01-04T17:00:00-06:00"), ms("2026-03-01T17:00:00-06:00")

        result = await service.get_series_for_analysis("ES", "1w", start, end)

        expected = {
            candle.time: candle
            for candle in aggregate_candles(
                vendor.bars("ES", start - DAY, end + 8 * DAY), "1w", timezone="America/Chicago"
            )
        }
        assert len(result.bars) == 9
        for candle in result.bars:
            reference = expected[candle.time]
            assert (candle.high, candle.low, candle.close, candle.volume) == (
                reference.high,
                reference.low,
                reference.close,
                reference.volume,
            )


# --------------------------------------------------------------------------
# D-03: who owns a series
# --------------------------------------------------------------------------
class TestThePreferredProviderTakesOverASeries:
    @pytest.mark.anyio
    async def test_a_series_its_fallback_filled(self, database):
        # The first view of NQ came while Massive was cooling off, or before
        # it had a key: Yahoo filled the series.
        vendor = Vendor("yahoo")
        service = CandleService(provider=vendor)
        end = ms("2026-03-19T10:00:00-05:00")
        await service.get_bars("NQ", "1h", end - 20 * DAY, end)

        # Massive is back, and answers the next range asked for.
        vendor.name = "massive"
        later = await service.get_bars("NQ", "1h", end - 30 * DAY, end)

        with session_scope() as session:
            assert providers_in_series(session, "NQ", "1h") == {"massive"}
        assert later.quality == "live"
        assert later.provider == "massive"
        # The whole window, not just the stretch that triggered the change.
        assert len(later.bars) == len(vendor.bars("NQ", end - 30 * DAY, end))


# --------------------------------------------------------------------------
# D-04: the forming-tail memo
# --------------------------------------------------------------------------
class TestTheTailMemo:
    @pytest.mark.anyio
    async def test_a_refused_tail_is_not_asked_for_again_a_moment_later(self, database):
        vendor = Vendor()
        service = CandleService(provider=vendor)
        frm, to = next_hour() - 10 * DAY, next_hour()
        await service.get_bars("ES", "1h", frm, to)
        service._tail_fetched.clear()  # the next view comes after the memo lapsed

        vendor.refuse = ProviderRateLimitError(
            "Massive rate limit exceeded (HTTP 429)", "massive", 30.0
        )
        await service.get_bars("ES", "1h", frm, to)
        asked = len(vendor.calls)
        reused = await service.get_bars("ES", "4h", frm, to)  # the same view, a moment on

        assert len(vendor.calls) == asked
        # Reusing a refusal is not a clean cache hit.
        assert reused.quality == "partial"
        assert reused.rate_limited is True
        assert reused.retry_after_seconds is not None
        assert 0 < reused.retry_after_seconds <= 30

    @pytest.mark.anyio
    async def test_a_weekend_tail_is_asked_for_once_per_view(self, database, monkeypatch):
        from app.services import cache_service

        saturday = ms("2026-03-21T12:00:00-05:00")
        monkeypatch.setattr(cache_service, "now_ms", lambda: saturday)
        vendor = Vendor(until=saturday)
        service = CandleService(provider=vendor)
        to = (saturday // HOUR + 1) * HOUR

        # One view: candles and detections on three timeframes of one store.
        for interval in ("1h", "4h", "1d", "1h", "4h", "1d"):
            await service.get_bars("ES", interval, to - 30 * DAY, to)

        assert len(vendor.calls) == 1


# --------------------------------------------------------------------------
# D-05: a quota on the provider that owns the series
# --------------------------------------------------------------------------
class TestARateLimitedOwner:
    @pytest.mark.anyio
    async def test_it_reads_as_a_wait_not_as_advice_to_clear_the_cache(self, database):
        from app.providers.fallback_provider import AutomaticFallbackProvider
        from app.providers.health import ProviderHealthRegistry

        massive, yahoo = StubProvider("massive"), StubProvider("yahoo")
        chain = AutomaticFallbackProvider(
            providers={"massive": massive, "yahoo": yahoo}, registry=ProviderHealthRegistry()
        )
        service = CandleService(provider=chain)
        frm, to = next_hour() - 10 * DAY, next_hour()
        await service.get_bars("ES", "1h", frm, to)  # Massive owns the series

        service._tail_fetched.clear()
        massive.refuse = ProviderRateLimitError(
            "Massive rate limit exceeded (HTTP 429)", "massive", 30.0
        )
        limited = await service.get_bars("ES", "1h", frm, to)

        assert limited.quality == "partial"
        assert limited.rate_limited is True
        assert limited.retry_after_seconds == 30
        assert "Clear the cache" not in (limited.fallback_reason or "")

        # Inside the cool-off Massive is skipped without a call; still a wait.
        service._tail_fetched.clear()
        calls = massive.calls
        cooling = await service.get_bars("ES", "1h", frm, to)

        from app.config import get_settings

        assert massive.calls == calls
        assert cooling.rate_limited is True
        assert cooling.retry_after_seconds is not None
        assert 0 < cooling.retry_after_seconds <= get_settings().provider_health_ttl_seconds
        assert "Clear the cache" not in (cooling.fallback_reason or "")


# --------------------------------------------------------------------------
# D-06: analysis windows
# --------------------------------------------------------------------------
class TestAnalysisWindows:
    @pytest.mark.anyio
    async def test_past_the_history_limit_is_refused_before_anything_is_fetched(self, database):
        vendor = Vendor()
        service = CandleService(provider=vendor)

        with pytest.raises(RequestTooLargeError):
            await service.get_series_for_analysis("ES", "1d", now_ms() - 1_000 * DAY, now_ms())
        assert vendor.calls == []

    @pytest.mark.anyio
    async def test_the_detections_endpoint_answers_422_like_the_chart_one(self, database):
        from fastapi import HTTPException

        from app.api.routes import ict_analysis
        from app.services.ict_service import IctService

        vendor = Vendor()
        service = IctService(candle_service=CandleService(provider=vendor))

        with pytest.raises(HTTPException) as caught:
            await ict_analysis(
                service=service,
                symbol="ES",
                interval="1d",
                from_=str(now_ms() - 1_000 * DAY),
                to=str(now_ms()),
                reference="NQ,YM",
                swing_strength=2,
                min_gap_percent=0.0,
                include_filled_gaps=True,
                include_invalid_smt=False,
                liquidity_tolerance_percent=0.03,
                liquidity_min_touches=2,
                include_swept_pools=True,
            )
        assert caught.value.status_code == 422
        assert vendor.calls == []


# --------------------------------------------------------------------------
# D-07: an empty answer over time that has not happened
# --------------------------------------------------------------------------
class TestAnEmptyFuture:
    def test_it_does_not_indict_the_provider(self):
        start = now_ms() + DAY
        assert empty_response_indicts_provider(start, start + 7 * DAY, "1h") is False

    @pytest.mark.anyio
    async def test_massive_answers_it_without_failing(self, monkeypatch):
        from app.providers.massive_provider import MassiveProvider

        provider = MassiveProvider(api_key="test-key")

        async def no_rows(*args, **kwargs):
            return []

        monkeypatch.setattr(provider, "_fetch_contract", no_rows)
        start = datetime.now(tz=timezone.utc) + timedelta(days=1)

        # A full week ahead always holds open market by the calendar.
        assert await provider.get_bars("ES", "1h", start, start + timedelta(days=7)) == []


# --------------------------------------------------------------------------
# D-08: timestamps the system cannot carry
# --------------------------------------------------------------------------
class TestTimestampsOutOfRange:
    @pytest.mark.parametrize(
        "value", ["10000000000000000000", "1960-01-01T00:00:00", "-1", "9999-12-31T00:00:00"]
    )
    def test_they_are_a_validation_error(self, value):
        with pytest.raises(ValueError):
            parse_time_param(value)

    @pytest.mark.anyio
    async def test_the_bars_endpoint_answers_400(self, database):
        from fastapi import HTTPException

        from app.api.routes import bars

        with pytest.raises(HTTPException) as caught:
            await bars(
                service=CandleService(provider=Vendor()),
                symbol="ES",
                interval="1h",
                from_="10000000000000000000",
                to="10000000000003600000",
                refresh=False,
            )
        assert caught.value.status_code == 400

    @pytest.mark.anyio
    async def test_a_backtest_body_answers_422(self, database):
        from fastapi import HTTPException

        from app.api.routes import create_backtest_run
        from app.models.schemas import BacktestRequest
        from app.services.backtest_service import BacktestService

        start = 10_000_000_000_000_000_000
        request = BacktestRequest(
            primary_symbol="ES",
            symbols=["ES"],
            interval="1h",
            selection={"start_time": start, "end_time": start + 5 * HOUR},
            search={"lookback_start": start - 30 * DAY, "lookback_end": start + 5 * HOUR},
        )
        service = BacktestService(candle_service=CandleService(provider=Vendor()))

        with pytest.raises(HTTPException) as caught:
            await create_backtest_run(request=request, service=service, caller="test")
        assert caught.value.status_code == 422


class TestANonFiniteBody:
    """A refusal that echoes NaN back has to be renderable as JSON."""

    def test_nan_in_a_backtest_body_is_a_422(self, database):
        from fastapi.testclient import TestClient

        from app.main import app

        # Python's JSON parser accepts the NaN literal; JSON itself has none.
        body = (
            '{"symbols":["ES"],"primary_symbol":"ES","interval":"1h",'
            '"selection":{"start_time":1782914400000,"end_time":1782957600000},'
            '"trade":{"stop_loss_value":NaN},'
            '"search":{"lookback_start":1772323200000,"lookback_end":1785456000000}}'
        )
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(
                "/api/backtests", content=body, headers={"content-type": "application/json"}
            )

        assert response.status_code == 422
        assert "stop_loss_value" in response.text


# --------------------------------------------------------------------------
# L-05: how long a selection has to be
# --------------------------------------------------------------------------
class TestTheShortestSelection:
    @staticmethod
    def _validate(interval: str, start: int, end: int) -> None:
        from app.config import get_settings
        from app.models.schemas import BacktestRequest
        from app.services.backtest_service import BacktestService

        request = BacktestRequest(
            primary_symbol="ES",
            symbols=["ES"],
            interval=interval,
            selection={"start_time": start, "end_time": end},
            search={"lookback_start": start - 400 * DAY, "lookback_end": end},
        )
        BacktestService(candle_service=object())._validate(request, get_settings())

    def test_five_contiguous_hourly_bars_are_enough(self):
        # Open of the first bar to open of the fifth: four hours.
        start = ms("2026-03-03T09:00:00-06:00")
        self._validate("1h", start, start + 4 * HOUR)

    def test_five_weekly_bars_across_the_spring_change_are_enough(self):
        # Sunday 17:00 CST to Sunday 17:00 CDT: four weeks less an hour.
        self._validate(
            "1w", ms("2026-02-22T17:00:00-06:00"), ms("2026-03-22T17:00:00-05:00")
        )

    def test_three_bars_are_still_too_few(self):
        from app.services.backtest_service import BacktestValidationError

        start = ms("2026-03-03T09:00:00-06:00")
        with pytest.raises(BacktestValidationError):
            self._validate("1h", start, start + 2 * HOUR)
