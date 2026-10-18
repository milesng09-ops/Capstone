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
import time
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
    drop_provider_candles,
    drop_unreal_candles,
    earliest_bar,
    provider_rank,
    series_owner,
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
from app.providers.trading_hours import (
    empty_response_indicts_provider,
    has_trading_session,
)
from app.services.aggregation_service import aggregate_candles, bucket_end
from app.services.cache_service import (
    align_range,
    align_down,
    fresh_horizon,
    cacheable_end,
    edge_padding_ms,
    estimate_bar_count,
    merge_adjacent,
    storage_interval,
)
from app.utils.intervals import (
    DAY_MS,
    get_interval,
    interval_ms,
    is_calendar_anchored,
    is_intraday,
)
from app.utils.timeutils import (
    MAX_TIMESTAMP_MS,
    MIN_TIMESTAMP_MS,
    TimestampOutOfRangeError,
    from_ms,
    now_ms,
)

logger = logging.getLogger(__name__)


#: What to tell the user when a fetched range was refused rather than failed.
#: Both are our own rules about what may sit in one series, and each wants a
#: different response -- so they do not get the same sentence.
_DECLINED_REASONS: dict[str, str] = {}


class _PersistOutcome(str, Enum):
    """Why a fetched range did or did not make it into the cache.

    Three outcomes, because the caller has to explain the failure and the two
    failures are unrelated: one is our own rule about not mixing generated
    bars into real prices, the other is a provider that did not answer. Told
    the wrong one, the user goes looking for a data-source setting when the
    real answer is to wait.
    """

    STORED = "stored"
    #: Stored, after evicting a less preferred provider that owned the series.
    #: The evicted bars take their coverage with them, so the rest of the
    #: window is missing until it is fetched again from the new owner -- which
    #: the caller does in the same request rather than drawing a chart of a
    #: few fresh bars.
    STORED_REBASED = "stored_rebased"
    #: Stored, but the provider answered for less of the window than was
    #: asked for while the market was open in the part it skipped. Yahoo does
    #: this by design: it trims an intraday request to its own retention limit
    #: and says nothing. The bars that did arrive are real and worth keeping;
    #: the series is simply shorter than requested, and has to say so.
    STORED_SHORT = "stored_short"
    #: Generated bars offered for a series that already holds real prices.
    DECLINED_GENERATED = "declined_generated"
    #: Real bars offered for a series another real provider already owns.
    #: Two real providers are not two views of one price -- see
    #: :data:`app.database.repository.PROVIDER_PREFERENCE`.
    DECLINED_FOREIGN = "declined_foreign"
    #: The market was open and nothing came back.
    NOT_SERVED = "not_served"
    #: Nothing came back for a stretch wholly older than any bar the provider
    #: has served for this series: its history starts later. Recorded as
    #: answered, so it is not asked for again, and reported as partial.
    NOT_HELD = "not_held"


_DECLINED_REASONS.update(
    {
        _PersistOutcome.DECLINED_GENERATED: (
            "This range could not be fetched from a market-data provider, and "
            "generated data is not mixed into a series of real prices."
        ),
        _PersistOutcome.DECLINED_FOREIGN: (
            "The fallback provider quotes a different series for this market -- "
            "its continuous contract is not the stitched front month these bars "
            "come from, and after a roll the two differ by hundreds of points. "
            "Its prices are not mixed in, so this stretch is still missing. "
            "Clear the cache for this market to rebuild it from the fallback "
            "instead."
        ),
    }
)


#: The provider answered for less of a window than was asked for.
_SHORT_REASON = (
    "The provider does not hold the whole of this window, so the chart starts "
    "later than the range you asked for. Try a shorter history, or a larger "
    "interval that reaches further back."
)

#: The market was open and nothing came back.
_NOT_SERVED_REASON = (
    "The provider returned no candles for part of this window while the market "
    "was open, so that stretch is still missing. It will be asked for again."
)

#: The preferred provider was over its quota, so a fallback answered -- with a
#: different series, which is not mixed in. Unlike the plain refusal above, the
#: answer here is to wait, not to clear anything.
_RATE_LIMITED_FOREIGN_REASON = (
    "The fallback's prices are a different series and are not mixed into this "
    "one, so this stretch is fetched again once the rate limit clears."
)


class RequestTooLargeError(ValueError):
    """Raised when a query would exceed the configured cost limits."""


def _deadline(seconds: float | None) -> float | None:
    return None if seconds is None else time.monotonic() + max(0.0, seconds)


@dataclass(frozen=True)
class _TailFailure:
    """Why the last attempt at a series' forming tail came back empty-handed.

    Kept so that reusing that attempt -- the whole point of the tail memo --
    reports the failure rather than a clean cache hit.
    """

    reason: str
    rate_limited: bool
    #: When the provider said it would take requests again, on the monotonic
    #: clock, so a reuse a few seconds later counts down instead of repeating
    #: the original wait.
    retry_at: float | None

    def retry_after(self) -> float | None:
        if self.retry_at is None:
            return None
        return max(0.0, self.retry_at - time.monotonic())


@dataclass
class _FetchState:
    """Running account of one :meth:`CandleService._ensure_cached` call."""

    provider: str
    quality: str = "delayed"
    fallback_reason: str | None = None
    fetched_any: bool = False
    attempted: int = 0
    failed: int = 0
    rate_limited: bool = False
    retry_after: float | None = None
    #: A less preferred owner was evicted while storing, so the rest of the
    #: window has to be fetched again from the provider that replaced it.
    rebased: bool = False

    def wait(self, seconds: float | None) -> None:
        if seconds is not None:
            self.retry_after = seconds if self.retry_after is None else max(self.retry_after, seconds)

    def fail(
        self, reason: str, *, rate_limited: bool = False, retry_after: float | None = None
    ) -> None:
        self.failed += 1
        self.fallback_reason = self.fallback_reason or reason
        if rate_limited:
            self.rate_limited = True
            self.wait(retry_after)

    def reuse(self, failure: _TailFailure) -> None:
        self.attempted += 1
        self.fail(
            failure.reason,
            rate_limited=failure.rate_limited,
            retry_after=failure.retry_after(),
        )

    def outcome(self) -> "_CacheOutcome":
        reason = self.fallback_reason
        if self.failed:
            missing = f"{self.failed} of {self.attempted} missing range(s) could not be fetched"
            reason = f"{missing}: {reason}" if reason else missing
        return _CacheOutcome(
            served_from_cache=not self.fetched_any,
            provider=self.provider,
            fallback_reason=reason,
            quality=self.quality,
            incomplete=self.failed > 0,
            rate_limited=self.rate_limited,
            retry_after_seconds=self.retry_after,
        )


def _with_cause(result: object, reason: str) -> str:
    """``reason``, led by the provider chain's own account when it gave one."""

    cause = (getattr(result, "fallback_reason", None) or "").strip()
    if not cause:
        return reason
    return f"{cause if cause.endswith(('.', '!', '?')) else cause + '.'} {reason}"


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
        #: Per series: when its forming tail was last asked for, on the
        #: monotonic clock, and where that request began -- the start of the
        #: earliest gap that reached into the tail. See
        #: :meth:`_settled_gaps_only` for why both are needed.
        self._tail_fetched: dict[tuple[str, str], tuple[float, int]] = {}
        #: Per series: how the last tail request failed, if it did. Read only
        #: while the memo above is in force.
        self._tail_failures: dict[tuple[str, str], _TailFailure] = {}

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
        if start < MIN_TIMESTAMP_MS or end > MAX_TIMESTAMP_MS:
            # Checked here as well as where query parameters are parsed: the
            # backtest body reaches this service without passing through that
            # parser, and a timestamp past a signed 64-bit integer otherwise
            # fails inside SQLite as a 500.
            raise TimestampOutOfRangeError(
                f"The window {start}..{end} is outside the supported range "
                "(1970-01-01 to 2100-01-01, in Unix milliseconds)."
            )

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
        right = requested.end + padding
        if is_calendar_anchored(interval):
            # The padding is a day, and a week or a month is not, so a window
            # ending inside one -- every backtest selection does, since it ends
            # at the *open* of its last bar -- used to aggregate that last bar
            # from a single day: the right open, a Monday close, a fifth of the
            # volume. A bucket that has already closed is loaded whole. One
            # still forming is left alone; there is nothing after now to load.
            closes = bucket_end(requested.end, interval, instrument.timezone)
            if closes <= now_ms():
                right = max(right, closes - 1)
        padded = align_range(
            TimeRange(max(MIN_TIMESTAMP_MS, requested.start - padding), right),
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
        if not outcome.incomplete:
            # A window reaching back past the provider's history is answered
            # once and then served from the cache -- and a cache hit must not
            # read as a complete window. The stored bars say where the history
            # starts, so this survives a restart along with them.
            depth = await anyio.to_thread.run_sync(
                self._history_shortfall, instrument.symbol, store_interval, requested.start
            )
            if depth is not None:
                floor, owner = depth
                if quality != "demo":
                    quality = "partial"
                fallback_reason = fallback_reason or (
                    f"{self._provider_label(owner)}'s history for {instrument.symbol} "
                    f"starts at {from_ms(floor):%Y-%m-%d %H:%M} UTC, so the chart starts "
                    "later than the range you asked for. The earlier part of this "
                    "window is not available from it."
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
    def _tail_fetch(self, symbol: str, store_interval: str) -> int | None:
        """Where the last request for the tail began, if it was recent.

        The tail is never recorded as covered -- that is the whole freshness
        policy, and it is what keeps the bar currently forming up to date. The
        cost is that *every* request asks the provider for it again, and one
        view of one market is several requests: the candles, and the
        detections, which fetch the correlated market as well so it has
        something to read SMT against. A two-chart workspace therefore asked
        for six series on a change of timeframe and poked the provider six
        times for the same handful of forming bars. Against a quota of five
        calls a minute that is more than a minute's budget for one click, and
        a 4h request was measured at 150.8 seconds end to end because of it.

        Monotonic rather than wall clock: this is "how long since we asked",
        which must not jump when the system clock is corrected.
        """

        recorded = self._tail_fetched.get((symbol, store_interval))
        if recorded is None:
            return None
        when, tail_start = recorded
        if (time.monotonic() - when) >= get_settings().fresh_tail_min_seconds:
            return None
        return tail_start

    def _settled_gaps_only(
        self, symbol: str, store_interval: str, gaps: list[TimeRange]
    ) -> list[TimeRange]:
        """Drop gaps that are nothing but a tail we have just asked for.

        A gap is the tail just asked for when it still reaches past the
        present horizon and begins no earlier than that request did -- the
        same stretch, or the part of it that was not recorded as covered.
        Anything beginning before that request reached back to is history,
        however far forward it also runs, and is never dropped.

        The comparison is with where the request *began*, not with the
        horizon in force when it was made, which is the subtlety this turns
        on. The tail gap begins where coverage stopped, and that is behind
        the horizon whenever the last bar is: after a failed attempt, which
        records no coverage at all, and over a weekend, a holiday or the
        daily halt, when the last bar is Friday's or the one before the halt.
        Measured against the horizon, those tails read as missing history and
        were asked for on every request -- the provider that had just refused
        asked again a moment later, and a weekend view of one market made a
        provider call per request for a market that was shut.
        """

        tail_start = self._tail_fetch(symbol, store_interval)
        if tail_start is None:
            return gaps
        horizon = fresh_horizon(store_interval)
        settled = [
            gap for gap in gaps if not (gap.start >= tail_start and gap.end > horizon)
        ]
        if len(settled) == len(gaps):
            return gaps
        logger.debug(
            "Reusing the tail of %s %s, fetched moments ago", symbol, store_interval
        )
        return settled

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
        reused: _TailFailure | None = None
        if not force_refresh:
            kept = self._settled_gaps_only(symbol, store_interval, gaps)
            if len(kept) != len(gaps):
                # The tail was asked for moments ago. If that attempt failed,
                # reusing it must say so rather than read as a clean cache hit.
                reused = self._tail_failures.get((symbol, store_interval))
            gaps = kept

        if not gaps:
            provider_name = (
                await anyio.to_thread.run_sync(self._cached_provider, symbol, store_interval)
                or self._preferred_provider()
            )
            state = _FetchState(provider=provider_name, quality="cached")
            if reused is not None:
                state.reuse(reused)
            return state.outcome()

        state = _FetchState(provider=self._preferred_provider())
        if reused is not None:
            state.reuse(reused)
        await self._fetch_gaps(symbol, store_interval, gaps, state)

        if state.rebased:
            # The series just changed hands: a preferred provider answered for
            # a series a fallback had filled, and the fallback's bars went, with
            # their coverage. What is missing now is the rest of this window,
            # and it is fetched here, once, rather than serving a chart of the
            # few bars that were just stored and leaving the rest to whenever
            # the next request happens to come.
            more = await anyio.to_thread.run_sync(
                self._compute_gaps, symbol, store_interval, window, False
            )
            more = self._settled_gaps_only(symbol, store_interval, more)
            if more:
                await self._fetch_gaps(symbol, store_interval, more, state)

        return state.outcome()

    async def _fetch_gaps(
        self,
        symbol: str,
        store_interval: str,
        gaps: list[TimeRange],
        state: _FetchState,
    ) -> None:
        """Fetch and store each gap, recording what happened in ``state``."""

        key = (symbol, store_interval)
        gaps = merge_adjacent(gaps, store_interval)
        # Marked on the attempt rather than on success. A provider that just
        # refused is the last one worth asking again a tenth of a second
        # later, and the caller reports the range as unfilled either way.
        horizon = fresh_horizon(store_interval)
        tail = [gap for gap in gaps if gap.end > horizon]
        if tail:
            self._tail_fetched[key] = (time.monotonic(), min(gap.start for gap in tail))
        tail_failure: _TailFailure | None = None
        # Only the real chain decides what an empty answer means; a stand-in
        # provider is asked exactly as before.
        knows_history = isinstance(self._provider, AutomaticFallbackProvider)

        for requested in gaps:
            in_tail = requested.end > horizon
            state.attempted += 1
            # Coverage edges need not coincide with bar opens. A finer
            # provider response must contain the whole bucket before it can
            # replace an already cached aggregate.
            gap = TimeRange(
                align_down(requested.start, store_interval),
                align_down(requested.end, store_interval) + interval_ms(store_interval) - 1,
            )
            # Read per gap, since storing one can move it: how far back the
            # series owner's history is known to reach, so the chain can tell
            # "it does not hold this" from "it failed to send this".
            held_from = (
                await anyio.to_thread.run_sync(self._series_floor, symbol, store_interval)
                if knows_history
                else None
            )
            try:
                if held_from:
                    result = await self._provider.fetch(
                        symbol,
                        store_interval,
                        from_ms(gap.start),
                        from_ms(gap.end),
                        held_from=held_from,
                    )
                else:
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
                state.fail(str(exc), rate_limited=True, retry_after=exc.retry_after_seconds)
                if in_tail and tail_failure is None:
                    tail_failure = _TailFailure(
                        str(exc), True, _deadline(exc.retry_after_seconds)
                    )
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
                state.fail(str(exc))
                if in_tail and tail_failure is None:
                    tail_failure = _TailFailure(str(exc), False, None)
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
            # Set when the chain met a quota before this answer: the preferred
            # provider is over its limit, and that -- not the answer -- is why
            # anything still missing is missing.
            limited = bool(getattr(result, "rate_limited", False))
            wait = getattr(result, "retry_after_seconds", None) if limited else None

            if outcome in (_PersistOutcome.STORED, _PersistOutcome.STORED_REBASED):
                # Only a range that was actually stored may name the provider
                # and the quality of the response.
                state.provider = result.provider
                state.quality = result.quality
                state.fallback_reason = result.fallback_reason or state.fallback_reason
                state.fetched_any = True
                state.rebased = state.rebased or outcome is _PersistOutcome.STORED_REBASED
                continue

            if outcome is _PersistOutcome.STORED_SHORT:
                # The bars we did get are real and are kept; the response
                # simply has to admit it is shorter than the window asked for.
                state.fail(
                    _with_cause(result, _SHORT_REASON) if limited else _SHORT_REASON,
                    rate_limited=limited,
                    retry_after=wait,
                )
                state.provider = result.provider
                state.quality = result.quality
                state.fetched_any = True
                continue

            if outcome is _PersistOutcome.NOT_HELD:
                # Asked once and recorded as answered: older than the
                # provider's history, which is a shorter series rather than a
                # failure -- partial, and named after the provider that holds
                # the rest of it.
                state.fail(_SHORT_REASON)
                state.provider = result.provider
                state.quality = result.quality
                continue

            # The range stays unfilled either way, which the response reports
            # as incomplete -- a gap in the chart is honest. But the reasons
            # want different responses from the user, so they are not given
            # the same sentence. Above all, a quota is not a reason to clear
            # the cache: that is advice for a fallback serving a different
            # series, and taken during a cool-off it would rebuild the series
            # from that very fallback.
            if limited:
                reason = _with_cause(
                    result,
                    _RATE_LIMITED_FOREIGN_REASON
                    if outcome is _PersistOutcome.DECLINED_FOREIGN
                    else _DECLINED_REASONS.get(outcome, _NOT_SERVED_REASON),
                )
            else:
                reason = _DECLINED_REASONS.get(outcome, _NOT_SERVED_REASON)
            state.fail(reason, rate_limited=limited, retry_after=wait)
            if in_tail and tail_failure is None:
                tail_failure = _TailFailure(reason, limited, _deadline(wait))

        if tail:
            if tail_failure is None:
                self._tail_failures.pop(key, None)
            else:
                self._tail_failures[key] = tail_failure

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

        Two real providers are ranked by :data:`PROVIDER_PREFERENCE`. A less
        preferred one is declined for a series the other owns; the preferred
        one takes over a series the other filled, evicting it, which is the
        rule the startup repair already applies to a series holding both.

        A stretch the provider was asked for and answered with nothing, lying
        wholly before the oldest bar it has ever served for the series, is
        history it does not hold. It is recorded as answered -- otherwise
        every view and every change of interval asks for it again -- and the
        window is still reported as partial, from the stored bars, when it is
        read. A stretch it answered with nothing *inside* the history it holds
        stays owed: that is a hole, and covering it would hide it.

        Returns which of the outcomes applied.
        """

        rebased = False
        short = False
        with session_scope() as session:
            # Read before anything is stored or evicted: how far back this
            # provider's history was already known to reach for the series.
            known = earliest_bar(session, symbol, store_interval, provider)
            prior_floor = known[0] if known is not None else None

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
                # A series holds one real provider's prices. Massive's
                # stitched front-month contracts and Yahoo's own continuous
                # series are different series, not two readings of the same
                # one, and blending them draws a 300-point roll step as a
                # cliff in the middle of the chart. The owner keeps the
                # series against a fallback, whose bars are served to nobody
                # rather than stored where they will be read as the same
                # instrument.
                owner = series_owner(session, symbol, store_interval)
                if owner is not None and owner != provider:
                    if provider_rank(provider) >= provider_rank(owner):
                        logger.warning(
                            "Declined %d %s bars for %s %s: the series holds %s prices",
                            len(bars),
                            provider,
                            symbol,
                            store_interval,
                            owner,
                        )
                        return _PersistOutcome.DECLINED_FOREIGN
                    # The owner is the fallback: it filled the series while the
                    # preferred provider was cooling off, or before it had a key.
                    # Declining the preferred provider here locked it out for
                    # good -- every later answer refused, the forming bar never
                    # updated -- so the fallback is evicted instead, coverage and
                    # all, and the caller fetches the rest of the window again.
                    removed = drop_provider_candles(session, symbol, store_interval, owner)
                    rebased = True
                    logger.warning(
                        "Evicted %d %s bars from %s %s: %s is preferred and has answered",
                        removed,
                        owner,
                        symbol,
                        store_interval,
                        provider,
                    )

                evicted = drop_unreal_candles(session, symbol, store_interval)
                if evicted:
                    logger.info(
                        "Evicted %d unreal bars from %s %s now that %s can serve it",
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
                if prior_floor is not None and gap.end < prior_floor:
                    # Older than anything this provider has served for the
                    # series, and answered with nothing: not held. Recorded so
                    # it is asked for once rather than on every request.
                    covered_to = cacheable_end(gap.end, store_interval)
                    if covered_to >= gap.start:
                        record_coverage(
                            session, symbol, store_interval, gap.start, covered_to, provider
                        )
                    return _PersistOutcome.NOT_HELD
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

            # A window answered only in part is not a clean fetch. Without this
            # a two-year daily chart served the provider's last 720 days came
            # back labelled "live", with nothing on screen to say the earlier
            # years were missing rather than empty -- which is the same lie as
            # demo data wearing a real provider's name, told about the length
            # of the series instead of its contents. The tail is exempt: it is
            # trimmed on purpose, because the forming bar is refetched every
            # time.
            instrument = get_instrument(symbol)
            short = bool(bars) and has_trading_session(
                gap.start, served_start, tz_name=instrument.timezone
            )
            if short and (prior_floor is None or prior_floor >= served_start):
                # The answer starts later than the gap, and nothing older than
                # it was ever served: the provider's history begins here. The
                # stretch before it is answered, so it is not asked for again
                # on every view; reading the window reports it as partial.
                record_coverage(
                    session, symbol, store_interval, gap.start, served_start - 1, provider
                )

        if rebased:
            # Whether the new owner holds the whole window is decided by the
            # refetch of the rest of it, which follows immediately.
            return _PersistOutcome.STORED_REBASED
        if short:
            return _PersistOutcome.STORED_SHORT
        return _PersistOutcome.STORED

    @staticmethod
    def _served_span(
        symbol: str, store_interval: str, bars: list[Candle], gap: TimeRange
    ) -> tuple[int, int] | None:
        """Which part of ``gap`` this response may be recorded as covering.

        ``None`` means "record nothing": the market was open and the provider
        returned nothing, so the range is still owed to us.

        An empty response has three meanings and they must not be conflated.
        Over a weekend or the daily halt it is the correct answer, and
        re-asking would spend the quota re-confirming the market was shut.
        Over a stretch the market was open it means we were not served, and
        covering it would bake the hole in permanently.

        Between those sits a window holding barely any open market at all --
        the tail of an expiring contract, the single hour before a Friday
        close -- where the vendor has no bar and never will.  The provider
        already excuses that rather than calling it an outage, and this has to
        agree with it: excused there and still owed here means the range is
        asked for, politely answered with nothing, left uncovered, and asked
        for again on the next poll, forever.  That is not theoretical -- it
        was three Massive calls a minute against a five-a-minute quota, with
        nobody touching the page.  The same predicate decides both.

        With bars, the span is the bars' own extent -- **both** ends. Yahoo
        trims a long intraday request at the *old* end, so taking the gap's
        start on trust would record the years it never sent as covered, which
        is the same permanent hole by the other door. Coverage rows are
        end-inclusive, so the last bar's own timestamp is the end: claiming an
        interval beyond it would mark a bar that was never fetched.

        Except where no bar could have been. Closed market before the first
        bar holds none, and neither does settled history between the end of
        the last bar's own bucket and the end of the gap when the market was
        shut for all of it -- the weekend after a Friday close, or nothing at
        all because the gap ends inside that bucket. Stopping at the last
        bar's open there left a seam between two fetches that met at a bar
        boundary: the gap ``[last + 1ms, next - 1ms]`` was aligned back to
        ``last``, answered with that one bar, recorded as nothing new, and
        asked for again on every request. The trailing extension is held to
        settled history so the forming tail is never claimed, and the bar at
        its edge is always asked for again.
        """

        instrument = get_instrument(symbol)
        if not bars:
            if empty_response_indicts_provider(
                gap.start, gap.end, store_interval, tz_name=instrument.timezone
            ):
                return None
            return gap.start, gap.end

        times = [bar.time for bar in bars]
        first, last = min(times), max(times)
        start = max(gap.start, first)
        end = min(gap.end, last)
        if start > gap.start and not has_trading_session(
            gap.start, first, tz_name=instrument.timezone
        ):
            start = gap.start
        if (
            end < gap.end
            and gap.end < fresh_horizon(store_interval)
            and not has_trading_session(
                last + interval_ms(store_interval), gap.end + 1, tz_name=instrument.timezone
            )
        ):
            end = gap.end
        return start, end

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

    @staticmethod
    def _series_floor(symbol: str, store_interval: str) -> dict[str, int] | None:
        """The series owner, mapped to the oldest bar it has served for it."""

        with session_scope() as session:
            owner = series_owner(session, symbol, store_interval)
            if owner is None:
                return None
            oldest = earliest_bar(session, symbol, store_interval, owner)
        return {owner: oldest[0]} if oldest is not None else None

    @staticmethod
    def _history_shortfall(
        symbol: str, store_interval: str, start: int
    ) -> tuple[int, str] | None:
        """Where the stored history begins, if a window starting at ``start``
        reaches more than a bar of open market further back than that.

        Answered from the bars themselves, so a window recorded as "not held"
        before a restart still reads as partial after it.
        """

        with session_scope() as session:
            oldest = earliest_bar(session, symbol, store_interval)
        if oldest is None or start >= oldest[0]:
            return None
        instrument = get_instrument(symbol)
        # Open market, more than one bar of it, between the window's start and
        # the first bar: the same test that decides when an empty answer is a
        # real absence rather than a closed market or a single missing bar.
        if not empty_response_indicts_provider(
            start, oldest[0], store_interval, tz_name=instrument.timezone
        ):
            return None
        return oldest

    def _provider_label(self, name: str) -> str:
        providers = getattr(self._provider, "providers", None)
        provider = providers.get(name) if isinstance(providers, dict) else None
        return getattr(provider, "display_name", None) or name.title()

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

        **The whole window is capped, not just each slice.** Every interval is
        built from an intraday stored series, and a chart may not ask for more
        than ``max_intraday_history_days`` of one. Without the same limit here
        the slicing turned any range into a fan-out: a single detections
        request for 1970 to now made 28 slices per symbol, about nine provider
        calls each against a five-a-minute quota.

        **Provenance is stitched too.** Reporting the last slice's verdict for
        the whole series is how a win rate measured across a rate-limited or
        part-generated window came to be labelled ``live``: the earlier slices
        carried the warning and the final one, fetched cleanly, overwrote it.
        A series is described by its weakest part, the same rule the chart
        path applies to a window that mixes providers.
        """

        settings = get_settings()
        store = storage_interval(interval)
        if end > start and is_intraday(store):
            span_days = (end - start) / DAY_MS
            if span_days > settings.max_intraday_history_days:
                raise RequestTooLargeError(
                    f"Requested {span_days:,.0f} days of history to analyse on {interval}. "
                    f"The limit is {settings.max_intraday_history_days} days - "
                    "narrow the date range."
                )
        step = max(1, settings.max_bars_per_request) * interval_ms(store)
        step = min(step, settings.max_intraday_history_days * DAY_MS)
        # One provider's prices from end to end. A preferred provider answering
        # for a series a fallback filled takes it over and evicts the old
        # owner's bars -- but slices read before that happened were already
        # collected from the old owner, and stitched together the two would
        # put a step in the prices at the seam. One more pass reads every slice
        # from the series as it now stands.
        for _attempt in range(2):
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

            owners = {chunk.provider for chunk in chunks} - {DEMO_PROVIDER}
            if len(owners) <= 1:
                break

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
