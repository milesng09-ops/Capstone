"""Yahoo Finance provider (server side only).

``yfinance`` is a blocking, synchronous library, so every call is pushed onto a
worker thread.  Yahoo's own history limits are enforced here rather than being
discovered as errors:

* ``5m`` / ``15m`` -- roughly the last 60 days, max 60 days per request
* ``1h``           -- roughly the last 730 days, max 730 days per request
* ``1d``           -- effectively unlimited

Yahoo continuous futures (``ES=F``) are front-contract series that are **not**
back-adjusted for rolls.  That is surfaced to the user as a data limitation
rather than hidden.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import anyio

from app.models.domain import Candle, Instrument
from app.providers.base import (
    MarketDataProvider,
    ProviderDataError,
    ProviderNotConfiguredError,
    ProviderRateLimitError,
    ProviderUnavailableError,
)
from app.providers.instruments import get_instrument, list_instruments
from app.services.normalization import normalize_candles

logger = logging.getLogger(__name__)

#: Canonical symbol -> Yahoo ticker.  The only place Yahoo tickers appear.
YAHOO_SYMBOL_MAP: dict[str, str] = {
    "ES": "ES=F",
    "NQ": "NQ=F",
    "YM": "YM=F",
}

YAHOO_INTERVAL_MAP: dict[str, str] = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "1d": "1d",
}

#: Maximum days of history Yahoo will return per interval.
MAX_HISTORY_DAYS: dict[str, int] = {"5m": 58, "15m": 58, "1h": 720, "1d": 20_000}
#: Maximum days per individual request (chunking window).
MAX_REQUEST_DAYS: dict[str, int] = {"5m": 55, "15m": 55, "1h": 700, "1d": 5_000}


class YahooProvider(MarketDataProvider):
    name = "yahoo"
    display_name = "Yahoo Finance"
    native_intervals = set(YAHOO_INTERVAL_MAP)
    quality = "delayed"

    def __init__(self) -> None:
        self._yfinance: Any | None = None
        self._import_error: str | None = None

    def _load_yfinance(self) -> Any:
        if self._yfinance is not None:
            return self._yfinance
        try:
            import yfinance  # type: ignore[import-untyped]
        except Exception as exc:  # pragma: no cover - depends on environment
            self._import_error = f"yfinance is not installed ({exc})"
            raise ProviderNotConfiguredError(self._import_error, provider=self.name) from exc
        self._yfinance = yfinance
        return yfinance

    async def is_configured(self) -> bool:
        try:
            await anyio.to_thread.run_sync(self._load_yfinance)
            return True
        except ProviderNotConfiguredError:
            return False

    async def get_symbols(self) -> list[Instrument]:
        instruments = list_instruments()
        for instrument in instruments:
            instrument.contract_note = (
                "Yahoo Finance continuous front-contract series (indicative). "
                "Not roll-adjusted; volume may be incomplete."
            )
        return instruments

    async def get_bars(
        self,
        symbol: str,
        interval: str,
        start_time: datetime,
        end_time: datetime,
    ) -> list[Candle]:
        instrument = get_instrument(symbol)
        if interval not in self.native_intervals:
            raise ProviderDataError(
                f"Yahoo cannot serve '{interval}' natively", provider=self.name
            )

        ticker = YAHOO_SYMBOL_MAP[instrument.symbol]
        start, end = self._clamp_window(interval, start_time, end_time)
        if start >= end:
            return []

        raw_rows: list[dict] = []
        for chunk_start, chunk_end in self._chunk_window(interval, start, end):
            rows = await anyio.to_thread.run_sync(
                self._fetch_chunk, ticker, interval, chunk_start, chunk_end
            )
            raw_rows.extend(rows)

        candles = normalize_candles(instrument.symbol, raw_rows)
        if not candles:
            raise ProviderDataError(
                f"Yahoo returned no bars for {ticker} {interval}", provider=self.name
            )
        return candles

    # ------------------------------------------------------------------
    def _clamp_window(
        self, interval: str, start_time: datetime, end_time: datetime
    ) -> tuple[datetime, datetime]:
        """Trim the request to what Yahoo is actually able to serve."""

        now = datetime.now(tz=timezone.utc)
        end = min(end_time, now)
        earliest = now - timedelta(days=MAX_HISTORY_DAYS[interval])
        start = max(start_time, earliest)
        if start > start_time:
            logger.debug(
                "Yahoo %s history clamped to %s (requested %s)", interval, start, start_time
            )
        return start, end

    def _chunk_window(
        self, interval: str, start: datetime, end: datetime
    ) -> list[tuple[datetime, datetime]]:
        span = timedelta(days=MAX_REQUEST_DAYS[interval])
        chunks: list[tuple[datetime, datetime]] = []
        cursor = start
        while cursor < end:
            chunk_end = min(cursor + span, end)
            chunks.append((cursor, chunk_end))
            cursor = chunk_end
        return chunks

    def _fetch_chunk(
        self, ticker: str, interval: str, start: datetime, end: datetime
    ) -> list[dict]:
        yfinance = self._load_yfinance()
        try:
            handle = yfinance.Ticker(ticker)
            frame = handle.history(
                start=start,
                end=end,
                interval=YAHOO_INTERVAL_MAP[interval],
                auto_adjust=False,
                prepost=False,
                actions=False,
                raise_errors=True,
            )
        except Exception as exc:  # noqa: BLE001 - normalised below
            message = str(exc)
            lowered = message.lower()
            if "429" in message or "too many requests" in lowered or "rate limit" in lowered:
                raise ProviderRateLimitError(
                    f"Yahoo rate limit hit: {message}", provider=self.name
                ) from exc
            if "timed out" in lowered or "timeout" in lowered:
                raise ProviderUnavailableError(
                    f"Yahoo request timed out: {message}", provider=self.name
                ) from exc
            raise ProviderUnavailableError(
                f"Yahoo request failed: {message}", provider=self.name
            ) from exc

        if frame is None or frame.empty:
            return []

        rows: list[dict] = []
        for index, row in frame.iterrows():
            timestamp = index.to_pydatetime()
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            rows.append(
                {
                    "time": int(timestamp.timestamp() * 1000),
                    "open": row.get("Open"),
                    "high": row.get("High"),
                    "low": row.get("Low"),
                    "close": row.get("Close"),
                    "volume": row.get("Volume"),
                }
            )
        return rows
