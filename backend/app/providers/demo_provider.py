"""Bundled demo-data provider.

This provider is the guaranteed floor of the fallback chain: it has no network
dependency and no credentials, so the product is always fully usable.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime
from pathlib import Path

from app.config import get_settings
from app.models.domain import Candle, Instrument
from app.providers.base import MarketDataProvider, ProviderDataError
from app.providers.instruments import get_instrument, list_instruments
from app.services.demo_data import DEMO_LABEL, load_demo_dataset
from app.utils.timeutils import to_ms

logger = logging.getLogger(__name__)


class DemoProvider(MarketDataProvider):
    name = "demo"
    display_name = "Demo Data"
    native_intervals = {"5m"}
    quality = "demo"

    def __init__(self, demo_dir: Path | None = None) -> None:
        self._demo_dir = demo_dir or get_settings().demo_dir
        self._cache: dict[str, list[Candle]] = {}
        self._lock = threading.Lock()

    async def is_configured(self) -> bool:
        return True

    async def get_symbols(self) -> list[Instrument]:
        instruments = list_instruments()
        for instrument in instruments:
            instrument.contract_note = (
                f"{DEMO_LABEL} Synthetic continuous series generated from a fixed seed."
            )
        return instruments

    def _dataset(self, symbol: str) -> list[Candle]:
        """Load once per process; the dataset is immutable."""

        with self._lock:
            cached = self._cache.get(symbol)
            if cached is None:
                cached = load_demo_dataset(self._demo_dir, symbol)
                if not cached:
                    raise ProviderDataError(
                        f"Demo dataset for {symbol} is empty", provider=self.name
                    )
                self._cache[symbol] = cached
                logger.info("Loaded %s demo bars for %s", len(cached), symbol)
            return cached

    async def get_bars(
        self,
        symbol: str,
        interval: str,
        start_time: datetime,
        end_time: datetime,
    ) -> list[Candle]:
        instrument = get_instrument(symbol)
        if interval not in self.native_intervals:
            # The candle service aggregates; a direct call is a programming error.
            raise ProviderDataError(
                f"Demo provider serves {sorted(self.native_intervals)} only", provider=self.name
            )

        candles = self._dataset(instrument.symbol)
        start_ms = to_ms(start_time)
        end_ms = to_ms(end_time)
        return [candle for candle in candles if start_ms <= candle.time <= end_ms]

    def available_range(self, symbol: str) -> tuple[int, int] | None:
        try:
            candles = self._dataset(symbol)
        except ProviderDataError:  # pragma: no cover - defensive
            return None
        if not candles:
            return None
        return candles[0].time, candles[-1].time
