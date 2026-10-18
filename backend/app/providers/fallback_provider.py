"""Automatic fallback across the provider chain.

Priority is fixed: **Massive -> Yahoo Finance**, filtered by the
``DATA_PROVIDER`` setting:

===================  =========================================================
``DATA_PROVIDER``    Chain
===================  =========================================================
``auto``             massive (if a key exists) -> yahoo
``massive``          massive -> yahoo
``yahoo``            yahoo
``demo``             demo only
===================  =========================================================

Every automatic chain ends in real market data or in an error.  Demo data is
reachable only by asking for it by name; see :data:`CHAINS`.

Any :class:`ProviderError` moves the request to the next link and is recorded
in the health registry, so a provider that is down is skipped entirely on
subsequent requests until its cool-off expires.  When the chain runs out, a
quota rejection is re-raised intact so the API can answer 429 with the
provider's own ``Retry-After`` rather than a generic outage.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime

from app.config import get_settings
from app.models.domain import Candle, Instrument, ProviderFetchResult
from app.providers.base import (
    MarketDataProvider,
    ProviderError,
    ProviderNoDataError,
    ProviderNotConfiguredError,
    ProviderRateLimitError,
    ProviderThrottledError,
)
from app.providers.demo_provider import DemoProvider
from app.providers.health import ProviderHealthRegistry, get_health_registry
from app.providers.massive_provider import MassiveProvider
from app.providers.yahoo_provider import YahooProvider
from app.utils.intervals import resolve_fetch_interval
from app.utils.timeutils import now_ms, to_ms

logger = logging.getLogger(__name__)


class FallbackFetchResult(ProviderFetchResult):
    """A fetch result that remembers a quota was hit further up the chain.

    When Massive is over its limit and Yahoo answers instead, the answer is
    real data -- but for a series Massive owns it is not data the cache will
    keep, and the reason the range stays missing is the quota, which clears
    by itself. That has to reach the user as "rate limited, wait N seconds",
    not as whatever the cache says about the fallback's prices; the UI tells
    the two apart by ``rate_limited`` alone.
    """

    rate_limited: bool = False
    retry_after_seconds: float | None = None
    #: The provider answered with nothing for a window wholly older than any
    #: bar it has served for the series: history it does not hold, not an
    #: outage. ``bars`` is empty and the provider was not marked unhealthy.
    not_held: bool = False

#: Demo data is deliberately absent from every automatic chain.  It is real
#: prices or nothing: a rate limit that quietly swapped in synthetic candles
#: produced a chart and a win rate indistinguishable from a live run, which is
#: the one failure mode this application cannot afford.  ``DATA_PROVIDER=demo``
#: still reaches it, because choosing it explicitly is not the same as being
#: handed it without being told.
CHAINS: dict[str, list[str]] = {
    "auto": ["massive", "yahoo"],
    "massive": ["massive", "yahoo"],
    "yahoo": ["yahoo"],
    "demo": ["demo"],
}


class AutomaticFallbackProvider(MarketDataProvider):
    """Composite provider that walks the chain until something succeeds."""

    name = "auto"
    display_name = "Automatic"

    def __init__(
        self,
        providers: dict[str, MarketDataProvider] | None = None,
        registry: ProviderHealthRegistry | None = None,
    ) -> None:
        self._registry = registry or get_health_registry()
        self._providers: dict[str, MarketDataProvider] = providers or {
            "massive": MassiveProvider(),
            "yahoo": YahooProvider(),
            "demo": DemoProvider(),
        }
        self._last_active: str | None = None
        self._last_reason: str | None = None

    # ------------------------------------------------------------------
    @property
    def providers(self) -> dict[str, MarketDataProvider]:
        return self._providers

    @property
    def last_active_provider(self) -> str:
        """Provider that served the most recent request.

        Before anything has been fetched this reports the head of the chain, so
        health checks do not claim a fallback that has not happened.
        """

        if self._last_active is not None:
            return self._last_active
        chain = self.chain()
        return chain[0] if chain else "demo"

    @property
    def last_fallback_reason(self) -> str | None:
        return self._last_reason

    def chain(self) -> list[str]:
        settings = get_settings()
        requested = settings.data_provider
        names = list(CHAINS.get(requested, CHAINS["auto"]))
        if requested == "auto" and not settings.massive_api_key_configured:
            # Skip Massive silently in auto mode when no key is present -- this
            # is the normal "just cloned the repo" path, not an error.
            names = [name for name in names if name != "massive"]
        return [name for name in names if name in self._providers]

    async def close(self) -> None:
        for provider in self._providers.values():
            await provider.close()

    # ------------------------------------------------------------------
    async def get_symbols(self) -> list[Instrument]:
        last_error: Exception | None = None
        for name in self.chain():
            provider = self._providers[name]
            if not self._registry.is_available(name):
                continue
            try:
                symbols = await provider.get_symbols()
            except ProviderError as exc:
                last_error = exc
                self._registry.mark_failure(name, str(exc), permanent=exc.permanent)
                continue
            self._registry.mark_success(name)
            return symbols
        if last_error is not None:  # pragma: no cover - demo never fails here
            raise last_error
        return await self._providers["demo"].get_symbols()

    async def get_bars(
        self,
        symbol: str,
        interval: str,
        start_time: datetime,
        end_time: datetime,
    ) -> list[Candle]:
        result = await self.fetch(symbol, interval, start_time, end_time)
        return result.bars

    async def fetch(
        self,
        symbol: str,
        interval: str,
        start_time: datetime,
        end_time: datetime,
        *,
        held_from: Mapping[str, int] | None = None,
    ) -> ProviderFetchResult:
        """Fetch bars and report which provider actually served them.

        ``interval`` is the *requested* interval; each provider is asked for
        the closest interval it serves natively, and the caller aggregates.

        ``held_from`` maps a provider to the earliest bar it has ever served
        for this series, as far as the caller's cache knows. An empty answer
        from that provider for a window ending before it is history the
        provider does not hold -- its archive starts later -- so it is
        returned as an empty, ``not_held`` result instead of being treated as
        an outage: no cool-off, and no fallback asked to fill a stretch whose
        prices would belong to a different series. An empty answer anywhere
        else is still a failure; that is the guard against excusing a real
        hole inside history the provider does hold.
        """

        chain = self.chain()
        primary = chain[0] if chain else "demo"
        reason: str | None = None
        last_error: Exception | None = None
        # A quota rejection outranks whatever failed after it: "you are over
        # the limit, wait N seconds" is actionable, "no provider produced
        # data" is not, and the caller needs the former to reach the user.
        rate_limit_error: ProviderRateLimitError | None = None

        for position, name in enumerate(chain):
            provider = self._providers[name]

            if not self._registry.is_available(name):
                entry = self._registry.entry(name)
                skip_reason = entry.last_error or "recent failure"
                if entry.rate_limited and entry.cooldown_until_ms is not None:
                    # Skipped for a quota cool-off, which is still a quota
                    # problem: the same "wait" outranks what fails after it.
                    rate_limit_error = rate_limit_error or ProviderRateLimitError(
                        f"{provider.display_name} is cooling off after a rate limit: "
                        f"{skip_reason}",
                        provider=name,
                        retry_after_seconds=max(
                            0.0, (entry.cooldown_until_ms - now_ms()) / 1000
                        ),
                    )
                if position + 1 < len(chain):
                    self._registry.record_fallback(name, chain[position + 1], skip_reason)
                reason = reason or f"{provider.display_name} unavailable: {skip_reason}"
                continue

            try:
                fetch_interval = resolve_fetch_interval(interval, provider.native_intervals)
            except Exception as exc:
                message = f"cannot serve interval {interval} ({exc})"
                if position + 1 < len(chain):
                    self._registry.record_fallback(name, chain[position + 1], message)
                reason = reason or f"{provider.display_name} {message}"
                continue

            not_held = False
            try:
                if not await provider.is_configured():
                    raise ProviderNotConfiguredError(
                        "missing credentials or dependencies", provider=name
                    )
                bars = await provider.get_bars(symbol, fetch_interval, start_time, end_time)
            except ProviderError as exc:
                floor = (
                    (held_from or {}).get(name)
                    if isinstance(exc, ProviderNoDataError)
                    else None
                )
                if floor is not None and to_ms(end_time) < floor:
                    # Older than anything it has served for this series, and
                    # answered with nothing: its archive starts later.
                    # Demoting it for that knocked the preferred provider out
                    # of every chart for two minutes on each view of a window
                    # reaching back further than the vendor's history.
                    logger.info(
                        "%s holds no %s %s history before %s; not an outage",
                        provider.display_name,
                        symbol,
                        fetch_interval,
                        floor,
                    )
                    bars = []
                    not_held = True
                else:
                    last_error = exc
                    is_rate_limit = isinstance(exc, ProviderRateLimitError)
                    if is_rate_limit:
                        rate_limit_error = rate_limit_error or exc
                    if isinstance(exc, ProviderThrottledError):
                        # Our own pacing, not the provider's verdict.
                        # Blacklisting it for two minutes would turn a few
                        # seconds of waiting into exactly the outage the
                        # pacing is meant to prevent, so the next request is
                        # free to try again immediately.
                        self._registry.note_throttled(
                            name, exc.retry_after_seconds or 0.0
                        )
                    else:
                        self._registry.mark_failure(
                            name,
                            str(exc),
                            permanent=exc.permanent,
                            rate_limited=is_rate_limit,
                            retry_after_seconds=(
                                exc.retry_after_seconds if is_rate_limit else None
                            ),
                        )
                    if position + 1 < len(chain):
                        next_provider = self._providers[chain[position + 1]]
                        self._registry.record_fallback(name, chain[position + 1], str(exc))
                        reason = reason or (
                            f"{provider.display_name} unavailable: {exc}. "
                            f"Switching to {next_provider.display_name}."
                        )
                    continue
            except Exception as exc:  # noqa: BLE001 - never let a vendor bug 500 us
                last_error = exc
                logger.exception("Unexpected error from provider '%s'", name)
                self._registry.mark_failure(name, f"unexpected error: {exc}")
                reason = reason or f"{provider.display_name} unavailable: unexpected error."
                continue

            self._registry.mark_success(name)
            self._last_active = name
            self._last_reason = reason if name != primary else None
            return FallbackFetchResult(
                provider=name,
                interval=fetch_interval,
                bars=bars,
                quality=provider.quality,  # type: ignore[arg-type]
                fallback_reason=self._last_reason,
                rate_limited=rate_limit_error is not None,
                retry_after_seconds=(
                    rate_limit_error.retry_after_seconds if rate_limit_error else None
                ),
                not_held=not_held,
            )

        # Nothing in the chain worked. There is no synthetic floor to land on
        # any more, so this is a real failure and is reported as one.
        if rate_limit_error is not None:
            raise rate_limit_error
        message = str(last_error) if last_error else "no provider produced data"
        raise ProviderError(f"All providers failed: {message}", provider="auto")

    def native_interval_for(self, provider_name: str, interval: str) -> str:
        provider = self._providers[provider_name]
        return resolve_fetch_interval(interval, provider.native_intervals)
