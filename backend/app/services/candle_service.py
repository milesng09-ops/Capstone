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
from enum import Enum

import anyio

from app.config import get_settings
from app.database.repository import (
    DEMO_PROVIDER,
    TimeRange,
    candle_provider,
    drop_demo_candles,
    has_real_candles,
    load_candles,
    load_coverage,
    missing_ranges,
    providers_in_range,
    record_coverage,
    save_candles,
)
from app.database.session import session_scope
from app.models.domain import BarsResult, Candle
from app.providers.base import ProviderRateLimitError
from app.providers.fallback_provider import AutomaticFallbackProvider
from app.providers.instruments import get_instrument
from app.providers.trading_hours import has_trading_session
from app.services.aggregation_service import aggregate_candles
from app.services.cache_service import (
    align_range,
    cacheable_end,
    edge_padding_ms,
    estimate_bar_count,
    merge_adjacent,
    storage_interval,
)
from app.utils.intervals import get_interval, interval_ms, is_intraday
from app.utils.timeutils import from_ms

logger = logging.getLogger(__name__)


class _PersistOutcome(str, Enum):
    """Why a fetched range did or did not make it into the cache.

    Three outcomes, because the caller has to explain the failure and the two
    failures are unrelated: one is our own rule about not mixing generated
    bars into real prices, the other is a provider that did not answer. Told
    the wrong one, the user goes looking for a data-source setting when the
    real answer is to wait.
    """

    STORED = "stored"
    #: Generated bars offered for a series that already holds real prices.
    DECLINED_GENERATED = "declined_generated"
    #: The market was open and nothing came back.
    NOT_SERVED = "not_served"


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
    #: Set when the reason for an unfilled gap was a provider quota rather
    #: than an outage. Kept separate from ``fallback_reason`` because the UI
    #: acts on it -- it counts down and refetches -- instead of only showing
    #: it, and parsing that intent back out of English prose is not something
    #: the frontend should be doing.
    rate_limited: bool = False
    retry_after_seconds: float | None = None

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
        # Sized against the interval that is actually FETCHED, not the one that
        # was asked for. A daily chart is built from hourly bars, so counting
        # dailies would let a two-year request through as 521 bars and then go
        # and fetch twelve thousand.
        store = storage_interval(interval)
        bars = estimate_bar_count(requested, store)
        if bars > settings.max_bars_per_request:
            raise RequestTooLargeError(
                f"Requested {bars:,} bars of {store} data to build {interval}. "
                f"The limit is {settings.max_bars_per_request:,} bars per request - "
                "narrow the date range or use a larger interval."
            )

        if is_intraday(store):
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
        # edges are built from complete data. The amount is a property of the
        # stored series rather than of the interval on screen, so that every
        # view of one range asks for exactly the same window.
        padding = edge_padding_ms(interval)
        padded = align_range(
            TimeRange(requested.start - padding, requested.end + padding),
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

        # What the window is *made of*, which is not the same question as who
        # served the last fetch. A cache written before generated bars were
        # kept out of real series can still hold both, and the label has to
        # describe the candles on screen rather than the most recent write.
        contents = await anyio.to_thread.run_sync(
            self._window_providers, instrument.symbol, store_interval, padded
        )
        quality = outcome.resolved_quality()
        fallback_reason = outcome.fallback_reason
        mixed = DEMO_PROVIDER in contents and contents != {DEMO_PROVIDER}
        if DEMO_PROVIDER in contents:
            # One generated candle makes the whole window unsafe to read as
            # market data, so it is labelled by its weakest part.
            quality = "demo"
        if mixed:
            fallback_reason = fallback_reason or (
                "This range mixes real prices with generated bars left by an earlier "
                "provider outage. Clear the cache for this symbol to refetch it."
            )

        return BarsResult(
            symbol=instrument.symbol,
            interval=interval,
            provider=outcome.provider,
            cached=outcome.served_from_cache,
            # A failed fetch is a degraded serve even when the provider name
            # still reads as the preferred one, so it counts as a fallback.
            fallback_active=(
                outcome.incomplete or mixed or outcome.provider != self._preferred_provider()
            ),
            fallback_reason=fallback_reason,
            quality=quality,
            rate_limited=outcome.rate_limited,
            retry_after_seconds=outcome.retry_after_seconds,
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
        rate_limited = False
        retry_after: float | None = None

        for gap in gaps:
            try:
                result = await self._provider.fetch(
                    symbol,
                    store_interval,
                    from_ms(gap.start),
                    from_ms(gap.end),
                )
            except ProviderRateLimitError as exc:
                logger.warning(
                    "Rate limited fetching %s %s %s-%s: %s",
                    symbol,
                    store_interval,
                    gap.start,
                    gap.end,
                    exc,
                )
                rate_limited = True
                if exc.retry_after_seconds is not None:
                    retry_after = (
                        exc.retry_after_seconds
                        if retry_after is None
                        else max(retry_after, exc.retry_after_seconds)
                    )
                fallback_reason = fallback_reason or str(exc)
                failed_gaps += 1
                continue
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

            bars = result.bars
            if result.interval != store_interval:
                instrument = get_instrument(symbol)
                bars = aggregate_candles(
                    bars, store_interval, timezone=instrument.timezone
                )

            outcome = await anyio.to_thread.run_sync(
                self._persist, symbol, store_interval, bars, result.provider, gap
            )
            if outcome is not _PersistOutcome.STORED:
                # The range stays unfilled either way, which the response
                # reports as incomplete -- a gap in the chart is honest. But
                # the two reasons want different responses from the user, so
                # they are not given the same sentence.
                failed_gaps += 1
                fallback_reason = fallback_reason or (
                    "This range could not be fetched from a market-data provider, and "
                    "generated data is not mixed into a series of real prices."
                    if outcome is _PersistOutcome.DECLINED_GENERATED
                    else "The provider returned no candles for part of this window "
                    "while the market was open, so that stretch is still missing. "
                    "It will be asked for again."
                )
                continue

            # Only a range that was actually stored may name the provider and
            # the quality of the response.
            provider_name = result.provider
            quality = result.quality
            fallback_reason = result.fallback_reason or fallback_reason
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
            rate_limited=rate_limited,
            retry_after_seconds=retry_after,
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
    ) -> "_PersistOutcome":
        """Store a fetched range, unless storing it would mix two kinds of data.

        A series is either real or generated, never both. Demo bars are a
        stand-in for a provider that could not answer, and writing them beside
        real prices makes a chart that cannot be read honestly -- nothing on
        screen distinguishes the invented candles, and a backtest run across
        the join reports a win rate that is neither measured nor simulated.

        So a demo fetch into a series that holds real bars is declined, and the
        caller reports the range as one it could not fill. The reverse -- real
        bars arriving for a series that still holds generated ones -- evicts
        them, because that is the moment the stand-in stops being needed.

        Returns which of the three outcomes applied.
        """

        with session_scope() as session:
            if provider == DEMO_PROVIDER:
                if has_real_candles(session, symbol, store_interval):
                    logger.warning(
                        "Declined %d generated bars for %s %s: the series holds real prices",
                        len(bars),
                        symbol,
                        store_interval,
                    )
                    return _PersistOutcome.DECLINED_GENERATED
            elif bars:
                evicted = drop_demo_candles(session, symbol, store_interval)
                if evicted:
                    logger.info(
                        "Evicted %d generated bars from %s %s now that %s can serve it",
                        evicted,
                        symbol,
                        store_interval,
                        provider,
                    )

            if bars:
                save_candles(session, store_interval, bars, provider)

            # Cover what the provider actually served, not what it was asked
            # for. A provider may quietly return less than the window -- Yahoo
            # trims an intraday request to its own retention limit -- and
            # recording the whole gap as covered turns that shortfall into a
            # permanent hole: `missing_ranges` never asks again, and the API
            # then reports the short series as a clean, complete fetch. That
            # is a chart which disagrees with the exchange and cannot say why.
            served = CandleService._served_span(symbol, store_interval, bars, gap)
            if served is None:
                # The market was open and the provider gave us nothing. Leave
                # the range uncovered so the next request asks again.
                return _PersistOutcome.NOT_SERVED

            # Only mark the settled part of the window as covered so the
            # forming bar is always refreshed on the next request.
            served_start, served_end = served
            coverage_end = cacheable_end(served_end, store_interval)
            if coverage_end >= served_start:
                record_coverage(
                    session, symbol, store_interval, served_start, coverage_end, provider
                )
        return _PersistOutcome.STORED

    @staticmethod
    def _served_span(
        symbol: str, store_interval: str, bars: list[Candle], gap: TimeRange
    ) -> tuple[int, int] | None:
        """Which part of ``gap`` this response may be recorded as covering.

        ``None`` means "record nothing": the market was open and the provider
        returned nothing, so the range is still owed to us.

        An empty response has two opposite meanings and they must not be
        conflated. Over a weekend or the daily halt it is the correct answer,
        and re-asking would spend the quota re-confirming the market was shut.
        Over a stretch the market was open it means we were not served, and
        covering it would bake the hole in permanently.

        With bars, the span is the bars' own extent -- **both** ends. Yahoo
        trims a long intraday request at the *old* end, so taking the gap's
        start on trust would record the years it never sent as covered, which
        is the same permanent hole by the other door. Coverage rows are
        end-inclusive, so the last bar's own timestamp is the end: claiming an
        interval beyond it would mark a bar that was never fetched.
        """

        if not bars:
            instrument = get_instrument(symbol)
            if has_trading_session(gap.start, gap.end, tz_name=instrument.timezone):
                return None
            return gap.start, gap.end

        times = [bar.time for bar in bars]
        return max(gap.start, min(times)), min(gap.end, max(times))

    @staticmethod
    def _load_from_cache(symbol: str, store_interval: str, window: TimeRange) -> list[Candle]:
        with session_scope() as session:
            return load_candles(session, symbol, store_interval, window.start, window.end)

    @staticmethod
    def _window_providers(symbol: str, store_interval: str, window: TimeRange) -> set[str]:
        with session_scope() as session:
            return providers_in_range(
                session, symbol, store_interval, window.start, window.end
            )

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

        **Provenance is stitched too.** Reporting the last slice's verdict for
        the whole series is how a win rate measured across a rate-limited or
        part-generated window came to be labelled ``live``: the earlier slices
        carried the warning and the final one, fetched cleanly, overwrote it.
        A series is described by its weakest part, the same rule the chart
        path applies to a window that mixes providers.
        """

        settings = get_settings()
        step = max(1, settings.max_bars_per_request) * interval_ms(interval)
        collected: dict[int, Candle] = {}
        chunks: list[BarsResult] = []
        cursor = start

        while cursor < end:
            chunk_end = min(cursor + step, end)
            result = await self.get_bars(symbol, interval, cursor, chunk_end)
            for candle in result.bars:
                collected[candle.time] = candle
            chunks.append(result)
            if chunk_end >= end:
                break
            cursor = chunk_end

        bars = [collected[key] for key in sorted(collected)]
        if not chunks:
            return BarsResult(
                symbol=symbol,
                interval=interval,
                provider=self._preferred_provider(),
                cached=True,
                fallback_active=False,
                bars=[],
            )
        return _merge_provenance(chunks, bars)

    async def available_range(self, symbol: str, interval: str) -> tuple[int | None, int | None]:
        store = storage_interval(interval)

        def _bounds() -> tuple[int | None, int | None]:
            from app.database.repository import candle_bounds

            with session_scope() as session:
                return candle_bounds(session, symbol, store)

        return await anyio.to_thread.run_sync(_bounds)


#: Data qualities from worst to best. A series that is partly one thing and
#: partly another is described by the worst of them, because that is the only
#: reading that cannot mislead: a win rate measured over a window that is one
#: third generated is not two thirds trustworthy, it is untrustworthy.
#:
#: An unrecognised quality ranks *below* all of these rather than in the
#: middle, so a value added here later cannot accidentally outrank "demo" and
#: suppress the warning that goes with it.
_QUALITY_RANK: dict[str, int] = {
    "demo": 0,
    "partial": 1,
    "cached": 2,
    "delayed": 3,
    "live": 4,
}
_UNKNOWN_QUALITY_RANK = -1


def _merge_provenance(chunks: list[BarsResult], bars: list[Candle]) -> BarsResult:
    """One verdict describing every slice of a stitched series."""

    weakest = min(
        chunks, key=lambda chunk: _QUALITY_RANK.get(chunk.quality, _UNKNOWN_QUALITY_RANK)
    )
    reasons = [chunk.fallback_reason for chunk in chunks if chunk.fallback_reason]
    retries = [
        chunk.retry_after_seconds for chunk in chunks if chunk.retry_after_seconds is not None
    ]

    # One name, never a list. `provider` is compared for equality all over the
    # codebase -- the demo badge on a saved run, the mixed-source guard on an
    # SMT comparison -- and a joined string silently fails every one of those
    # checks: "demo, yahoo" is not "demo", so the badge that says the numbers
    # are synthetic stops appearing on exactly the runs that need it. The
    # weakest slice's provider is the honest single answer, because it is the
    # one that decided the quality reported alongside it.
    providers = {chunk.provider for chunk in chunks}
    provider = weakest.provider if len(providers) > 1 else next(iter(providers))

    return chunks[-1].model_copy(
        update={
            "bars": bars,
            "cached": all(chunk.cached for chunk in chunks),
            "quality": weakest.quality,
            "rate_limited": any(chunk.rate_limited for chunk in chunks),
            "fallback_active": any(chunk.fallback_active for chunk in chunks),
            # Wait for the longest cool-off any slice reported: coming back
            # sooner just spends another call to be refused again.
            "retry_after_seconds": max(retries) if retries else None,
            # De-duplicated in order, so one reason repeated across ten slices
            # reads as one sentence rather than ten. Joined on a full stop,
            # since these are sentences and a bare space runs them together.
            "fallback_reason": _join_reasons(reasons),
            "provider": provider,
        }
    )


def _join_reasons(reasons: list[str]) -> str | None:
    """Distinct reasons as one readable paragraph."""

    unique = [reason.strip() for reason in dict.fromkeys(reasons) if reason.strip()]
    if not unique:
        return None
    return " ".join(
        reason if reason.endswith((".", "!", "?")) else f"{reason}." for reason in unique
    )


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
