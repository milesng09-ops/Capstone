"""Candle orchestration: cache lookup, incremental fetch, aggregation.

This is the single entry point the API and the backtesting engine use to get
bars.  The read path is:

1. Validate the request against the configured cost limits.
2. Ask the cache which parts of the window are already covered.
3. Fetch only the missing ranges through the provider fallback chain.
4. Normalise, aggregate to the storage interval, persist, record coverage.
5. Load the full window from cache and aggregate to the requested interval.

Concurrent requests for the same series are de-duplicated with a per-key lock,
so three charts opening at once produce one provider call, not three.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass

import anyio

from app.config import get_settings
from app.database.repository import (
    TimeRange,
    candle_provider,
    load_candles,
    load_coverage,
    missing_ranges,
    record_coverage,
    save_candles,
)
from app.database.session import session_scope
from app.models.domain import BarsResult, Candle
from app.providers.fallback_provider import AutomaticFallbackProvider
from app.providers.instruments import get_instrument
from app.services.aggregation_service import aggregate_candles
from app.services.cache_service import (
    align_range,
    cacheable_end,
    estimate_bar_count,
    merge_adjacent,
    storage_interval,
)
from app.utils.intervals import get_interval, interval_ms, is_intraday
from app.utils.timeutils import from_ms

logger = logging.getLogger(__name__)


class RequestTooLargeError(ValueError):
    """Raised when a query would exceed the configured cost limits."""


@dataclass(frozen=True)
class _CacheOutcome:
    """What :meth:`CandleService._ensure_cached` learned while filling a window.

    ``incomplete`` is the important one: it separates "the cache already had
    everything" from "we needed data and could not get it".  Both used to look
    identical to the caller, which meant a total provider failure was reported
    to the UI as a clean cache hit.
    """

    served_from_cache: bool
    provider: str
    fallback_reason: str | None
    quality: str
    #: True when any gap in the window failed to fetch, so the bars returned
    #: are whatever was already stored -- possibly nothing.
    incomplete: bool

    def resolved_quality(self) -> str:
        if self.incomplete:
            return "partial"
        return "cached" if self.served_from_cache else self.quality


class CandleService:
    """Cached, provider-agnostic access to normalised OHLCV data."""

    def __init__(self, provider: AutomaticFallbackProvider | None = None) -> None:
        self._provider = provider or AutomaticFallbackProvider()
        self._locks: dict[tuple[str, str], asyncio.Lock] = defaultdict(asyncio.Lock)

    @property
    def provider(self) -> AutomaticFallbackProvider:
        return self._provider

    async def close(self) -> None:
        await self._provider.close()

    # ------------------------------------------------------------------
    def validate_request(self, symbol: str, interval: str, start: int, end: int) -> TimeRange:
        settings = get_settings()
        get_instrument(symbol)
        get_interval(interval)

        if end <= start:
            raise ValueError("'to' must be greater than 'from'")

        requested = TimeRange(start, end)
        bars = estimate_bar_count(requested, interval)
        if bars > settings.max_bars_per_request:
            raise RequestTooLargeError(
                f"Requested {bars:,} bars of {interval} data. "
                f"The limit is {settings.max_bars_per_request:,} bars per request - "
                "narrow the date range or use a larger interval."
            )

        if is_intraday(interval):
            span_days = requested.length / (24 * 60 * 60 * 1000)
            if span_days > settings.max_intraday_history_days:
                raise RequestTooLargeError(
                    f"Requested {span_days:.0f} days of intraday history. "
                    f"The limit is {settings.max_intraday_history_days} days."
                )
        return requested

    # ------------------------------------------------------------------
    async def get_bars(
        self,
        symbol: str,
        interval: str,
        start: int,
        end: int,
        *,
        force_refresh: bool = False,
    ) -> BarsResult:
        instrument = get_instrument(symbol)
        requested = self.validate_request(instrument.symbol, interval, start, end)

        store_interval = storage_interval(interval)
        # Load a little extra on each side so aggregated buckets at the window
        # edges are built from complete data.
        padded = align_range(
            TimeRange(
                requested.start - interval_ms(interval),
                requested.end + interval_ms(interval),
            ),
            store_interval,
        )

        lock = self._locks[(instrument.symbol, store_interval)]
        async with lock:
            outcome = await self._ensure_cached(
                instrument.symbol, store_interval, padded, force_refresh=force_refresh
            )

        stored = await anyio.to_thread.run_sync(
            self._load_from_cache, instrument.symbol, store_interval, padded
        )

        if interval != store_interval:
            bars = aggregate_candles(stored, interval, timezone=instrument.timezone)
        else:
            bars = stored

        bars = [candle for candle in bars if requested.start <= candle.time <= requested.end]

        return BarsResult(
            symbol=instrument.symbol,
            interval=interval,
            provider=outcome.provider,
            cached=outcome.served_from_cache,
            # A failed fetch is a degraded serve even when the provider name
            # still reads as the preferred one, so it counts as a fallback.
            fallback_active=(
                outcome.incomplete or outcome.provider != self._preferred_provider()
            ),
            fallback_reason=outcome.fallback_reason,
            quality=outcome.resolved_quality(),
            bars=bars,
        )

    # ------------------------------------------------------------------
    async def _ensure_cached(
        self,
        symbol: str,
        store_interval: str,
        window: TimeRange,
        *,
        force_refresh: bool,
    ) -> _CacheOutcome:
        """Fetch whatever part of ``window`` is not cached yet."""

        gaps = await anyio.to_thread.run_sync(
            self._compute_gaps, symbol, store_interval, window, force_refresh
        )

        if not gaps:
            provider_name = (
                await anyio.to_thread.run_sync(self._cached_provider, symbol, store_interval)
                or self._preferred_provider()
            )
            return _CacheOutcome(
                served_from_cache=True,
                provider=provider_name,
                fallback_reason=None,
                quality="cached",
                incomplete=False,
            )

        gaps = merge_adjacent(gaps, store_interval)
        provider_name = self._preferred_provider()
        fallback_reason: str | None = None
        quality = "delayed"
        fetched_any = False
        failed_gaps = 0

        for gap in gaps:
            try:
                result = await self._provider.fetch(
                    symbol,
                    store_interval,
                    from_ms(gap.start),
                    from_ms(gap.end),
                )
            except Exception as exc:  # noqa: BLE001 - degrade to whatever is cached
                logger.warning(
                    "Fetch failed for %s %s %s-%s: %s",
                    symbol,
                    store_interval,
                    gap.start,
                    gap.end,
                    exc,
                )
                fallback_reason = fallback_reason or str(exc)
                failed_gaps += 1
                continue

            provider_name = result.provider
            quality = result.quality
            fallback_reason = result.fallback_reason or fallback_reason

            bars = result.bars
            if result.interval != store_interval:
                instrument = get_instrument(symbol)
                bars = aggregate_candles(
                    bars, store_interval, timezone=instrument.timezone
                )

            await anyio.to_thread.run_sync(
                self._persist, symbol, store_interval, bars, result.provider, gap
            )
            fetched_any = True

        if failed_gaps:
            missing = f"{failed_gaps} of {len(gaps)} missing range(s) could not be fetched"
            fallback_reason = (
                f"{missing}: {fallback_reason}" if fallback_reason else missing
            )

        return _CacheOutcome(
            served_from_cache=not fetched_any,
            provider=provider_name,
            fallback_reason=fallback_reason,
            quality=quality,
            incomplete=failed_gaps > 0,
        )

    # ------------------------------------------------------------------
    # Synchronous helpers, executed on worker threads
    # ------------------------------------------------------------------
    @staticmethod
    def _compute_gaps(
        symbol: str, store_interval: str, window: TimeRange, force_refresh: bool
    ) -> list[TimeRange]:
        if force_refresh:
            return [window]
        with session_scope() as session:
            covered = load_coverage(session, symbol, store_interval)
        return missing_ranges(covered, window)

    @staticmethod
    def _persist(
        symbol: str,
        store_interval: str,
        bars: list[Candle],
        provider: str,
        gap: TimeRange,
    ) -> None:
        with session_scope() as session:
            if bars:
                save_candles(session, store_interval, bars, provider)
            # Only mark the settled part of the window as covered so the
            # forming bar is always refreshed on the next request.
            coverage_end = cacheable_end(gap.end, store_interval)
            if coverage_end >= gap.start:
                record_coverage(
                    session, symbol, store_interval, gap.start, coverage_end, provider
                )

    @staticmethod
    def _load_from_cache(symbol: str, store_interval: str, window: TimeRange) -> list[Candle]:
        with session_scope() as session:
            return load_candles(session, symbol, store_interval, window.start, window.end)

    @staticmethod
    def _cached_provider(symbol: str, store_interval: str) -> str | None:
        with session_scope() as session:
            return candle_provider(session, symbol, store_interval)

    def _preferred_provider(self) -> str:
        chain = self._provider.chain()
        return chain[0] if chain else "demo"

    # ------------------------------------------------------------------
    async def get_series_for_analysis(
        self, symbol: str, interval: str, start: int, end: int
    ) -> BarsResult:
        """Bars for the backtesting engine, without the per-request bar cap.

        Analysis windows are legitimately larger than a chart viewport, so the
        range is fetched in slices that each respect the configured limit and
        then stitched back together.
        """

        settings = get_settings()
        step = max(1, settings.max_bars_per_request) * interval_ms(interval)
        collected: dict[int, Candle] = {}
        last: BarsResult | None = None
        cached_all = True
        cursor = start

        while cursor < end:
            chunk_end = min(cursor + step, end)
            result = await self.get_bars(symbol, interval, cursor, chunk_end)
            for candle in result.bars:
                collected[candle.time] = candle
            cached_all = cached_all and result.cached
            last = result
            if chunk_end >= end:
                break
            cursor = chunk_end

        bars = [collected[key] for key in sorted(collected)]
        if last is None:
            return BarsResult(
                symbol=symbol,
                interval=interval,
                provider=self._preferred_provider(),
                cached=True,
                fallback_active=False,
                bars=[],
            )
        return last.model_copy(update={"bars": bars, "cached": cached_all})

    async def available_range(self, symbol: str, interval: str) -> tuple[int | None, int | None]:
        store = storage_interval(interval)

        def _bounds() -> tuple[int | None, int | None]:
            from app.database.repository import candle_bounds

            with session_scope() as session:
                return candle_bounds(session, symbol, store)

        return await anyio.to_thread.run_sync(_bounds)


_service: CandleService | None = None



def get_candle_service() -> CandleService:
    global _service
    if _service is None:
        _service = CandleService()
    return _service


async def shutdown_candle_service() -> None:
    global _service
    if _service is not None:
        await _service.close()
    _service = None
