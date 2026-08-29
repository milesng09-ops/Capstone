"""Massive market-data provider.

Massive serves individual futures contracts (``ESU6`` is the September 2026
E-mini S&P), not the continuous series the rest of the application speaks in.
This module bridges the two: a request for ``ES`` is split into front-month
segments by :mod:`app.providers.futures_calendar`, each segment is fetched from
the contract that was front month at the time, and the pieces are stitched back
into one ascending series.

The stitched series is not back-adjusted, so prices step at each quarterly
roll.  See the calendar module for why.

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
from app.providers.futures_calendar import ContractMonth, contract_segments
from app.providers.instruments import get_instrument, list_instruments
from app.services.normalization import clip_to_range, normalize_candles
from app.utils.timeutils import to_ms

logger = logging.getLogger(__name__)

#: Canonical symbol -> Massive product code.  The delivery month is appended
#: per segment; see :func:`contract_ticker`.
MASSIVE_PRODUCT_MAP: dict[str, str] = {
    "ES": "ES",
    "NQ": "NQ",
    "YM": "YM",
}

#: Canonical interval -> Massive resolution string.  Massive wants a count and
#: a unit separated by a space; ``1h`` is rejected outright.  Only the four
#: intervals the cache actually stores are listed, so 4h and 6h are aggregated
#: from 1h by the existing chain rather than requested here.
MASSIVE_INTERVAL_MAP: dict[str, str] = {
    "5m": "5 min",
    "15m": "15 min",
    "1h": "1 hour",
    "1d": "1 day",
}

#: Nanoseconds per millisecond.  Massive timestamps every bar in nanoseconds.
NS_PER_MS = 1_000_000

#: Rows per page.  The documented maximum, chosen to keep the request count --
#: and therefore rate-limit pressure -- as low as possible.
PAGE_LIMIT = 50_000

#: Safety valve on cursor following, far above any real window.
MAX_PAGES = 40


def contract_ticker(product: str, contract: ContractMonth) -> str:
    """Massive contract ticker, e.g. ``("ES", 2026-09)`` -> ``ESU6``.

    Massive abbreviates the year to its final digit, which is unambiguous over
    any window shorter than a decade.
    """

    return f"{product}{contract.month_code}{contract.year % 10}"


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
                "Front-month series stitched from Massive's individual contracts, "
                "rolling on the second Thursday of each quarterly delivery month. "
                "Prices are not back-adjusted, so the series steps at every roll."
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

        product = MASSIVE_PRODUCT_MAP[instrument.symbol]
        resolution = MASSIVE_INTERVAL_MAP[interval]
        start_ms = to_ms(start_time)
        end_ms = to_ms(end_time)

        rows: list[dict[str, Any]] = []
        for segment in contract_segments(start_ms, end_ms, tz_name=instrument.timezone):
            ticker = contract_ticker(product, segment.contract)
            rows.extend(
                await self._fetch_contract(
                    ticker, resolution, segment.start_ms, segment.end_ms
                )
            )

        candles = normalize_candles(instrument.symbol, rows)
        candles = clip_to_range(candles, start_ms, end_ms)
        if not candles:
            raise ProviderDataError(
                f"Massive returned no bars for {product} {interval}",
                provider=self.name,
            )
        return candles

    # ------------------------------------------------------------------
    async def _fetch_contract(
        self,
        ticker: str,
        resolution: str,
        start_ms: int,
        end_ms: int,
    ) -> list[dict[str, Any]]:
        """Every bar one contract has in ``[start_ms, end_ms]``, following pages.

        Bounds go out in nanoseconds rather than as dates so segments cut at a
        roll cannot overlap and claim each other's bars.
        """

        params: dict[str, Any] = {
            "resolution": resolution,
            "window_start.gte": start_ms * NS_PER_MS,
            "window_start.lte": end_ms * NS_PER_MS,
            "limit": PAGE_LIMIT,
        }

        rows: list[dict[str, Any]] = []
        path: str | None = f"/futures/v1/aggs/{ticker}"
        pages = 0

        while path is not None and pages < MAX_PAGES:
            payload = await self._request(path, params if pages == 0 else None)
            rows.extend(self._to_rows(payload))
            pages += 1
            next_url = payload.get("next_url") if isinstance(payload, dict) else None
            path = next_url if isinstance(next_url, str) and next_url else None

        if path is not None:
            logger.warning(
                "Massive paging stopped at %s pages for %s; window may be incomplete",
                MAX_PAGES,
                ticker,
            )
        return rows

    @staticmethod
    def _to_rows(payload: Any) -> list[dict[str, Any]]:
        """Convert a Massive page into records :func:`normalize_candles` reads.

        Timestamps arrive as nanoseconds, which normalisation would otherwise
        read as milliseconds and place tens of thousands of years from now.
        """

        if isinstance(payload, dict):
            results = payload.get("results")
        elif isinstance(payload, list):
            results = payload
        else:
            results = None

        if results is None:
            raise ProviderDataError(
                "Massive response shape was not recognised", provider="massive"
            )
        if not isinstance(results, list):
            raise ProviderDataError(
                "Massive returned a non-list result set", provider="massive"
            )

        rows: list[dict[str, Any]] = []
        for row in results:
            if not isinstance(row, dict):
                continue
            window_start = row.get("window_start")
            if window_start is None:
                continue
            try:
                timestamp_ms = int(window_start) // NS_PER_MS
            except (TypeError, ValueError):
                continue
            rows.append(
                {
                    "time": timestamp_ms,
                    "open": row.get("open"),
                    "high": row.get("high"),
                    "low": row.get("low"),
                    "close": row.get("close"),
                    "volume": row.get("volume"),
                }
            )
        return rows

    async def _request(self, path: str, params: dict[str, Any] | None) -> Any:
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
