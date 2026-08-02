"""Core domain models shared by providers, services and the API layer."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

AssetType = Literal["future"]
DataQuality = Literal["live", "delayed", "cached", "demo"]


class Instrument(BaseModel):
    """Normalised instrument description.

    Providers must map their own vendor symbols onto this model so that the
    rest of the application never sees vendor-specific tickers.
    """

    symbol: str
    display_name: str
    exchange: str = "CME"
    currency: str = "USD"
    asset_type: AssetType = "future"
    timezone: str = "America/Chicago"
    price_precision: int = 2
    tick_size: float = 0.25
    #: Human readable note about how the series is constructed.
    contract_note: str = (
        "Indicative continuous front-contract series. Not roll-adjusted."
    )


class Candle(BaseModel):
    """One normalised OHLCV bar.

    ``time`` is the **open** time of the bar in Unix milliseconds (UTC).
    """

    symbol: str
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    def as_tuple(self) -> tuple[int, float, float, float, float, float]:
        return (self.time, self.open, self.high, self.low, self.close, self.volume)


class ProviderStatus(BaseModel):
    """Health snapshot for a single provider."""

    name: str
    display_name: str
    configured: bool
    available: bool
    healthy: bool
    last_error: str | None = None
    last_checked_ms: int | None = None
    cooldown_until_ms: int | None = None
    notes: str | None = None


class BarsResult(BaseModel):
    """Return value of the candle service."""

    symbol: str
    interval: str
    provider: str
    cached: bool
    fallback_active: bool
    fallback_reason: str | None = None
    quality: DataQuality = "cached"
    bars: list[Candle] = Field(default_factory=list)


class ProviderFetchResult(BaseModel):
    """What a provider hands back to the candle service."""

    provider: str
    #: Interval the returned bars are actually in. May be finer than the
    #: requested interval when the caller has to aggregate.
    interval: str
    bars: list[Candle]
    quality: DataQuality = "delayed"
    fallback_reason: str | None = None
