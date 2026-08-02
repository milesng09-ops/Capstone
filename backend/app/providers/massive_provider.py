"""Massive Futures API provider.

This is the only module that knows anything about Massive: its base URL, its
authentication header, its ticker vocabulary and its response shape.  Swapping
Massive for another commercial vendor means writing a sibling module -- nothing
in the charting, caching or backtesting layers changes.

The client is intentionally tolerant about the response envelope (``data`` /
``bars`` / ``results`` / bare list) and about field naming, because vendor
payloads differ in small ways between plans.  Anything it cannot understand is
raised as :class:`ProviderDataError` so the fallback chain takes over rather
than surfacing a broken chart.

Requests never leave the backend, so ``MASSIVE_API_KEY`` is never exposed to
the browser.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

import httpx

from app.config import get_settings
from app.models.domain import Candle, Instrument
from app.providers.base import (
    MarketDataProvider,
    ProviderAuthError,
    ProviderDataError,
    ProviderNotConfiguredError,
    ProviderRateLimitError,
    ProviderUnavailableError,
)
from app.providers.instruments import get_instrument, list_instruments
from app.services.normalization import normalize_candles
from app.utils.timeutils import to_ms

logger = logging.getLogger(__name__)

#: Canonical symbol -> Massive contract code.  Continuous front-month series.
MASSIVE_SYMBOL_MAP: dict[str, str] = {
    "ES": "CME:ES1!",
    "NQ": "CME:NQ1!",
    "YM": "CBOT:YM1!",
}

#: Canonical interval -> Massive resolution string.
MASSIVE_INTERVAL_MAP: dict[str, str] = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "6h": "6h",
    "1d": "1d",
}

#: Response envelopes we know how to unwrap.
_ENVELOPE_KEYS = ("bars", "data", "results", "candles", "ohlcv")


class MassiveProvider(MarketDataProvider):
    name = "massive"
    display_name = "Massive"
    native_intervals = set(MASSIVE_INTERVAL_MAP)
    quality = "live"

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        settings = get_settings()
        self._api_key = (api_key if api_key is not None else settings.massive_api_key).strip()
        self._base_url = (base_url or settings.massive_base_url).rstrip("/")
        self._timeout = settings.provider_timeout_seconds
        self._max_retries = settings.provider_max_retries
        self._client: httpx.AsyncClient | None = None
        self._client_lock = asyncio.Lock()

    async def is_configured(self) -> bool:
        return bool(self._api_key)

    async def _get_client(self) -> httpx.AsyncClient:
        async with self._client_lock:
            if self._client is None or self._client.is_closed:
                self._client = httpx.AsyncClient(
                    base_url=self._base_url,
                    timeout=httpx.Timeout(self._timeout),
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Accept": "application/json",
                        "User-Agent": "MarketReplayLab/0.1",
                    },
                )
            return self._client

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def get_symbols(self) -> list[Instrument]:
        if not self._api_key:
            raise ProviderNotConfiguredError("MASSIVE_API_KEY is not set", provider=self.name)
        instruments = list_instruments()
        for instrument in instruments:
            instrument.contract_note = (
                "Massive continuous front-contract series. "
                "Roll handling follows the provider's own methodology."
            )
        return instruments

    async def get_bars(
        self,
        symbol: str,
        interval: str,
        start_time: datetime,
        end_time: datetime,
    ) -> list[Candle]:
        if not self._api_key:
            raise ProviderNotConfiguredError("MASSIVE_API_KEY is not set", provider=self.name)

        instrument = get_instrument(symbol)
        if interval not in self.native_intervals:
            raise ProviderDataError(
                f"Massive cannot serve '{interval}' natively", provider=self.name
            )

        params = {
            "symbol": MASSIVE_SYMBOL_MAP[instrument.symbol],
            "resolution": MASSIVE_INTERVAL_MAP[interval],
            "from": to_ms(start_time),
            "to": to_ms(end_time),
        }
        payload = await self._request("/futures/ohlcv", params)
        rows = self._unwrap(payload)
        candles = normalize_candles(instrument.symbol, rows)
        if not candles:
            raise ProviderDataError(
                f"Massive returned no bars for {params['symbol']} {interval}",
                provider=self.name,
            )
        return candles

    # ------------------------------------------------------------------
    async def _request(self, path: str, params: dict[str, Any]) -> Any:
        """GET with exponential backoff on transient failures."""

        client = await self._get_client()
        delay = 0.5
        last_error: Exception | None = None

        for attempt in range(1, self._max_retries + 1):
            try:
                response = await client.get(path, params=params)
            except httpx.TimeoutException:
                last_error = ProviderUnavailableError(
                    f"Massive request timed out after {self._timeout}s", provider=self.name
                )
            except httpx.HTTPError as exc:
                last_error = ProviderUnavailableError(
                    f"Massive network error: {exc}", provider=self.name
                )
            else:
                if response.status_code in (401, 403):
                    raise ProviderAuthError(
                        f"Massive rejected the API key (HTTP {response.status_code})",
                        provider=self.name,
                    )
                if response.status_code == 429:
                    last_error = ProviderRateLimitError(
                        "Massive rate limit exceeded (HTTP 429)", provider=self.name
                    )
                    delay = self._retry_after(response, delay)
                elif response.status_code >= 500:
                    last_error = ProviderUnavailableError(
                        f"Massive server error (HTTP {response.status_code})", provider=self.name
                    )
                elif response.status_code >= 400:
                    raise ProviderDataError(
                        f"Massive rejected the request (HTTP {response.status_code})",
                        provider=self.name,
                    )
                else:
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise ProviderDataError(
                            "Massive returned a non-JSON response", provider=self.name
                        ) from exc

            if attempt < self._max_retries:
                logger.warning(
                    "Massive attempt %s/%s failed (%s); retrying in %.1fs",
                    attempt,
                    self._max_retries,
                    last_error,
                    delay,
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, 8.0)

        assert last_error is not None
        raise last_error

    @staticmethod
    def _retry_after(response: httpx.Response, fallback: float) -> float:
        header = response.headers.get("Retry-After")
        if header:
            try:
                return min(max(float(header), 0.5), 30.0)
            except ValueError:
                pass
        return min(fallback * 2, 30.0)

    @staticmethod
    def _unwrap(payload: Any) -> list[Any]:
        """Pull the bar array out of whichever envelope the vendor used."""

        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in _ENVELOPE_KEYS:
                value = payload.get(key)
                if isinstance(value, list):
                    return value
            # Column-oriented ("t"/"o"/"h"/"l"/"c"/"v") responses.
            if all(key in payload for key in ("t", "o", "h", "l", "c")):
                times = payload["t"]
                volumes = payload.get("v") or [0] * len(times)
                return [
                    {
                        "time": times[index],
                        "open": payload["o"][index],
                        "high": payload["h"][index],
                        "low": payload["l"][index],
                        "close": payload["c"][index],
                        "volume": volumes[index],
                    }
                    for index in range(len(times))
                ]
        raise ProviderDataError("Massive response shape was not recognised", provider="massive")
