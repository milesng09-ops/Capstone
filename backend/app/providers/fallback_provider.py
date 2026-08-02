"""Automatic fallback across the provider chain.

Priority is fixed: **Massive -> Yahoo Finance -> bundled demo data**, filtered
by the ``DATA_PROVIDER`` setting:

===================  =========================================================
``DATA_PROVIDER``    Chain
===================  =========================================================
``auto``             massive (if a key exists) -> yahoo -> demo
``massive``          massive -> yahoo -> demo
``yahoo``            yahoo -> demo
``demo``             demo only
===================  =========================================================

Any :class:`ProviderError` moves the request to the next link and is recorded
in the health registry, so a provider that is down is skipped entirely on
subsequent requests until its cool-off expires.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.config import get_settings
from app.models.domain import Candle, Instrument, ProviderFetchResult
from app.providers.base import MarketDataProvider, ProviderError, ProviderNotConfiguredError
from app.providers.demo_provider import DemoProvider
from app.providers.health import ProviderHealthRegistry, get_health_registry
from app.providers.massive_provider import MassiveProvider
from app.providers.yahoo_provider import YahooProvider
from app.utils.intervals import resolve_fetch_interval

logger = logging.getLogger(__name__)

CHAINS: dict[str, list[str]] = {
    "auto": ["massive", "yahoo", "demo"],
    "massive": ["massive", "yahoo", "demo"],
    "yahoo": ["yahoo", "demo"],
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
    ) -> ProviderFetchResult:
        """Fetch bars and report which provider actually served them.

        ``interval`` is the *requested* interval; each provider is asked for
        the closest interval it serves natively, and the caller aggregates.
        """

        chain = self.chain()
        primary = chain[0] if chain else "demo"
        reason: str | None = None
        last_error: Exception | None = None

        for position, name in enumerate(chain):
            provider = self._providers[name]

            if not self._registry.is_available(name):
                entry = self._registry.entry(name)
                skip_reason = entry.last_error or "recent failure"
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

            try:
                if not await provider.is_configured():
                    raise ProviderNotConfiguredError(
                        "missing credentials or dependencies", provider=name
                    )
                bars = await provider.get_bars(symbol, fetch_interval, start_time, end_time)
            except ProviderError as exc:
                last_error = exc
                self._registry.mark_failure(name, str(exc), permanent=exc.permanent)
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
            return ProviderFetchResult(
                provider=name,
                interval=fetch_interval,
                bars=bars,
                quality=provider.quality,  # type: ignore[arg-type]
                fallback_reason=self._last_reason,
            )

        # Nothing in the chain worked. Demo data is the guaranteed floor, so we
        # only get here when demo itself was excluded or broken.
        message = str(last_error) if last_error else "no provider produced data"
        raise ProviderError(f"All providers failed: {message}", provider="auto")

    def native_interval_for(self, provider_name: str, interval: str) -> str:
        provider = self._providers[provider_name]
        return resolve_fetch_interval(interval, provider.native_intervals)
