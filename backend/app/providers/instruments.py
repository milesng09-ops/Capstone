"""Canonical instrument catalogue.

The application only ever refers to ``ES``, ``NQ`` and ``YM``.  Vendor tickers
live inside the individual provider modules so that a provider swap never
leaks into charting or backtesting code.
"""

from __future__ import annotations

from app.models.domain import Instrument

CANONICAL_INSTRUMENTS: dict[str, Instrument] = {
    "ES": Instrument(
        symbol="ES",
        display_name="E-mini S&P 500 Futures",
        exchange="CME",
        currency="USD",
        asset_type="future",
        timezone="America/Chicago",
        price_precision=2,
        tick_size=0.25,
    ),
    "NQ": Instrument(
        symbol="NQ",
        display_name="E-mini Nasdaq-100 Futures",
        exchange="CME",
        currency="USD",
        asset_type="future",
        timezone="America/Chicago",
        price_precision=2,
        tick_size=0.25,
    ),
    "YM": Instrument(
        symbol="YM",
        display_name="E-mini Dow Jones Futures",
        exchange="CBOT",
        currency="USD",
        asset_type="future",
        timezone="America/Chicago",
        price_precision=0,
        tick_size=1.0,
    ),
}

SUPPORTED_SYMBOLS: list[str] = list(CANONICAL_INSTRUMENTS)


class UnknownSymbolError(ValueError):
    """Raised for a symbol outside the canonical catalogue."""


def get_instrument(symbol: str) -> Instrument:
    key = symbol.upper().strip()
    instrument = CANONICAL_INSTRUMENTS.get(key)
    if instrument is None:
        raise UnknownSymbolError(
            f"Unknown symbol '{symbol}'. Supported: {', '.join(SUPPORTED_SYMBOLS)}"
        )
    return instrument


def list_instruments() -> list[Instrument]:
    return [instrument.model_copy() for instrument in CANONICAL_INSTRUMENTS.values()]
