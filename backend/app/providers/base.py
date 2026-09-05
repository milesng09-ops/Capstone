"""Market-data provider abstraction.

Adding a new vendor means implementing :class:`MarketDataProvider` and
registering it in :mod:`app.providers.fallback_provider`.  No other part of the
application needs to change.
"""

from __future__ import annotations

import abc
from datetime import datetime

from app.models.domain import Candle, Instrument


class ProviderError(RuntimeError):
    """Base class for every recoverable provider failure."""

    #: Whether the failure is expected to persist (missing credentials, plan
    #: restrictions).  Permanent failures get a longer health cool-off.
    permanent = False

    def __init__(self, message: str, provider: str = "") -> None:
        super().__init__(message)
        self.provider = provider


class ProviderNotConfiguredError(ProviderError):
    """Credentials or dependencies are missing."""

    permanent = True


class ProviderAuthError(ProviderError):
    """The provider rejected our credentials."""

    permanent = True


class ProviderRateLimitError(ProviderError):
    """HTTP 429 or an equivalent quota rejection.

    Carries the provider's own ``Retry-After`` when it sent one, so the UI can
    count down to a real reopening time instead of guessing.
    """

    def __init__(
        self,
        message: str,
        provider: str = "",
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message, provider)
        self.retry_after_seconds = retry_after_seconds


class ProviderThrottledError(ProviderRateLimitError):
    """We declined to send the call: our own budget for the provider is spent.

    A subclass of :class:`ProviderRateLimitError` because it means the same
    thing to everyone above -- too many requests, wait this long -- while
    staying distinguishable here, where it matters: the provider did not
    reject anything and must not be marked unhealthy for it.
    """


class ProviderUnavailableError(ProviderError):
    """Network failure, timeout or 5xx response."""


class ProviderDataError(ProviderError):
    """The provider responded but the payload was unusable or empty."""


class MarketDataProvider(abc.ABC):
    """Interface every data source implements."""

    #: Short machine name, surfaced through the API.
    name: str = "base"
    #: Human readable name for the UI.
    display_name: str = "Base provider"
    #: Intervals the provider serves without backend aggregation.
    native_intervals: set[str] = set()
    #: Data freshness this provider can offer.
    quality: str = "delayed"

    @abc.abstractmethod
    async def get_symbols(self) -> list[Instrument]:
        """Return the instruments this provider can serve."""

    @abc.abstractmethod
    async def get_bars(
        self,
        symbol: str,
        interval: str,
        start_time: datetime,
        end_time: datetime,
    ) -> list[Candle]:
        """Return normalised candles for ``[start_time, end_time]``."""

    async def is_configured(self) -> bool:
        """Whether the provider has everything it needs to run."""

        return True

    async def close(self) -> None:
        """Release network resources."""

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"<{type(self).__name__} name={self.name!r}>"
