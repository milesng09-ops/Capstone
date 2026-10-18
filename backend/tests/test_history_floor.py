"""History the vendor does not hold is an answer, not an outage.

Massive's archive does not always reach as far back as the two-year preset.
The first load of such a window stored what Massive had and said so. Every
view after it -- the next interval on the same stored series, the detections
request, a reload -- asked again for the stretch before Massive's first bar,
got nothing, and marked Massive unhealthy for two minutes, which pushed every
chart to the fallback and its bars into "a different series" refusals.

The policy pinned here: an empty answer for a window lying wholly before the
earliest bar a provider has ever served for the series means the provider
does not hold that history. No cool-off, the stretch recorded as answered so
it is asked for once, and the window reported as partial -- from the stored
bars, so after a restart too. An empty answer *inside* the history it holds
is still a failure: that is the guard against hiding a real gap.

No network: Massive's HTTP goes through ``httpx.MockTransport`` in-process,
and every database is a scratch file under ``tmp_path``.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.config import reset_settings_cache
from app.database import session as db
from app.database.repository import record_coverage, save_candles
from app.database.session import session_scope
from app.models.domain import Candle
from app.providers import base
from app.providers.base import MarketDataProvider
from app.providers.fallback_provider import AutomaticFallbackProvider
from app.providers.health import ProviderHealthRegistry
from app.providers.massive_provider import MassiveProvider
from app.providers.rate_limiter import SlidingWindowRateLimiter
from app.providers.trading_hours import is_trading_minute
from app.services.candle_service import CandleService
from app.utils.timeutils import now_ms

CHICAGO = ZoneInfo("America/Chicago")
HOUR = 3_600_000
DAY = 24 * HOUR


def open_hours(start: int, end: int) -> list[int]:
    first = -(-start // HOUR) * HOUR
    return [
        moment
        for moment in range(first, end + 1, HOUR)
        if is_trading_minute(
            datetime.fromtimestamp(moment / 1000, tz=timezone.utc).astimezone(CHICAGO)
        )
    ]


class Archive:
    """Massive's side of the wire: hourly bars from ``floor`` onwards, no older."""

    def __init__(self, floor: int) -> None:
        self.floor = floor
        self.asked: list[tuple[int, int]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        params = request.url.params
        start = int(params["window_start.gte"]) // 1_000_000
        end = int(params["window_start.lte"]) // 1_000_000
        self.asked.append((start, end))
        rows = [
            {"window_start": moment * 1_000_000, "open": 100, "high": 101,
             "low": 99, "close": 100.5, "volume": 5}
            for moment in open_hours(max(start, self.floor), min(end, now_ms()))
        ]
        return httpx.Response(200, content=json.dumps({"status": "OK", "results": rows}))

    def asked_before(self, moment: int) -> list[tuple[int, int]]:
        """Requests reaching into history older than ``moment``."""

        return [(start, end) for start, end in self.asked if start < moment]


class Fallback(MarketDataProvider):
    """Yahoo, as far as these cases need it: a different series, always there."""

    name, display_name, native_intervals, quality = "yahoo", "Yahoo Finance", {"1h"}, "delayed"

    def __init__(self) -> None:
        self.calls = 0

    async def is_configured(self) -> bool:
        return True

    async def get_symbols(self):
        return []

    async def get_bars(self, symbol, interval, start_time, end_time):
        self.calls += 1
        moment = int(end_time.timestamp() * 1000) // HOUR * HOUR
        return [Candle(symbol=symbol, time=moment, open=90, high=91, low=89, close=90, volume=1)]


class Empty(MarketDataProvider):
    """A provider that answers with nothing while the market was open."""

    native_intervals = {"1h"}
    quality = "live"

    def __init__(self, name: str) -> None:
        self.name = name
        self.display_name = name.title()
        self.calls = 0

    async def is_configured(self) -> bool:
        return True

    async def get_symbols(self):
        return []

    async def get_bars(self, symbol, interval, start_time, end_time):
        self.calls += 1
        # Looked up here rather than imported, so this module still collects
        # against a build that predates the name.
        empty = getattr(base, "ProviderNoDataError", base.ProviderDataError)
        raise empty(f"{self.name} returned no bars", provider=self.name)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def massive_first(monkeypatch):
    """Massive heads the chain whatever a developer's ``.env`` says."""

    monkeypatch.setenv("DATA_PROVIDER", "massive")
    reset_settings_cache()
    yield
    monkeypatch.undo()
    reset_settings_cache()


@pytest.fixture
def database(tmp_path):
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


def chain(archive: Archive) -> tuple[CandleService, ProviderHealthRegistry, Fallback]:
    massive = MassiveProvider(
        api_key="test-key",
        base_url="https://api.massive.test",
        limiter=SlidingWindowRateLimiter(1_000, 60.0, name="test"),
    )
    massive._client = httpx.AsyncClient(
        base_url="https://api.massive.test", transport=httpx.MockTransport(archive)
    )
    registry = ProviderHealthRegistry()
    fallback = Fallback()
    provider = AutomaticFallbackProvider(
        providers={"massive": massive, "yahoo": fallback}, registry=registry
    )
    return CandleService(provider=provider), registry, fallback


def two_years() -> tuple[int, int]:
    """The window the 2y History preset asks for."""

    to = (now_ms() // HOUR + 1) * HOUR
    return to - 730 * DAY, to


def first_bar(floor: int) -> int:
    return open_hours(floor, floor + 7 * DAY)[0]


# --------------------------------------------------------------------------
# The chain
# --------------------------------------------------------------------------
class TestTheChainOnAnEmptyAnswer:
    START = datetime(2025, 3, 3, tzinfo=timezone.utc)
    END = START + timedelta(days=5)

    @pytest.mark.anyio
    async def test_older_than_the_first_bar_ever_served_it_is_not_held(self, massive_first):
        registry = ProviderHealthRegistry()
        massive, yahoo = Empty("massive"), Fallback()
        provider = AutomaticFallbackProvider(
            providers={"massive": massive, "yahoo": yahoo}, registry=registry
        )
        floor = int((self.END + timedelta(days=30)).timestamp() * 1000)

        result = await provider.fetch(
            "ES", "1h", self.START, self.END, held_from={"massive": floor}
        )

        assert result.provider == "massive"
        assert result.bars == []
        assert result.not_held is True
        assert registry.entry("massive").healthy is True
        # Its prices would belong to another series: nobody else is asked.
        assert yahoo.calls == 0

    @pytest.mark.anyio
    async def test_inside_history_it_holds_it_is_still_a_failure(self, massive_first):
        registry = ProviderHealthRegistry()
        massive, yahoo = Empty("massive"), Fallback()
        provider = AutomaticFallbackProvider(
            providers={"massive": massive, "yahoo": yahoo}, registry=registry
        )
        floor = int((self.START - timedelta(days=30)).timestamp() * 1000)

        result = await provider.fetch(
            "ES", "1h", self.START, self.END, held_from={"massive": floor}
        )

        assert result.provider == "yahoo"
        assert registry.entry("massive").healthy is False

    @pytest.mark.anyio
    async def test_without_a_known_floor_it_is_a_failure(self, massive_first):
        registry = ProviderHealthRegistry()
        provider = AutomaticFallbackProvider(
            providers={"massive": Empty("massive"), "yahoo": Fallback()}, registry=registry
        )

        result = await provider.fetch("ES", "1h", self.START, self.END)

        assert result.provider == "yahoo"
        assert registry.entry("massive").healthy is False


# --------------------------------------------------------------------------
# A chart whose window reaches back past Massive's archive
# --------------------------------------------------------------------------
class TestAWindowOlderThanTheArchive:
    @pytest.mark.anyio
    async def test_the_next_view_does_not_ask_again_or_demote_massive(self, database):
        archive = Archive(floor=now_ms() - 365 * DAY)
        service, registry, fallback = chain(archive)
        frm, to = two_years()

        first = await service.get_bars("ES", "1h", frm, to)
        assert first.quality == "partial"

        archive.asked.clear()
        service._tail_fetched.clear()  # the next view, after the tail memo lapsed
        later = await service.get_bars("ES", "4h", frm, to)

        assert archive.asked_before(first_bar(archive.floor)) == []
        assert registry.entry("massive").healthy is True
        assert fallback.calls == 0
        assert later.quality == "partial"
        assert "history for ES starts at" in (later.fallback_reason or "")

    @pytest.mark.anyio
    async def test_a_restart_still_reads_the_window_as_partial(self, database):
        archive = Archive(floor=now_ms() - 365 * DAY)
        service, _, _ = chain(archive)
        frm, to = two_years()
        await service.get_bars("ES", "1h", frm, to)

        # A new process: no memo, no provider state, the same cache.
        archive.asked.clear()
        restarted, registry, fallback = chain(archive)
        result = await restarted.get_bars("ES", "1d", frm, to)

        assert archive.asked_before(first_bar(archive.floor)) == []
        assert registry.entry("massive").healthy is True
        assert fallback.calls == 0
        assert result.quality == "partial"
        assert "history for ES starts at" in (result.fallback_reason or "")

    @pytest.mark.anyio
    async def test_a_cache_left_by_the_old_rule_is_settled_by_one_question(self, database):
        # The old rule stored Massive's bars from its first one and left the
        # older stretch uncovered, to be asked for on every view.
        archive = Archive(floor=now_ms() - 365 * DAY)
        settled_to = now_ms() - 3 * DAY
        held = [
            Candle(symbol="ES", time=moment, open=100, high=101, low=99, close=100.5, volume=5)
            for moment in open_hours(archive.floor, settled_to)
        ]
        with session_scope() as session:
            save_candles(session, "1h", held, "massive")
            record_coverage(session, "ES", "1h", held[0].time, held[-1].time, "massive")
        service, registry, fallback = chain(archive)
        frm, to = two_years()

        once = await service.get_bars("ES", "1h", frm, to)

        assert len(archive.asked_before(held[0].time)) >= 1  # asked, once
        assert registry.entry("massive").healthy is True
        assert fallback.calls == 0
        assert once.quality == "partial"

        archive.asked.clear()
        service._tail_fetched.clear()
        again = await service.get_bars("ES", "4h", frm, to)

        assert archive.asked_before(held[0].time) == []
        assert again.quality == "partial"

    @pytest.mark.anyio
    async def test_an_empty_answer_inside_massives_history_still_demotes_it(self, database):
        # Massive has served this series from a year back, but nothing for a
        # stretch in the middle of it: a hole, not the edge of the archive.
        archive = Archive(floor=now_ms() - 365 * DAY)
        hole_from, hole_to = now_ms() - 200 * DAY, now_ms() - 150 * DAY
        held = [
            Candle(symbol="ES", time=moment, open=100, high=101, low=99, close=100.5, volume=5)
            for moment in open_hours(archive.floor, now_ms() - 3 * DAY)
            if not hole_from <= moment <= hole_to
        ]
        before = [candle for candle in held if candle.time < hole_from]
        after = [candle for candle in held if candle.time > hole_to]
        with session_scope() as session:
            save_candles(session, "1h", held, "massive")
            record_coverage(session, "ES", "1h", before[0].time, before[-1].time, "massive")
            record_coverage(session, "ES", "1h", after[0].time, after[-1].time, "massive")

        def holed(request: httpx.Request) -> httpx.Response:
            params = request.url.params
            start = int(params["window_start.gte"]) // 1_000_000
            end = int(params["window_start.lte"]) // 1_000_000
            if start >= before[-1].time and end <= after[0].time:
                return httpx.Response(200, content=json.dumps({"status": "OK", "results": []}))
            return archive(request)

        service, registry, _ = chain(archive)
        service.provider.providers["massive"]._client = httpx.AsyncClient(
            base_url="https://api.massive.test", transport=httpx.MockTransport(holed)
        )

        result = await service.get_bars("ES", "1h", hole_from - 2 * DAY, hole_to + 2 * DAY)

        assert registry.entry("massive").healthy is False
        assert result.quality == "partial"
