"""The Yahoo provider's reading of an empty answer.

With ``raise_errors=True``, yfinance reports a window it has no bars for as a
failure -- "possibly delisted; no price data found" -- and that is also exactly
what a request over a closed market looks like.  Telling the two apart is the
whole job of the branch these tests cover: over a window with no trading in it,
nothing is the correct answer and the chunk is simply empty; over a window the
market was open for, an empty answer is the provider failing and has to say so.

The branch had been calling a function that no longer existed, so instead of
either verdict it raised ``NameError``.  The chain catches everything, so the
weekend gap every back-fill asks for came back as "All providers failed" and
the range was left uncovered -- which is what put "Incomplete data" on a chart
whose data was fine.  Nothing covered this file, which is how a name that is
not defined survived a green suite.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.providers.base import ProviderUnavailableError
from app.providers.yahoo_provider import YahooProvider

CHICAGO = ZoneInfo("America/Chicago")

#: What yfinance raises for a window it holds no bars for.
NO_DATA = "NQ=F: possibly delisted; no price data found (period=1d)"

#: A Saturday: the market is shut for the whole window, so an empty answer
#: says nothing about the provider.
CLOSED = (
    datetime(2026, 9, 5, 0, tzinfo=CHICAGO),
    datetime(2026, 9, 5, 9, tzinfo=CHICAGO),
)

#: A Wednesday session: six open hours, so an empty answer is an outage.
OPEN = (
    datetime(2026, 9, 2, 9, tzinfo=CHICAGO),
    datetime(2026, 9, 2, 15, tzinfo=CHICAGO),
)


class _Ticker:
    def __init__(self, message: str) -> None:
        self._message = message

    def history(self, **_kwargs: object) -> object:
        raise RuntimeError(self._message)


class _Yfinance:
    """Enough of the module surface for ``_fetch_chunk`` to reach its handler."""

    def __init__(self, message: str) -> None:
        self._message = message

    def Ticker(self, _ticker: str) -> _Ticker:  # noqa: N802 - mirrors yfinance
        return _Ticker(self._message)


def provider_raising(message: str) -> YahooProvider:
    provider = YahooProvider()
    # Bypass the import: the test is about how the answer is read, not about
    # whether the package is installed in the test environment.
    provider._yfinance = _Yfinance(message)
    return provider


class TestAnEmptyChunk:
    def test_a_closed_window_is_not_an_outage(self):
        """The regression: this raised ``NameError`` instead of returning."""
        start, end = CLOSED
        provider = provider_raising(NO_DATA)

        assert provider._fetch_chunk("NQ=F", "15m", start, end, "America/Chicago") == []

    def test_an_open_window_still_fails_loudly(self):
        # The concession is only for windows with no market in them. Six open
        # hours with nothing in them is the provider being broken, and a silent
        # empty list there would leave a hole in the chart with no explanation.
        start, end = OPEN
        provider = provider_raising(NO_DATA)

        with pytest.raises(ProviderUnavailableError):
            provider._fetch_chunk("NQ=F", "15m", start, end, "America/Chicago")

    def test_an_unrelated_failure_is_never_excused(self):
        # Only the "no price data" wording is a candidate for being excused.
        # Anything else is a real error even over a shut market.
        start, end = CLOSED
        provider = provider_raising("Connection reset by peer")

        with pytest.raises(ProviderUnavailableError):
            provider._fetch_chunk("NQ=F", "15m", start, end, "America/Chicago")
